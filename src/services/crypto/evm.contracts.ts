/**
 * Canonical token contract addresses for EVM stablecoins.
 *
 * Frozen at module level so adapter wiring (`new EvmStablecoinAdapter`)
 * cannot accidentally point at a fork or fake-token deployment. Any future
 * chain/token addition lands here first; the adapter then references the
 * map by `(network, token)` key.
 *
 * Sources:
 *   - USDT-ERC20 — https://etherscan.io/token/0xdac17f958d2ee523a2206206994597c13d831ec7
 *   - USDC-ERC20 — https://etherscan.io/token/0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48
 *   - USDT-BEP20 — https://bscscan.com/token/0x55d398326f99059ff775485246999027b3197955
 *   - USDC-BEP20 — https://bscscan.com/token/0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d
 *
 * Decimals are encoded in this map too because BSC USDT uniquely uses 18
 * (its deployer chose to mirror BNB), while every other USDT/USDC ERC-20
 * uses 6. The adapter cannot trust the on-chain `decimals()` getter for
 * confirmation math — it must use the value baked here.
 */

import type { CryptoChainId } from '../../types/index.js';

export interface EvmTokenSpec {
  /** Lowercase 0x-prefixed contract address. Compared case-insensitively. */
  readonly address: string;
  /** Token decimals as documented by the issuer. */
  readonly decimals: number;
  /** Human label for QR captions / audit logs. */
  readonly label: string;
}

/**
 * EVM stablecoin contract registry. Addresses are LOWERCASE on purpose so
 * downstream comparisons stay simple — the adapter calls `.toLowerCase()`
 * on every value coming off the wire before comparing.
 */
export const EVM_STABLECOIN_CONTRACTS: Readonly<
  Record<Exclude<CryptoChainId, 'tron-usdt' | 'tron-usdc' | 'ton-usdt-jetton' | 'ton-usdc-jetton' | 'ton-native'>, EvmTokenSpec>
> = Object.freeze({
  'eth-usdt': Object.freeze({
    address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
    decimals: 6,
    label: 'USDT (ERC-20)',
  }),
  'eth-usdc': Object.freeze({
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    decimals: 6,
    label: 'USDC (ERC-20)',
  }),
  'bsc-usdt': Object.freeze({
    address: '0x55d398326f99059ff775485246999027b3197955',
    decimals: 18,
    label: 'USDT (BEP-20)',
  }),
  'bsc-usdc': Object.freeze({
    address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d',
    decimals: 18,
    label: 'USDC (BEP-20)',
  }),
});

export type EvmStablecoinChainId = keyof typeof EVM_STABLECOIN_CONTRACTS;

/** True iff the given chain id has an EVM contract entry. Type guard. */
export function isEvmStablecoinChain(id: CryptoChainId): id is EvmStablecoinChainId {
  return id in EVM_STABLECOIN_CONTRACTS;
}
