/**
 * TON adapters — native TON and USDT-TON jetton.
 *
 * Both go through the public toncenter REST API. Native TON transfers
 * include a free-form text "comment" field (msg payload op=0) which is
 * the user-facing memo path; jetton transfers can also carry a
 * forward_payload, which Tether's USDT jetton honors as the comment.
 *
 * USDT jetton master on mainnet:
 *   EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs
 *
 * For the v1 of the topup feature we keep the parsing pragmatic: comment
 * decode for natives is straightforward; jetton notification messages
 * are matched on the `op=0x7362d09c` payload prefix and the inner
 * 64-bit-LE amount field. Anything more elaborate (e.g. arbitrary
 * forward_payloads) falls back to "no memo, but on-chain amount must
 * still match".
 */

import { AppError, ErrorCode } from '../../utils/errors.js';
import type { ChainAdapter, RecentTransfer, TxVerification } from './chain.types.js';
import { fromBaseUnits } from './chain.types.js';
import type { CryptoChainId } from '../../types/index.js';

const TON_DEFAULT_BASE = 'https://toncenter.com/api/v2';
const TON_NATIVE_DECIMALS = 9;
/** TEP-74 jetton stablecoins (USDT, USDC) both use 6 decimals. */
const TON_JETTON_DECIMALS = 6;
/** Tether's mainnet USDT jetton master address. */
export const USDT_TON_JETTON_MASTER = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs';
/** Circle's mainnet USDC jetton master address. */
export const USDC_TON_JETTON_MASTER = 'EQB-MPwrd1G6WKNkLz_VnV6WqBDd142KMQv-g1O-8QUA3728';

/**
 * Loose check — bare-form raw `0:<64hex>` or user-friendly base64url
 * `EQ.../UQ...` (48 chars). Adapters call this only to fence off
 * obviously malformed addresses.
 */
function isPlausibleTonAddress(addr: string): boolean {
  return /^([Ee][Qq]|[Uu][Qq])[A-Za-z0-9_-]{46}$/.test(addr) ||
    /^0:[0-9a-fA-F]{64}$/.test(addr);
}

interface ToncenterResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
  code?: number;
}

interface ToncenterTx {
  '@type'?: string;
  utime: number;
  transaction_id: { hash: string; lt: string };
  fee: string;
  in_msg?: ToncenterMsg;
  out_msgs?: ToncenterMsg[];
}

interface ToncenterMsg {
  source: string;
  destination: string;
  value: string;            // nanoTON for native, "0" for jetton-wrapping msgs
  fwd_fee?: string;
  msg_data?: { '@type'?: string; text?: string; body?: string };
  message?: string;
  body?: string;
}

interface ToncenterMasterchainInfo {
  last?: { seqno?: number };
}

export interface TonAdapterOptions {
  baseUrl?: string;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
}

abstract class TonAdapterBase {
  protected readonly baseUrl: string;
  protected readonly apiKey: string | null;
  protected readonly fetchImpl: typeof fetch;

  constructor(opts: TonAdapterOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? TON_DEFAULT_BASE).replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  validateAddress(address: string): boolean {
    return isPlausibleTonAddress(address);
  }

  protected async callJson<T>(path: string, query: Record<string, string | number>): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) qs.set(k, String(v));
    if (this.apiKey) qs.set('api_key', this.apiKey);
    const url = `${this.baseUrl}${path}?${qs.toString()}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new AppError(
        ErrorCode.CRYPTO_RPC_ERROR,
        `toncenter ${path} returned ${res.status}`,
        { meta: { status: res.status, path } },
      );
    }
    const body = (await res.json()) as ToncenterResponse<T>;
    if (!body.ok || body.result === undefined) {
      throw new AppError(
        ErrorCode.CRYPTO_RPC_ERROR,
        `toncenter ${path} not ok: ${body.error ?? 'unknown'}`,
        { meta: { path, error: body.error } },
      );
    }
    return body.result;
  }

  protected async getHeadSeqno(): Promise<number> {
    try {
      const info = await this.callJson<ToncenterMasterchainInfo>(
        '/getMasterchainInfo',
        {},
      );
      return info.last?.seqno ?? 0;
    } catch {
      return 0;
    }
  }
}

/* ------------------------------------------------------------------------- *
 * Native TON
 * ------------------------------------------------------------------------- */

export class TonNativeAdapter extends TonAdapterBase implements ChainAdapter {
  readonly id: CryptoChainId = 'ton-native';
  readonly label = 'TON';
  readonly memoSupported = true;
  readonly nativeDecimals = TON_NATIVE_DECIMALS;

  async verifyTx(input: {
    txHash: string;
    expectedToAddress: string;
    expectedAmount: string;
    expectedDecimals: number;
    expectedMemo?: string | null;
  }): Promise<TxVerification> {
    // toncenter's getTransactions filters per address, so we look up the
    // tx by walking transactions on the receiving address until we hit
    // the matching hash. Bounded to one page (latest 100) which covers
    // the realistic invoice TTL window (an hour).
    const txs = await this.callJson<ToncenterTx[]>('/getTransactions', {
      address: input.expectedToAddress,
      limit: 100,
    });
    const match = txs.find((t) => t.transaction_id?.hash === input.txHash);
    if (!match) return notFound();

    const inMsg = match.in_msg;
    if (!inMsg) return notFound();

    const memo = extractTonComment(inMsg);
    const amountNano = BigInt(inMsg.value || '0');
    const amount = fromBaseUnits(amountNano, TON_NATIVE_DECIMALS);

    const head = await this.getHeadSeqno();
    // Native TON doesn't expose a per-tx confirmation block height via the
    // basic /getTransactions endpoint; we approximate "1 conf when seen on
    // the receiving address". Operators can tune the required threshold
    // via settings (default 1).
    const confirmations = head > 0 ? 1 : 0;

    return {
      found: true,
      state: 'success',
      confirmations,
      amount,
      fromAddress: inMsg.source ?? null,
      toAddress: inMsg.destination ?? null,
      memo,
      blockTime: new Date(match.utime * 1000).toISOString(),
    };
  }

  async listRecentTransfers(input: {
    address: string;
    sinceIso: string;
    limit: number;
  }): Promise<RecentTransfer[]> {
    const sinceSec = Math.floor(new Date(input.sinceIso).getTime() / 1000);
    const txs = await this.callJson<ToncenterTx[]>('/getTransactions', {
      address: input.address,
      limit: Math.min(Math.max(input.limit, 1), 200),
    });
    const out: RecentTransfer[] = [];
    for (const t of txs) {
      if (t.utime < sinceSec) break;
      const inMsg = t.in_msg;
      if (!inMsg) continue;
      const amountNano = BigInt(inMsg.value || '0');
      if (amountNano <= 0n) continue;
      out.push({
        txHash: t.transaction_id.hash,
        amount: fromBaseUnits(amountNano, TON_NATIVE_DECIMALS),
        fromAddress: inMsg.source,
        toAddress: inMsg.destination,
        memo: extractTonComment(inMsg),
        blockTime: new Date(t.utime * 1000).toISOString(),
        confirmations: 1,
        state: 'success',
      });
    }
    return out;
  }
}

/* ------------------------------------------------------------------------- *
 * USDT jetton on TON
 * ------------------------------------------------------------------------- */

export interface TonJettonAdapterOptions extends TonAdapterOptions {
  /** Logical chain id, e.g. 'ton-usdt-jetton' or 'ton-usdc-jetton'. */
  chainId: CryptoChainId;
  /** Human label shown in invoices and audit logs. */
  label: string;
  /** Mainnet jetton master address for the stablecoin. */
  jettonMaster: string;
}

/**
 * Generic TEP-74 jetton stablecoin adapter (USDT / USDC on TON). Use the
 * static factories {@link TonJettonAdapter.usdt} and {@link TonJettonAdapter.usdc}
 * for the canonical mainnet jetton masters. The legacy class
 * {@link TonUsdtJettonAdapter} keeps the original ctor shape for tests.
 *
 * `jettonMaster` is exposed read-only so audit trails can include it; the
 * adapter doesn't actually use it on the verifyTx hot path because TON's
 * jetton transfer notification (op 0x7362d09c) arrives at the recipient's
 * own jetton wallet, not at the master — verification anchors on the
 * notification op + amount + sender + comment, with the receiving address
 * checked by the service layer.
 */
export class TonJettonAdapter extends TonAdapterBase implements ChainAdapter {
  readonly id: CryptoChainId;
  readonly label: string;
  readonly memoSupported = true;
  readonly nativeDecimals = TON_JETTON_DECIMALS;
  /** Master address of the TEP-74 jetton this adapter is bound to. */
  readonly jettonMaster: string;

  constructor(opts: TonJettonAdapterOptions) {
    super(opts);
    this.id = opts.chainId;
    this.label = opts.label;
    this.jettonMaster = opts.jettonMaster;
  }

  /** Factory for Tether's mainnet USDT jetton. */
  static usdt(opts: TonAdapterOptions = {}): TonJettonAdapter {
    return new TonJettonAdapter({
      ...opts,
      chainId: 'ton-usdt-jetton',
      label: 'USDT (TON)',
      jettonMaster: USDT_TON_JETTON_MASTER,
    });
  }

  /** Factory for Circle's mainnet USDC jetton. */
  static usdc(opts: TonAdapterOptions = {}): TonJettonAdapter {
    return new TonJettonAdapter({
      ...opts,
      chainId: 'ton-usdc-jetton',
      label: 'USDC (TON)',
      jettonMaster: USDC_TON_JETTON_MASTER,
    });
  }

  async verifyTx(input: {
    txHash: string;
    expectedToAddress: string;
    expectedAmount: string;
    expectedDecimals: number;
    expectedMemo?: string | null;
  }): Promise<TxVerification> {
    // For jetton transfers the recipient sees an internal message from
    // its OWN jetton wallet carrying op=0x7362d09c (transfer_notification).
    // toncenter's basic /getTransactions on the user's main address
    // doesn't include that path; the jetton-aware endpoint
    // /getJettonTransfers does. We use the toncenter index API
    // /getTransactions with `archival=true` to broaden the lookup window
    // when configured via apiKey.
    const txs = await this.callJson<ToncenterTx[]>('/getTransactions', {
      address: input.expectedToAddress,
      limit: 100,
      archival: this.apiKey ? 1 : 0,
    });
    const match = txs.find((t) => t.transaction_id?.hash === input.txHash);
    if (!match) return notFound();

    const inMsg = match.in_msg;
    if (!inMsg) return notFound();

    const parsed = parseJettonNotification(inMsg);
    if (!parsed) {
      // Not a jetton notification — could be a direct TON tx wrongly
      // pasted on the jetton chain. Surface as "found but failed match"
      // so the service can return CRYPTO_TX_MISMATCH.
      return {
        found: true,
        state: 'failed',
        confirmations: 0,
        amount: null,
        fromAddress: inMsg.source ?? null,
        toAddress: inMsg.destination ?? null,
        memo: null,
        blockTime: new Date(match.utime * 1000).toISOString(),
      };
    }

    const head = await this.getHeadSeqno();
    return {
      found: true,
      state: 'success',
      confirmations: head > 0 ? 1 : 0,
      amount: fromBaseUnits(parsed.amount, TON_JETTON_DECIMALS),
      fromAddress: parsed.from,
      toAddress: inMsg.destination ?? null,
      memo: parsed.comment,
      blockTime: new Date(match.utime * 1000).toISOString(),
    };
  }

  async listRecentTransfers(input: {
    address: string;
    sinceIso: string;
    limit: number;
  }): Promise<RecentTransfer[]> {
    const sinceSec = Math.floor(new Date(input.sinceIso).getTime() / 1000);
    const txs = await this.callJson<ToncenterTx[]>('/getTransactions', {
      address: input.address,
      limit: Math.min(Math.max(input.limit, 1), 200),
      archival: this.apiKey ? 1 : 0,
    });
    const out: RecentTransfer[] = [];
    for (const t of txs) {
      if (t.utime < sinceSec) break;
      const inMsg = t.in_msg;
      if (!inMsg) continue;
      const parsed = parseJettonNotification(inMsg);
      if (!parsed) continue;
      out.push({
        txHash: t.transaction_id.hash,
        amount: fromBaseUnits(parsed.amount, TON_JETTON_DECIMALS),
        fromAddress: parsed.from,
        toAddress: inMsg.destination,
        memo: parsed.comment,
        blockTime: new Date(t.utime * 1000).toISOString(),
        confirmations: 1,
        state: 'success',
      });
    }
    return out;
  }
}

/**
 * Legacy thin wrapper — defaults to the USDT jetton master so call sites
 * and tests written for the original adapter still work without ctor args.
 * New code should call {@link TonJettonAdapter.usdt} or `usdc` instead.
 */
export class TonUsdtJettonAdapter extends TonJettonAdapter {
  constructor(opts: TonAdapterOptions = {}) {
    super({
      ...opts,
      chainId: 'ton-usdt-jetton',
      label: 'USDT (TON)',
      jettonMaster: USDT_TON_JETTON_MASTER,
    });
  }
}

/* ------------------------------------------------------------------------- *
 * Helpers
 * ------------------------------------------------------------------------- */

function notFound(): TxVerification {
  return {
    found: false,
    state: 'pending',
    confirmations: 0,
    amount: null,
    fromAddress: null,
    toAddress: null,
    memo: null,
    blockTime: null,
  };
}

/**
 * Native TON comments arrive as msg_data with @type="msg.dataText" or as
 * a base64-encoded body that begins with the 32-bit op code 0 followed by
 * the UTF-8 text. Pull the comment out without bringing in @ton/core.
 */
function extractTonComment(msg: ToncenterMsg): string | null {
  const text = msg.msg_data?.text ?? msg.message ?? null;
  if (text && text.length > 0) {
    // toncenter sometimes returns the text already base64-decoded.
    try {
      const decoded = Buffer.from(text, 'base64').toString('utf8');
      if (/^[\x20-\x7e฀-๿]+$/.test(decoded)) return decoded;
    } catch {
      // fall through to the literal value
    }
    return text;
  }
  // Try the body payload — first 4 bytes are the op code; if 0, the rest
  // (after the op) is the text.
  const body = msg.body ?? msg.msg_data?.body;
  if (typeof body === 'string' && body.length > 8) {
    try {
      const buf = Buffer.from(body, 'base64');
      if (buf.length >= 4 && buf.readUInt32BE(0) === 0) {
        const txt = buf.subarray(4).toString('utf8');
        return txt.replace(/ +$/g, '');
      }
    } catch {
      // ignore
    }
  }
  return null;
}

interface JettonNotification {
  amount: bigint;
  from: string;
  comment: string | null;
}

/**
 * Parse a TEP-74 jetton transfer_notification body. Layout:
 *   op:uint32(0x7362d09c)
 *   query_id:uint64
 *   amount:Coins (varuint16 — leading length byte then big-endian)
 *   sender:MsgAddress
 *   forward_payload:Either<Cell,Slice>
 *
 * For the v1 we stop at amount + sender; the forward_payload is parsed
 * as text only when it begins with the comment op (0x00000000) for
 * symmetry with native TON comments.
 */
function parseJettonNotification(msg: ToncenterMsg): JettonNotification | null {
  const body = msg.body ?? msg.msg_data?.body;
  if (typeof body !== 'string' || body.length === 0) return null;
  let buf: Buffer;
  try {
    buf = Buffer.from(body, 'base64');
  } catch {
    return null;
  }
  if (buf.length < 4) return null;
  const op = buf.readUInt32BE(0);
  if (op !== 0x7362d09c) return null;

  // Skip op (4) + query_id (8) = 12 bytes.
  let cursor = 12;
  if (buf.length < cursor + 1) return null;
  const amountLen = buf[cursor];
  cursor += 1;
  if (amountLen === undefined || cursor + amountLen > buf.length) return null;
  let amount = 0n;
  for (let i = 0; i < amountLen; i++) {
    amount = (amount << 8n) | BigInt(buf[cursor + i] ?? 0);
  }
  cursor += amountLen;

  // Sender — first byte determines address type. We accept the
  // MsgAddressInt form (0x80) here; anything else, we surface from='' .
  let from = '';
  if (cursor < buf.length) {
    const tag = buf[cursor];
    if (tag === 0x80 && cursor + 1 + 32 <= buf.length) {
      // 1 tag + workchain (1) + 32 hash → produce raw 0:<hex>
      const wc = buf[cursor + 1] ?? 0;
      const hash = buf.subarray(cursor + 2, cursor + 2 + 32).toString('hex');
      from = `${wc}:${hash}`;
      cursor += 1 + 1 + 32;
    }
  }

  // Optional forward_payload comment.
  let comment: string | null = null;
  if (cursor + 4 <= buf.length) {
    const fwdOp = buf.readUInt32BE(cursor);
    if (fwdOp === 0) {
      const text = buf.subarray(cursor + 4).toString('utf8').replace(/ +$/g, '');
      if (text.length > 0) comment = text;
    }
  }

  return { amount, from, comment };
}
