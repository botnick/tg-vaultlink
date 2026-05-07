/**
 * Chain adapter interface for self-custodial crypto top-ups.
 *
 * Each adapter wraps one logical chain (TRON-USDT, TON native, etc.)
 * and exposes a uniform surface for invoice verification + recent-transfer
 * polling. Adapters are pure RPC clients: they never sign anything, never
 * hold private keys, and surface every transient failure as an exception
 * so the service layer can decide retry vs. fail-permanent.
 */

import type { CryptoChainId } from '../../types/index.js';

/** Result of verifying a single tx_hash against an invoice. */
export interface TxVerification {
  /** The tx exists on-chain (regardless of whether it matches the invoice). */
  found: boolean;
  /**
   *   'pending'   — broadcast but not yet in a block
   *   'success'   — included in a block, no execution error
   *   'failed'    — included but reverted / failed
   */
  state: 'pending' | 'success' | 'failed';
  /**
   * Confirmations at the time of verification. `0` for pending, otherwise
   * `current_block - tx_block`. Re-poll to update.
   */
  confirmations: number;
  /** Actual amount transferred, in HUMAN units (decimal string). */
  amount: string | null;
  /** Sender address. */
  fromAddress: string | null;
  /** Recipient address. */
  toAddress: string | null;
  /**
   * Memo / comment / message field, when the chain supports it AND the
   * tx carried one. Null otherwise.
   */
  memo: string | null;
  /** Block timestamp, ISO-8601. Null if not yet mined. */
  blockTime: string | null;
}

/** Single transfer returned from `listRecentTransfers`. */
export interface RecentTransfer {
  txHash: string;
  amount: string;
  fromAddress: string;
  toAddress: string;
  memo: string | null;
  blockTime: string;
  confirmations: number;
  state: 'success' | 'failed';
}

export interface ChainAdapter {
  readonly id: CryptoChainId;
  readonly label: string;
  readonly memoSupported: boolean;
  readonly nativeDecimals: number;

  /** Cheap structural check; does NOT call the network. */
  validateAddress(address: string): boolean;

  /** Fetch and verify a single tx hash. */
  verifyTx(input: {
    txHash: string;
    expectedToAddress: string;
    expectedAmount: string;
    expectedDecimals: number;
    expectedMemo?: string | null;
  }): Promise<TxVerification>;

  /**
   * List recent incoming transfers to `address`, newest first. Used by
   * the auto-poll worker to discover payments that the user hasn't
   * pasted yet. Implementations should cap the time window to
   * `sinceIso` to keep RPC quota usage bounded.
   */
  listRecentTransfers(input: {
    address: string;
    sinceIso: string;
    limit: number;
  }): Promise<RecentTransfer[]>;
}

/**
 * Convert a decimal string in human units ("10.5") to base units as a
 * BigInt ("10500000" with decimals=6 → 10500000n). Throws on malformed
 * input — it's a programmer-facing failure, not a user-facing one.
 */
export function toBaseUnits(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`invalid decimal amount: ${amount}`);
  }
  const [whole, fraction = ''] = trimmed.split('.');
  const padded = (fraction + '0'.repeat(decimals)).slice(0, decimals);
  return BigInt((whole ?? '0') + padded);
}

/** Inverse of {@link toBaseUnits}. */
export function fromBaseUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const s = abs.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const fraction = s.slice(s.length - decimals).replace(/0+$/, '');
  const result = fraction.length > 0 ? `${whole}.${fraction}` : whole;
  return negative ? `-${result}` : result;
}

/**
 * Compare an actual on-chain amount to the expected amount, allowing a
 * tolerance expressed in basis points (10000 bps = 100%; 100 bps = 1%).
 * `actual` must be >= `expected * (1 - tolerance)` for a match.
 */
export function amountMatches(input: {
  actual: string;
  expected: string;
  decimals: number;
  toleranceBps: number;
}): boolean {
  const actual = toBaseUnits(input.actual, input.decimals);
  const expected = toBaseUnits(input.expected, input.decimals);
  if (input.toleranceBps <= 0) return actual >= expected;
  // expected * (10000 - bps) / 10000
  const minAccepted = (expected * BigInt(10_000 - input.toleranceBps)) / 10_000n;
  return actual >= minAccepted;
}
