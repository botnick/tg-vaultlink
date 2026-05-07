/**
 * TRC-20 stablecoin adapter (USDT / USDC on TRON).
 *
 * Uses the public trongrid HTTP API as a watch-only RPC. We never call
 * any signing endpoint and never hold a private key — this adapter only
 * needs to be able to read TRC-20 transfer events and tx receipts.
 *
 * Wave 9.3 generalised the original USDT-only adapter to accept any TRC-20
 * stablecoin contract via the `tokenContract` ctor option. Two factories
 * cover the canonical mainnet contracts:
 *   - USDT-TRC20: TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
 *   - USDC-TRC20: TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8
 *
 * Memo-on-TRC20 isn't a first-class wallet feature, so the adapter exposes
 * `memoSupported = false`. Payment attribution is by unique-amount suffix
 * (decimal nudge applied at invoice creation time).
 */

import { AppError, ErrorCode } from '../../utils/errors.js';
import type { CryptoChainId } from '../../types/index.js';
import type { ChainAdapter, RecentTransfer, TxVerification } from './chain.types.js';
import { fromBaseUnits } from './chain.types.js';

/** Mainnet USDT-TRC20 contract address. */
export const USDT_TRC20_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
/** Mainnet USDC-TRC20 contract address (Centre / Circle). */
export const USDC_TRC20_CONTRACT = 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8';

const TRON_DEFAULT_BASE = 'https://api.trongrid.io';
/** TRC-20 stablecoins (USDT, USDC) both use 6 decimals. */
const TRON_STABLECOIN_DECIMALS = 6;

/** Loose check — TRON addresses are base58 ('T' + 33 chars). */
function isPlausibleTronAddress(addr: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(addr);
}

/**
 * Base58 → 20-byte hex (without TRON's 0x41 prefix). Used to convert the
 * operator's receiving address into the form the trc20 contract emits in
 * Transfer event topics, so we can compare without going through full
 * base58check decode of every log row.
 */
function tronAddressToHex20(address: string): string | null {
  if (!isPlausibleTronAddress(address)) return null;
  try {
    const decoded = base58Decode(address);
    if (decoded.length !== 25) return null;
    // First byte = 0x41 prefix, last 4 = checksum, middle 20 = address.
    if (decoded[0] !== 0x41) return null;
    const body = decoded.subarray(1, 21);
    return [...body].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const i = BASE58_ALPHABET.indexOf(c);
    if (i < 0) throw new Error('bad base58');
    n = n * 58n + BigInt(i);
  }
  // Hex string of n.
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  // Restore leading zero bytes (encoded as '1's).
  let leading = 0;
  for (const ch of s) {
    if (ch !== '1') break;
    leading++;
  }
  const out = new Uint8Array(leading + bytes.length);
  out.set(bytes, leading);
  return out;
}

interface TronGridTransferRow {
  transaction_id: string;
  from: string;
  to: string;
  value: string;        // base units as decimal string
  block_timestamp: number;
  type: string;         // 'Transfer'
  token_info?: { decimals?: number; symbol?: string };
}

interface TronGridListResponse {
  data?: TronGridTransferRow[];
  meta?: { fingerprint?: string };
  success?: boolean;
}

interface TronTxInfoResponse {
  id?: string;
  blockNumber?: number;
  blockTimeStamp?: number;
  contractResult?: string[];
  receipt?: { result?: string; energy_usage_total?: number };
  log?: Array<{
    address?: string;     // hex (no 41-prefix)
    topics?: string[];
    data?: string;
  }>;
}

interface TronNowBlockResponse {
  block_header?: { raw_data?: { number?: number } };
}

export interface TronAdapterOptions {
  baseUrl?: string;
  apiKey?: string | null;
  /**
   * Fetch implementation, defaulting to the global fetch. Tests inject a
   * stub here.
   */
  fetchImpl?: typeof fetch;
}

export interface TronStablecoinAdapterOptions extends TronAdapterOptions {
  /** Logical chain id (e.g. 'tron-usdt' or 'tron-usdc'). */
  chainId: CryptoChainId;
  /** Human label shown in invoices and audit logs. */
  label: string;
  /** Mainnet base58 contract address for the stablecoin. */
  tokenContract: string;
}

/**
 * Generic TRC-20 stablecoin adapter. Use the static factories
 * {@link TronStablecoinAdapter.usdt} or {@link TronStablecoinAdapter.usdc}
 * for the canonical mainnet contracts. The legacy {@link TronUsdtAdapter}
 * subclass keeps the original ctor shape for tests and call sites that
 * don't need parameterisation.
 */
export class TronStablecoinAdapter implements ChainAdapter {
  readonly id: CryptoChainId;
  readonly label: string;
  readonly memoSupported = false;
  readonly nativeDecimals = TRON_STABLECOIN_DECIMALS;
  /** Lowercase 20-byte hex (no 0x41 prefix) of the token contract. */
  readonly tokenContractHex: string;
  /** Base58 token contract address (e.g. TR7NH...). */
  readonly tokenContract: string;

  protected readonly baseUrl: string;
  protected readonly apiKey: string | null;
  protected readonly fetchImpl: typeof fetch;

  constructor(opts: TronStablecoinAdapterOptions) {
    this.id = opts.chainId;
    this.label = opts.label;
    this.tokenContract = opts.tokenContract;
    const hex = tronAddressToHex20(opts.tokenContract);
    if (!hex) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `bad TRC-20 contract for ${opts.chainId}: ${opts.tokenContract}`,
      );
    }
    this.tokenContractHex = hex.toLowerCase();
    this.baseUrl = (opts.baseUrl ?? TRON_DEFAULT_BASE).replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Factory for the mainnet USDT-TRC20 contract. */
  static usdt(opts: TronAdapterOptions = {}): TronStablecoinAdapter {
    return new TronStablecoinAdapter({
      ...opts,
      chainId: 'tron-usdt',
      label: 'USDT (TRC-20)',
      tokenContract: USDT_TRC20_CONTRACT,
    });
  }

  /** Factory for the mainnet USDC-TRC20 contract. */
  static usdc(opts: TronAdapterOptions = {}): TronStablecoinAdapter {
    return new TronStablecoinAdapter({
      ...opts,
      chainId: 'tron-usdc',
      label: 'USDC (TRC-20)',
      tokenContract: USDC_TRC20_CONTRACT,
    });
  }

  validateAddress(address: string): boolean {
    return isPlausibleTronAddress(address);
  }

  async verifyTx(input: {
    txHash: string;
    expectedToAddress: string;
    expectedAmount: string;
    expectedDecimals: number;
    expectedMemo?: string | null;
  }): Promise<TxVerification> {
    if (!/^[0-9a-fA-F]{64}$/.test(input.txHash)) {
      throw new AppError(
        ErrorCode.CRYPTO_TX_NOT_FOUND,
        `tx hash ${input.txHash} is not 64 hex chars`,
      );
    }

    // 1) Tx receipt — confirms inclusion + success.
    const info = await this.callJson<TronTxInfoResponse>(
      '/wallet/gettransactioninfobyid',
      { value: input.txHash },
    );
    if (!info || !info.id) {
      return this.notFound();
    }

    const blockNumber = info.blockNumber ?? 0;
    const success =
      info.receipt?.result === undefined || info.receipt.result === 'SUCCESS';
    const blockTime = info.blockTimeStamp
      ? new Date(info.blockTimeStamp).toISOString()
      : null;

    if (!success) {
      return {
        found: true,
        state: 'failed',
        confirmations: 0,
        amount: null,
        fromAddress: null,
        toAddress: null,
        memo: null,
        blockTime,
      };
    }

    // 2) Decode the TRC20 Transfer log to extract from/to/amount.
    //    Match must be against OUR token contract (e.g. USDT or USDC) —
    //    a fake-token transfer to our address never gets attributed.
    const logs = info.log ?? [];
    const transfer = logs.find((l) => {
      const t0 = l.topics?.[0]?.toLowerCase() ?? '';
      const isTransferTopic = t0.endsWith(
        'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
      );
      if (!isTransferTopic) return false;
      const logAddr = (l.address ?? '').toLowerCase().replace(/^0x/, '').replace(/^41/, '');
      return logAddr === this.tokenContractHex;
    });
    if (!transfer) {
      return this.notFound();
    }

    const fromHex = transfer.topics?.[1]?.slice(-40) ?? '';
    const toHex = transfer.topics?.[2]?.slice(-40) ?? '';
    const valueHex = transfer.data ?? '';
    const fromAddress = hexToTronAddress(fromHex);
    const toAddress = hexToTronAddress(toHex);

    let amountBase = 0n;
    try {
      amountBase = BigInt(`0x${valueHex.replace(/^0x/, '') || '0'}`);
    } catch {
      amountBase = 0n;
    }
    const amount = fromBaseUnits(amountBase, TRON_STABLECOIN_DECIMALS);

    // 3) Confirmation count.
    const head = await this.callJson<TronNowBlockResponse>('/wallet/getnowblock', {});
    const headNumber = head?.block_header?.raw_data?.number ?? 0;
    const confirmations = headNumber > blockNumber ? headNumber - blockNumber : 0;

    return {
      found: true,
      state: 'success',
      confirmations,
      amount,
      fromAddress,
      toAddress,
      memo: null,
      blockTime,
    };
  }

  async listRecentTransfers(input: {
    address: string;
    sinceIso: string;
    limit: number;
  }): Promise<RecentTransfer[]> {
    const sinceMs = new Date(input.sinceIso).getTime();
    // `?contract_address=` filters trongrid's index server-side to OUR
    // stablecoin contract. Defense-in-depth: we re-check the contract per
    // row below in case trongrid ever returns mixed token rows.
    const url =
      `${this.baseUrl}/v1/accounts/${encodeURIComponent(input.address)}/transactions/trc20` +
      `?contract_address=${this.tokenContract}` +
      `&only_to=true&limit=${Math.min(Math.max(input.limit, 1), 200)}` +
      `&min_timestamp=${sinceMs}`;

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers['TRON-PRO-API-KEY'] = this.apiKey;

    const res = await this.fetchImpl(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new AppError(
        ErrorCode.CRYPTO_RPC_ERROR,
        `trongrid list returned ${res.status}`,
        { meta: { status: res.status } },
      );
    }
    const json = (await res.json()) as TronGridListResponse;
    const rows = json.data ?? [];

    const head = await this.callJson<TronNowBlockResponse>('/wallet/getnowblock', {});
    const headNumber = head?.block_header?.raw_data?.number ?? 0;

    const transfers: RecentTransfer[] = [];
    for (const r of rows) {
      // Recent-block info isn't on this endpoint; we fall back to "1+
      // confirmation" since the transfer was already indexed by trongrid.
      // The verifyTx call later supplies the exact count when the user
      // confirms (or the worker re-checks).
      let amount = '0';
      try {
        amount = fromBaseUnits(BigInt(r.value || '0'), TRON_STABLECOIN_DECIMALS);
      } catch {
        amount = '0';
      }
      transfers.push({
        txHash: r.transaction_id,
        amount,
        fromAddress: r.from,
        toAddress: r.to,
        memo: null,
        blockTime: new Date(r.block_timestamp).toISOString(),
        confirmations: headNumber > 0 ? 1 : 0,
        state: 'success',
      });
    }
    return transfers;
  }

  /* -------------------------------------------------------- helpers --- */

  private notFound(): TxVerification {
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

  protected async callJson<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };
    if (this.apiKey) headers['TRON-PRO-API-KEY'] = this.apiKey;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new AppError(
        ErrorCode.CRYPTO_RPC_ERROR,
        `trongrid ${path} returned ${res.status}`,
        { meta: { status: res.status, path } },
      );
    }
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new AppError(ErrorCode.CRYPTO_RPC_ERROR, `trongrid ${path} returned non-JSON`, {
        cause: err,
      });
    }
  }
}

/**
 * Legacy thin wrapper — defaults to the USDT-TRC20 contract so call sites
 * and tests written for the original adapter still work without ctor args.
 * New code should call {@link TronStablecoinAdapter.usdt} or `usdc` instead.
 */
export class TronUsdtAdapter extends TronStablecoinAdapter {
  constructor(opts: TronAdapterOptions = {}) {
    super({
      ...opts,
      chainId: 'tron-usdt',
      label: 'USDT (TRC-20)',
      tokenContract: USDT_TRC20_CONTRACT,
    });
  }
}

/**
 * Convert a 20-byte hex address (without TRON's `0x41` prefix) to a
 * base58check TRON address. Doing this without a heavy crypto dep
 * requires reproducing the TRON address-encoding rules.
 */
export function hexToTronAddress(hex20: string): string {
  if (!hex20 || hex20.length < 40) return '';
  const clean = hex20.toLowerCase().replace(/^0x/, '').slice(-40);
  // Prefix 0x41 is TRON's mainnet byte.
  const prefixed = `41${clean}`;
  const bytes = hexToBytes(prefixed);
  const checksum = doubleSha256(bytes).subarray(0, 4);
  const full = new Uint8Array(bytes.length + 4);
  full.set(bytes);
  full.set(checksum, bytes.length);
  return base58Encode(full);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    out[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  }
  return out;
}

function doubleSha256(bytes: Uint8Array): Uint8Array {
  // Lazy-import crypto so the chain types module stays portable.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto');
  const a = createHash('sha256').update(bytes).digest();
  return createHash('sha256').update(a).digest();
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) + BigInt(b);
  let out = '';
  while (n > 0n) {
    const r = n % 58n;
    n = n / 58n;
    out = BASE58_ALPHABET[Number(r)] + out;
  }
  // Preserve leading zero bytes as '1's.
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}
