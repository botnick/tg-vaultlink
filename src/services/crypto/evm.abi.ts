/**
 * Pure-function ERC-20 ABI helpers — just enough hex math to decode the
 * Transfer event without bringing in ethers/viem. Keeps the bundle slim and
 * the dependency surface minimal.
 *
 * Transfer(address indexed from, address indexed to, uint256 value)
 *   topic0  = keccak256("Transfer(address,address,uint256)")
 *           = ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
 *   topics[1] = from   (32-byte left-padded)
 *   topics[2] = to     (32-byte left-padded)
 *   data      = uint256 value (32-byte big-endian)
 */

/**
 * keccak256 hash of the canonical Transfer event signature, lowercase
 * 32-byte hex (no `0x` prefix). Compared case-insensitively against
 * incoming `log.topics[0]`.
 */
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/**
 * Lowercase a hex string and ensure it carries the `0x` prefix. Throws on
 * non-hex input — callers wrap in try/catch and surface as RPC error.
 */
export function normalizeHex(input: string): string {
  const v = input.trim();
  if (!/^0x[0-9a-fA-F]*$/.test(v)) {
    throw new Error(`not a hex string: ${input}`);
  }
  return v.toLowerCase();
}

/**
 * Decode an indexed-address topic. The address sits in the rightmost 20
 * bytes; left padding is `0x000…`. Returns the canonical 0x-prefixed
 * lowercase 40-hex form.
 */
export function decodeAddressTopic(topic: string): string {
  const v = normalizeHex(topic);
  // Topic length should be 0x + 64 hex chars (32 bytes).
  if (v.length !== 66) throw new Error(`bad topic length: ${topic}`);
  // Address = last 20 bytes = 40 hex chars.
  return `0x${v.slice(-40)}`;
}

/**
 * Pack a 0x-prefixed 20-byte address into a 32-byte indexed-topic format
 * for `eth_getLogs` filtering. Result is lowercase, 0x-prefixed, 66 chars.
 */
export function encodeAddressTopic(address: string): string {
  const v = normalizeHex(address);
  if (v.length !== 42) throw new Error(`bad address length: ${address}`);
  return `0x${'0'.repeat(24)}${v.slice(2)}`;
}

/**
 * Decode the Transfer event's `value` data field (uint256, 32-byte BE).
 * Returns a bigint. Empty / malformed data → 0n.
 */
export function decodeUint256(data: string): bigint {
  if (!data) return 0n;
  const v = data.trim();
  if (v.length === 0) return 0n;
  try {
    return BigInt(v.startsWith('0x') ? v : `0x${v}`);
  } catch {
    return 0n;
  }
}

/**
 * Convert a number (block height) to its 0x-prefixed hex form, lowercase.
 * `eth_getLogs` filter blocks accept either decimal strings or hex; we
 * always send hex for consistency.
 */
export function toHexBlock(n: number | bigint): string {
  const big = typeof n === 'bigint' ? n : BigInt(n);
  if (big < 0n) throw new Error('negative block number');
  return `0x${big.toString(16)}`;
}

/**
 * Approximate block height from a wall-clock window, given the chain's
 * average block time in seconds. Used to bound `eth_getLogs` queries when
 * the RPC has no archival access — we look back only as far as the
 * invoice TTL, never more.
 *
 * This is a heuristic; getLogs callers handle "result limit exceeded"
 * (-32005) by halving the range and recursing, so a slightly-off estimate
 * is harmless.
 */
export function estimateBlocksAgo(secondsAgo: number, secondsPerBlock: number): bigint {
  if (secondsAgo <= 0) return 0n;
  if (secondsPerBlock <= 0) return 0n;
  return BigInt(Math.ceil(secondsAgo / secondsPerBlock));
}
