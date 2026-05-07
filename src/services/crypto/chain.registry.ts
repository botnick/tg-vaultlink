/**
 * Single source of truth for every chain×token combo the bot watches.
 *
 * Adding a new chain is a one-stop edit: append a {@link ChainSpec} entry
 * here and (if it needs a typed env knob) add the matching field to
 * `src/config/env.ts`. Everything downstream — adapter wiring, service
 * defaults, picker UX, audit metadata — iterates over this registry.
 *
 * Removing a chain works the same way: drop the entry. In-flight invoices
 * for the removed chain still type-check because `CryptoChainId` keeps the
 * union member; they just stop matching any registry row, so the service
 * surfaces them as `CRYPTO_CHAIN_DISABLED` until the operator either
 * re-adds the spec or admin-extends/refunds the invoice.
 *
 * No hot-path arithmetic happens inside specs — `buildAdapter` is invoked
 * exactly once at boot, and `envConfirmations`/`envRate` are tiny accessors.
 */

import type { Config } from '../../config/env.js';
import type { SettingsService } from '../settings.service.js';
import type { ChainAdapter } from './chain.types.js';
import type { CryptoChainId, CryptoNetwork, CryptoToken } from '../../types/index.js';
import { TronStablecoinAdapter } from './tron.adapter.js';
import { TonJettonAdapter, TonNativeAdapter } from './ton.adapter.js';
import { EvmStablecoinAdapter } from './evm.adapter.js';
import { EVM_STABLECOIN_CONTRACTS } from './evm.contracts.js';

/** Setting-key helper: `credits.crypto.<chain>.<suffix>`. */
export function chainKey(chain: CryptoChainId, suffix: string): string {
  return `credits.crypto.${chain}.${suffix}`;
}

export interface ChainSpecBuildInput {
  config: Config;
  settings: SettingsService;
}

export interface ChainSpec {
  /** Logical chain id, also the key in adapters / settings tables. */
  readonly id: CryptoChainId;
  /** L1/L2 bucket for picker grouping. */
  readonly network: CryptoNetwork;
  /** Stablecoin (or 'native' for legacy). */
  readonly token: CryptoToken;
  /** Human-readable label for invoices and audit. */
  readonly label: string;
  /** Native decimals. Encoded here, not read from on-chain `decimals()`. */
  readonly decimals: number;
  /**
   * Whether this chain's protocol supports a memo / comment field. Drives
   * the unique-amount allocator (memo-less chains get a `.000XYZ` suffix
   * to disambiguate concurrent same-amount invoices).
   */
  readonly memoSupported: boolean;
  /**
   * Whether this chain shows up in the user-facing picker. Currently false
   * only for the legacy 'ton-native' chain — its adapter stays registered
   * so historical invoices verify, but new invoices are blocked.
   */
  readonly showInPicker: boolean;
  /** Default min/max top-up amount. Operator can override per chain via settings. */
  readonly defaults: {
    readonly minAmount: string;
    readonly maxAmount: string;
  };
  /** Env-driven default confirmation threshold. Settings override at runtime. */
  envConfirmations(config: Config): number;
  /** Env-driven default credit rate (credits per 1 whole unit). */
  envRate(config: Config): number;
  /**
   * Construct the adapter for this chain or return null when env makes it
   * inactive (e.g. EVM with no RPC URL). The function is invoked once per
   * boot from {@link buildAdapterMap}.
   */
  buildAdapter(input: ChainSpecBuildInput): ChainAdapter | null;
}

const TRC20_STABLECOIN_RANGE = { minAmount: '1', maxAmount: '5000' } as const;
const EVM_STABLECOIN_RANGE = { minAmount: '5', maxAmount: '5000' } as const;
const TON_STABLECOIN_RANGE = { minAmount: '1', maxAmount: '5000' } as const;
const TON_NATIVE_RANGE = { minAmount: '0.5', maxAmount: '10000' } as const;

/**
 * Add new chains by appending a `ChainSpec` here. The service iterates
 * over the registry — no other file needs to change to pick up the new
 * entry (besides `src/config/env.ts` if the spec references typed env
 * knobs).
 */
const REGISTRY_DEFS: readonly ChainSpec[] = [
  // ── TRON ─────────────────────────────────────────────────────────────
  {
    id: 'tron-usdt',
    network: 'trx',
    token: 'USDT',
    label: 'USDT (TRC-20)',
    decimals: 6,
    memoSupported: false,
    showInPicker: true,
    defaults: TRC20_STABLECOIN_RANGE,
    envConfirmations: (c) => c.CRYPTO_TRON_USDT_CONFIRMATIONS,
    envRate: (c) => c.CRYPTO_TRON_USDT_RATE,
    buildAdapter: ({ config, settings }) => {
      const apiKey = settings.getString(chainKey('tron-usdt', 'api_key')) ?? null;
      return TronStablecoinAdapter.usdt({
        ...(apiKey ? { apiKey } : {}),
        ...(config.CRYPTO_TRON_RPC_URL ? { baseUrl: config.CRYPTO_TRON_RPC_URL } : {}),
      });
    },
  },
  {
    id: 'tron-usdc',
    network: 'trx',
    token: 'USDC',
    label: 'USDC (TRC-20)',
    decimals: 6,
    memoSupported: false,
    showInPicker: true,
    defaults: TRC20_STABLECOIN_RANGE,
    envConfirmations: (c) => c.CRYPTO_TRON_USDC_CONFIRMATIONS,
    envRate: (c) => c.CRYPTO_TRON_USDC_RATE,
    buildAdapter: ({ config, settings }) => {
      const apiKey =
        settings.getString(chainKey('tron-usdc', 'api_key')) ??
        settings.getString(chainKey('tron-usdt', 'api_key')) ??
        null;
      return TronStablecoinAdapter.usdc({
        ...(apiKey ? { apiKey } : {}),
        ...(config.CRYPTO_TRON_RPC_URL ? { baseUrl: config.CRYPTO_TRON_RPC_URL } : {}),
      });
    },
  },

  // ── BSC (BEP-20 over EVM JSON-RPC) ───────────────────────────────────
  {
    id: 'bsc-usdt',
    network: 'bsc',
    token: 'USDT',
    label: EVM_STABLECOIN_CONTRACTS['bsc-usdt'].label,
    decimals: EVM_STABLECOIN_CONTRACTS['bsc-usdt'].decimals,
    memoSupported: false,
    showInPicker: true,
    defaults: EVM_STABLECOIN_RANGE,
    envConfirmations: (c) => c.CRYPTO_BSC_USDT_CONFIRMATIONS,
    envRate: (c) => c.CRYPTO_BSC_USDT_RATE,
    buildAdapter: ({ config }) => {
      if (!config.CRYPTO_BSC_RPC_URL) return null;
      return new EvmStablecoinAdapter({
        chainId: 'bsc-usdt',
        label: EVM_STABLECOIN_CONTRACTS['bsc-usdt'].label,
        network: 'bsc',
        rpcUrl: config.CRYPTO_BSC_RPC_URL,
        tokenContract: EVM_STABLECOIN_CONTRACTS['bsc-usdt'].address,
        decimals: EVM_STABLECOIN_CONTRACTS['bsc-usdt'].decimals,
      });
    },
  },
  {
    id: 'bsc-usdc',
    network: 'bsc',
    token: 'USDC',
    label: EVM_STABLECOIN_CONTRACTS['bsc-usdc'].label,
    decimals: EVM_STABLECOIN_CONTRACTS['bsc-usdc'].decimals,
    memoSupported: false,
    showInPicker: true,
    defaults: EVM_STABLECOIN_RANGE,
    envConfirmations: (c) => c.CRYPTO_BSC_USDC_CONFIRMATIONS,
    envRate: (c) => c.CRYPTO_BSC_USDC_RATE,
    buildAdapter: ({ config }) => {
      if (!config.CRYPTO_BSC_RPC_URL) return null;
      return new EvmStablecoinAdapter({
        chainId: 'bsc-usdc',
        label: EVM_STABLECOIN_CONTRACTS['bsc-usdc'].label,
        network: 'bsc',
        rpcUrl: config.CRYPTO_BSC_RPC_URL,
        tokenContract: EVM_STABLECOIN_CONTRACTS['bsc-usdc'].address,
        decimals: EVM_STABLECOIN_CONTRACTS['bsc-usdc'].decimals,
      });
    },
  },

  // ── Ethereum (ERC-20 over EVM JSON-RPC) ──────────────────────────────
  {
    id: 'eth-usdt',
    network: 'eth',
    token: 'USDT',
    label: EVM_STABLECOIN_CONTRACTS['eth-usdt'].label,
    decimals: EVM_STABLECOIN_CONTRACTS['eth-usdt'].decimals,
    memoSupported: false,
    showInPicker: true,
    defaults: EVM_STABLECOIN_RANGE,
    envConfirmations: (c) => c.CRYPTO_ETH_USDT_CONFIRMATIONS,
    envRate: (c) => c.CRYPTO_ETH_USDT_RATE,
    buildAdapter: ({ config }) => {
      if (!config.CRYPTO_ETH_RPC_URL) return null;
      return new EvmStablecoinAdapter({
        chainId: 'eth-usdt',
        label: EVM_STABLECOIN_CONTRACTS['eth-usdt'].label,
        network: 'eth',
        rpcUrl: config.CRYPTO_ETH_RPC_URL,
        tokenContract: EVM_STABLECOIN_CONTRACTS['eth-usdt'].address,
        decimals: EVM_STABLECOIN_CONTRACTS['eth-usdt'].decimals,
      });
    },
  },
  {
    id: 'eth-usdc',
    network: 'eth',
    token: 'USDC',
    label: EVM_STABLECOIN_CONTRACTS['eth-usdc'].label,
    decimals: EVM_STABLECOIN_CONTRACTS['eth-usdc'].decimals,
    memoSupported: false,
    showInPicker: true,
    defaults: EVM_STABLECOIN_RANGE,
    envConfirmations: (c) => c.CRYPTO_ETH_USDC_CONFIRMATIONS,
    envRate: (c) => c.CRYPTO_ETH_USDC_RATE,
    buildAdapter: ({ config }) => {
      if (!config.CRYPTO_ETH_RPC_URL) return null;
      return new EvmStablecoinAdapter({
        chainId: 'eth-usdc',
        label: EVM_STABLECOIN_CONTRACTS['eth-usdc'].label,
        network: 'eth',
        rpcUrl: config.CRYPTO_ETH_RPC_URL,
        tokenContract: EVM_STABLECOIN_CONTRACTS['eth-usdc'].address,
        decimals: EVM_STABLECOIN_CONTRACTS['eth-usdc'].decimals,
      });
    },
  },

  // ── TON (TEP-74 jettons + legacy native) ─────────────────────────────
  {
    id: 'ton-usdt-jetton',
    network: 'ton',
    token: 'USDT',
    label: 'USDT (TON)',
    decimals: 6,
    memoSupported: true,
    showInPicker: true,
    defaults: TON_STABLECOIN_RANGE,
    envConfirmations: (c) => c.CRYPTO_TON_USDT_CONFIRMATIONS,
    envRate: (c) => c.CRYPTO_TON_USDT_RATE,
    buildAdapter: ({ config, settings }) => {
      const apiKey =
        settings.getString(chainKey('ton-usdt-jetton', 'api_key')) ??
        settings.getString(chainKey('ton-native', 'api_key')) ??
        null;
      return TonJettonAdapter.usdt({
        ...(apiKey ? { apiKey } : {}),
        ...(config.CRYPTO_TON_RPC_URL ? { baseUrl: config.CRYPTO_TON_RPC_URL } : {}),
      });
    },
  },
  {
    id: 'ton-usdc-jetton',
    network: 'ton',
    token: 'USDC',
    label: 'USDC (TON)',
    decimals: 6,
    memoSupported: true,
    showInPicker: true,
    defaults: TON_STABLECOIN_RANGE,
    envConfirmations: (c) => c.CRYPTO_TON_USDC_CONFIRMATIONS,
    envRate: (c) => c.CRYPTO_TON_USDC_RATE,
    buildAdapter: ({ config, settings }) => {
      const apiKey =
        settings.getString(chainKey('ton-usdc-jetton', 'api_key')) ??
        settings.getString(chainKey('ton-native', 'api_key')) ??
        null;
      return TonJettonAdapter.usdc({
        ...(apiKey ? { apiKey } : {}),
        ...(config.CRYPTO_TON_RPC_URL ? { baseUrl: config.CRYPTO_TON_RPC_URL } : {}),
      });
    },
  },
  {
    id: 'ton-native',
    network: 'ton',
    token: 'native',
    label: 'TON',
    decimals: 9,
    memoSupported: true,
    // Legacy: kept registered to verify in-flight invoices, but hidden from
    // new-invoice picker. Operator can flip showInPicker by overriding the
    // entry if they want native top-ups back.
    showInPicker: false,
    defaults: TON_NATIVE_RANGE,
    envConfirmations: (c) => c.CRYPTO_TON_NATIVE_CONFIRMATIONS,
    envRate: (c) => c.CRYPTO_TON_NATIVE_RATE,
    buildAdapter: ({ config, settings }) => {
      const apiKey = settings.getString(chainKey('ton-native', 'api_key')) ?? null;
      return new TonNativeAdapter({
        ...(apiKey ? { apiKey } : {}),
        ...(config.CRYPTO_TON_RPC_URL ? { baseUrl: config.CRYPTO_TON_RPC_URL } : {}),
      });
    },
  },
];

/**
 * Public registry. Frozen at module init so downstream code can safely
 * iterate without worrying about mutation. The typed `readonly ChainSpec[]`
 * preserves the inline accessor types — adding a new chain only requires
 * appending an entry above.
 */
export const CHAIN_REGISTRY: readonly ChainSpec[] = Object.freeze(REGISTRY_DEFS);

const REGISTRY_INDEX = new Map<CryptoChainId, ChainSpec>(
  CHAIN_REGISTRY.map((s) => [s.id, s] as const),
);

/** Lookup a spec by chain id; returns undefined when the chain isn't registered. */
export function chainSpecOf(id: CryptoChainId): ChainSpec | undefined {
  return REGISTRY_INDEX.get(id);
}

/**
 * Iterate over the registry and instantiate every adapter the env permits.
 * `buildAdapter` returns null when the chain is gated by a missing RPC URL
 * (typical for EVM networks that the operator hasn't set up yet) — those
 * entries are silently skipped.
 */
export function buildAdapterMap(input: {
  config: Config;
  settings: SettingsService;
}): Map<CryptoChainId, ChainAdapter> {
  const map = new Map<CryptoChainId, ChainAdapter>();
  for (const spec of CHAIN_REGISTRY) {
    const adapter = spec.buildAdapter(input);
    if (adapter) map.set(spec.id, adapter);
  }
  return map;
}

/** Picker-visible specs. Excludes legacy entries (e.g. 'ton-native'). */
export function pickerSpecs(): readonly ChainSpec[] {
  return CHAIN_REGISTRY.filter((s) => s.showInPicker);
}
