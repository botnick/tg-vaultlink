/**
 * EVM stablecoin adapter — generic ERC-20 watcher used by BSC and Ethereum.
 *
 * Talks to a single trusted JSON-RPC HTTPS endpoint; never holds keys.
 * Every payment-attribution decision is anchored to the canonical contract
 * address from {@link EVM_STABLECOIN_CONTRACTS} so a fake-token transfer
 * to our receiving address can never be matched against an invoice.
 *
 * Defense layers (in order of action):
 *   1. `eth_getLogs` filter: address = canonical contract, topics[0] = Transfer
 *   2. Decode loop: re-checks `log.address === tokenContract` (case-insensitive)
 *   3. Decode loop: re-checks `topics[0] === ERC20_TRANSFER_TOPIC`
 *   4. Service layer: `to === expectedToAddress`, amount match, conf threshold
 *   5. DB: UNIQUE (chain, tx_hash) prevents replay across two invoices
 *
 * Money math is bigint-only. Decimal strings only ever appear at the
 * adapter <-> service boundary via {@link fromBaseUnits}, never inside
 * arithmetic.
 */

import { AppError, ErrorCode } from '../../utils/errors.js';
import type { CryptoChainId } from '../../types/index.js';
import type { ChainAdapter, RecentTransfer, TxVerification } from './chain.types.js';
import { fromBaseUnits } from './chain.types.js';
import {
  ERC20_TRANSFER_TOPIC,
  decodeAddressTopic,
  decodeUint256,
  encodeAddressTopic,
  estimateBlocksAgo,
  normalizeHex,
  toHexBlock,
} from './evm.abi.js';

/** Average seconds per block per network — used to bound getLogs windows. */
const SECONDS_PER_BLOCK: Readonly<Record<'eth' | 'bsc', number>> = {
  eth: 12,
  bsc: 3,
};

/**
 * Provider error code for "result set too large to return" — we receive it
 * from Infura/Alchemy/QuickNode/etc. when getLogs spans too many blocks.
 * Handled by halving the range and recursing.
 */
const RPC_RESULT_LIMIT_EXCEEDED_CODE = -32005;

/** Generic JSON-RPC request payload. Tagged with a numeric id per call. */
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse<T> {
  jsonrpc?: '2.0';
  id?: number;
  result?: T;
  error?: { code: number; message: string };
}

interface EvmTxReceipt {
  status?: string;            // '0x1' = success, '0x0' = revert
  blockNumber?: string;       // 0x-hex
  from?: string;
  to?: string;
  logs?: EvmLog[];
}

interface EvmLog {
  address?: string;
  topics?: string[];
  data?: string;
  blockNumber?: string;
  transactionHash?: string;
  removed?: boolean;
}

export interface EvmAdapterOptions {
  /** Logical chain id (e.g. 'bsc-usdt', 'eth-usdc'). */
  chainId: CryptoChainId;
  /** Human label for invoices and audit. */
  label: string;
  /** Network bucket — drives block-time estimate. */
  network: 'eth' | 'bsc';
  /** HTTPS JSON-RPC endpoint (Infura/Alchemy/dataseed/private node). */
  rpcUrl: string;
  /** Canonical token contract address; lowercased internally. */
  tokenContract: string;
  /** Token decimals; 6 for USDT/USDC ERC-20, 18 for USDT/USDC BEP-20. */
  decimals: number;
  /**
   * Optional "max look-back blocks" cap. Defaults to ceil(invoice_ttl /
   * block_time) when called via the worker. Provider-imposed per-request
   * caps (e.g. Infura's 10k block range) take precedence anyway.
   */
  maxLookbackBlocks?: number;
  /** Fetch impl, swappable in tests. */
  fetchImpl?: typeof fetch;
}

/** Loose check — 0x + 40 hex. */
function isPlausibleEvmAddress(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

/** Loose check — 64-hex tx hash with optional 0x prefix. */
function isPlausibleEvmTxHash(hash: string): boolean {
  return /^(0x)?[0-9a-fA-F]{64}$/.test(hash);
}

/* ------------------------------------------------------------------------- */

export class EvmStablecoinAdapter implements ChainAdapter {
  readonly id: CryptoChainId;
  readonly label: string;
  readonly memoSupported = false;
  readonly nativeDecimals: number;

  private readonly network: 'eth' | 'bsc';
  private readonly rpcUrl: string;
  private readonly tokenContract: string;
  private readonly maxLookbackBlocks: number;
  private readonly fetchImpl: typeof fetch;
  private rpcCallId = 0;

  constructor(opts: EvmAdapterOptions) {
    if (!isPlausibleEvmAddress(opts.tokenContract)) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `bad token contract for ${opts.chainId}: ${opts.tokenContract}`,
      );
    }
    this.id = opts.chainId;
    this.label = opts.label;
    this.nativeDecimals = opts.decimals;
    this.network = opts.network;
    this.rpcUrl = opts.rpcUrl.replace(/\/+$/, '');
    this.tokenContract = opts.tokenContract.toLowerCase();
    // Cap default: invoice TTL + 10% slop, as a conservative max — actual
    // worker calls override via input.sinceIso so this is an upper bound.
    this.maxLookbackBlocks =
      opts.maxLookbackBlocks ??
      // 25h worth of blocks: ETH ~7500, BSC ~30000
      Math.ceil((25 * 60 * 60) / SECONDS_PER_BLOCK[opts.network]);
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  validateAddress(address: string): boolean {
    return isPlausibleEvmAddress(address);
  }

  /* ----------------------------------------------------------- verifyTx -- */

  async verifyTx(input: {
    txHash: string;
    expectedToAddress: string;
    expectedAmount: string;
    expectedDecimals: number;
    expectedMemo?: string | null;
  }): Promise<TxVerification> {
    if (!isPlausibleEvmTxHash(input.txHash)) {
      return notFound();
    }
    const txHash = input.txHash.startsWith('0x') ? input.txHash : `0x${input.txHash}`;

    const receipt = await this.callRpc<EvmTxReceipt | null>('eth_getTransactionReceipt', [
      txHash.toLowerCase(),
    ]);
    if (!receipt || !receipt.blockNumber) {
      return notFound();
    }

    const blockNumber = Number(BigInt(receipt.blockNumber));
    const status = receipt.status?.toLowerCase();
    if (status === '0x0') {
      return {
        found: true,
        state: 'failed',
        confirmations: 0,
        amount: null,
        fromAddress: null,
        toAddress: null,
        memo: null,
        blockTime: null,
      };
    }

    // Find the *first* Transfer log emitted by our token contract sending
    // to the expected address. We don't sum multiple Transfer logs — a
    // single tx_hash maps to a single attribution entry, and the user's
    // wallet sent exactly one transfer to us per invoice.
    const expectedTo = input.expectedToAddress.toLowerCase();
    const transferLog = (receipt.logs ?? []).find((l) => this.isOurTransferTo(l, expectedTo));
    if (!transferLog) {
      // Receipt exists, success state, but no qualifying Transfer log →
      // either user paid the wrong contract, wrong recipient, or the
      // hash isn't actually for an invoice we can credit. Surface as
      // "found but failed match" so the service emits CRYPTO_TX_MISMATCH.
      return {
        found: true,
        state: 'failed',
        confirmations: 0,
        amount: null,
        fromAddress: null,
        toAddress: null,
        memo: null,
        blockTime: null,
      };
    }

    const fromAddress = transferLog.topics?.[1]
      ? decodeAddressTopic(transferLog.topics[1])
      : null;
    const toAddress = transferLog.topics?.[2]
      ? decodeAddressTopic(transferLog.topics[2])
      : null;
    const amountBase = decodeUint256(transferLog.data ?? '0x0');
    const amount = fromBaseUnits(amountBase, this.nativeDecimals);

    const head = await this.getBlockNumber();
    const confirmations = head > blockNumber ? head - blockNumber : 0;

    return {
      found: true,
      state: 'success',
      confirmations,
      amount,
      fromAddress,
      toAddress,
      memo: null,
      // EVM JSON-RPC returns no block timestamp on the receipt; we'd need
      // a follow-up eth_getBlockByNumber call. Skip for now — the worker
      // doesn't depend on blockTime, only on confirmations.
      blockTime: null,
    };
  }

  /* ------------------------------------------------- listRecentTransfers -- */

  async listRecentTransfers(input: {
    address: string;
    sinceIso: string;
    limit: number;
  }): Promise<RecentTransfer[]> {
    if (!isPlausibleEvmAddress(input.address)) return [];

    const head = await this.getBlockNumber();
    if (head === 0) return [];

    const sinceMs = new Date(input.sinceIso).getTime();
    const ageSec = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
    const blocksAgo = estimateBlocksAgo(ageSec, SECONDS_PER_BLOCK[this.network]);
    const fromBlockBig = head > Number(blocksAgo) ? BigInt(head) - blocksAgo : 0n;
    // Don't look further back than maxLookbackBlocks under any circumstance —
    // a misconfigured `sinceIso` shouldn't make us hammer archival history.
    const cap = BigInt(head) - BigInt(this.maxLookbackBlocks);
    const fromBlock = fromBlockBig > cap ? fromBlockBig : cap < 0n ? 0n : cap;

    const logs = await this.getLogsRange({
      fromBlock,
      toBlockHex: 'latest',
      address: input.address.toLowerCase(),
    });

    const out: RecentTransfer[] = [];
    for (const log of logs) {
      if (!this.isOurTransferTo(log, input.address.toLowerCase())) continue;
      const fromAddress = log.topics?.[1] ? decodeAddressTopic(log.topics[1]) : '';
      const toAddress = log.topics?.[2] ? decodeAddressTopic(log.topics[2]) : '';
      const amountBase = decodeUint256(log.data ?? '0x0');
      if (amountBase <= 0n) continue;

      const blockNumber = log.blockNumber ? Number(BigInt(log.blockNumber)) : 0;
      const confirmations = head > blockNumber ? head - blockNumber : 0;

      out.push({
        txHash: (log.transactionHash ?? '').toLowerCase(),
        amount: fromBaseUnits(amountBase, this.nativeDecimals),
        fromAddress,
        toAddress,
        memo: null,
        // No block time without a second RPC round-trip; estimate isn't
        // worth it for the worker which only uses txHash + amount.
        blockTime: new Date().toISOString(),
        confirmations,
        state: 'success',
      });
      if (out.length >= input.limit) break;
    }
    return out;
  }

  /* --------------------------------------------------------- internals --- */

  /**
   * Both verifyTx and listRecentTransfers funnel through this match
   * predicate — single point of truth for "is this a transfer of OUR
   * token going TO the given address?".
   */
  private isOurTransferTo(log: EvmLog, expectedToLower: string): boolean {
    if (log.removed) return false;
    const addr = (log.address ?? '').toLowerCase();
    if (addr !== this.tokenContract) return false;
    const topic0 = (log.topics?.[0] ?? '').toLowerCase();
    if (topic0 !== ERC20_TRANSFER_TOPIC) return false;
    if (!log.topics || log.topics.length < 3) return false;
    let to: string;
    try {
      to = decodeAddressTopic(log.topics[2]!).toLowerCase();
    } catch {
      return false;
    }
    return to === expectedToLower;
  }

  private async getBlockNumber(): Promise<number> {
    const hex = await this.callRpc<string>('eth_blockNumber', []);
    if (!hex || typeof hex !== 'string') return 0;
    try {
      return Number(BigInt(normalizeHex(hex)));
    } catch {
      return 0;
    }
  }

  /**
   * `eth_getLogs` with split-on-overflow recovery. Some providers cap the
   * number of returned logs (Infura: 10k); when we hit that we halve the
   * block range and recurse. Recursion bounded to `MAX_DEPTH` to avoid
   * pathological loops.
   */
  private async getLogsRange(input: {
    fromBlock: bigint;
    toBlockHex: 'latest' | string;
    address: string;
    depth?: number;
  }): Promise<EvmLog[]> {
    const MAX_DEPTH = 6;
    const depth = input.depth ?? 0;
    const fromHex = toHexBlock(input.fromBlock);
    const toHex = input.toBlockHex;

    try {
      return await this.callRpc<EvmLog[]>('eth_getLogs', [
        {
          address: this.tokenContract,
          fromBlock: fromHex,
          toBlock: toHex,
          // topics[0] = Transfer event sig, topics[2] = padded recipient.
          // topics[1] (sender) left null = match any.
          topics: [ERC20_TRANSFER_TOPIC, null, encodeAddressTopic(input.address)],
        },
      ]);
    } catch (err) {
      if (
        depth < MAX_DEPTH &&
        err instanceof AppError &&
        err.code === ErrorCode.CRYPTO_RPC_ERROR &&
        typeof err.meta?.rpcErrorCode === 'number' &&
        err.meta.rpcErrorCode === RPC_RESULT_LIMIT_EXCEEDED_CODE
      ) {
        // Halve the range. Convert toBlockHex='latest' → numeric using head.
        const head =
          toHex === 'latest' ? BigInt(await this.getBlockNumber()) : BigInt(toHex);
        const mid = (input.fromBlock + head) / 2n;
        if (mid <= input.fromBlock || mid >= head) throw err;
        const left = await this.getLogsRange({
          fromBlock: input.fromBlock,
          toBlockHex: toHexBlock(mid),
          address: input.address,
          depth: depth + 1,
        });
        const right = await this.getLogsRange({
          fromBlock: mid + 1n,
          toBlockHex: toHexBlock(head),
          address: input.address,
          depth: depth + 1,
        });
        return left.concat(right);
      }
      throw err;
    }
  }

  private async callRpc<T>(method: string, params: unknown[]): Promise<T> {
    if (!this.rpcUrl) {
      throw new AppError(
        ErrorCode.CRYPTO_CHAIN_DISABLED,
        `${this.id} RPC URL not configured`,
        { meta: { chain: this.id } },
      );
    }
    const id = ++this.rpcCallId;
    const body: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
    let res: Response;
    try {
      res = await this.fetchImpl(this.rpcUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new AppError(
        ErrorCode.CRYPTO_RPC_ERROR,
        `${this.id} ${method} network error`,
        { cause: err, meta: { chain: this.id, method } },
      );
    }
    if (!res.ok) {
      throw new AppError(
        ErrorCode.CRYPTO_RPC_ERROR,
        `${this.id} ${method} returned ${res.status}`,
        { meta: { status: res.status, chain: this.id, method } },
      );
    }
    let payload: JsonRpcResponse<T>;
    try {
      payload = (await res.json()) as JsonRpcResponse<T>;
    } catch (err) {
      throw new AppError(ErrorCode.CRYPTO_RPC_ERROR, `${this.id} ${method} non-JSON`, {
        cause: err,
        meta: { chain: this.id, method },
      });
    }
    if (payload.error) {
      throw new AppError(
        ErrorCode.CRYPTO_RPC_ERROR,
        `${this.id} ${method}: ${payload.error.message}`,
        {
          meta: {
            chain: this.id,
            method,
            rpcErrorCode: payload.error.code,
          },
        },
      );
    }
    if (payload.result === undefined) {
      throw new AppError(
        ErrorCode.CRYPTO_RPC_ERROR,
        `${this.id} ${method} returned no result`,
        { meta: { chain: this.id, method } },
      );
    }
    return payload.result;
  }
}

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
