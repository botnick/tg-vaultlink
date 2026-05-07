/**
 * VaultLink Mini App — network + token brand glyphs.
 *
 * Wave 9.3 — sources every icon from `@web3icons/react`, the same icon set
 * Wallet / DeFi UIs use, so the user sees the canonical, brand-accurate
 * mark for each chain and stablecoin (TRON's angular wedge, BNB's diamond
 * cross, Ethereum's stacked rhombus, TON's diamond, Tether's striped T,
 * Circle's USDC bracket). Adding a new network only requires extending the
 * adapter map below — no SVG copy-paste, no brand-fidelity drift over time.
 *
 * Variants:
 *   - `branded` (default) → full coloured coin, ready to drop into a list
 *     row without an extra wrapper.
 *   - `mono`             → flat shape, used inside our gradient `NetworkBadge`
 *     when the picker wants a uniform "chip on brand bg" look.
 */

import {
  NetworkBinanceSmartChain,
  NetworkEthereum,
  NetworkTon,
  NetworkTron,
  TokenUSDC,
  TokenUSDT,
} from '@web3icons/react'

import type { CryptoNetwork, CryptoToken } from '../lib/credits.api.js';

/**
 * Brand-colour gradients — used by {@link NetworkBadge} when an upstream
 * caller wants a uniform monochrome icon on a coloured chip rather than the
 * library's default branded coin. Keeping the gradient table local lets us
 * tune the picker accent without re-importing the icon catalogue.
 */
export const NETWORK_GRADIENT: Record<CryptoNetwork, string> = {
  trx: 'linear-gradient(135deg, #FF060A 0%, #C90916 100%)',
  bsc: 'linear-gradient(135deg, #F0B90B 0%, #D69E08 100%)',
  eth: 'linear-gradient(135deg, #7E89C8 0%, #454A75 100%)',
  ton: 'linear-gradient(135deg, #0098EA 0%, #007FC4 100%)',
};

/** Map our internal `CryptoNetwork` ids to web3icons React components. */
const NETWORK_COMPONENT = {
  trx: NetworkTron,
  bsc: NetworkBinanceSmartChain,
  eth: NetworkEthereum,
  ton: NetworkTon,
} as const satisfies Record<CryptoNetwork, unknown>;

const TOKEN_COMPONENT = {
  USDT: TokenUSDT,
  USDC: TokenUSDC,
  // Legacy ton-native: re-uses the TON network coin so the icon table stays
  // covered without us having to ship a custom SVG for a deprecated chain.
  native: NetworkTon,
} as const satisfies Record<CryptoToken, unknown>;

export interface NetworkIconProps {
  network: CryptoNetwork;
  /** Pixel size of the icon. Defaults to 24. */
  size?: number;
  /** Foreground colour for the `mono` variant. Ignored when `variant='branded'`. */
  color?: string;
  /**
   * `branded` → full coloured coin (default — matches the wallet picker look).
   * `mono`    → flat single-colour shape, paired with `NetworkBadge` when we
   *             want a uniform-colour chip on a brand-tinted background.
   */
  variant?: 'branded' | 'mono';
}

/**
 * Render the canonical brand mark for a network. Defaults to the branded
 * coin variant — drop it straight into a list row. For monochrome usage on
 * top of a coloured chip, pass `variant='mono'` and wrap with `NetworkBadge`.
 */
export function NetworkIcon({
  network,
  size = 24,
  color,
  variant = 'branded',
}: NetworkIconProps): JSX.Element {
  const Comp = NETWORK_COMPONENT[network];
  // `color` is omitted (rather than passed undefined) when not supplied so
  // the underlying lib's exactOptionalPropertyTypes contract isn't violated.
  return color === undefined ? (
    <Comp variant={variant} size={size} />
  ) : (
    <Comp variant={variant} size={size} color={color} />
  );
}

/**
 * Coloured chip wrapping a `mono` network glyph against the brand gradient.
 * Use this when you want a uniform-colour design language across a screen
 * (e.g. the AmountPicker chain banner). For the default wallet-picker row
 * style, use `<NetworkIcon network={n} />` directly — the branded coin is
 * already self-contained.
 */
export function NetworkBadge({
  network,
  size = 40,
  shape = 'circle',
}: {
  network: CryptoNetwork;
  size?: number;
  /** 'circle' = wallet-style full circle; 'square' = legacy rounded-rect. */
  shape?: 'circle' | 'square';
}): JSX.Element {
  const iconSize = Math.round(size * 0.6);
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center"
      style={{
        width: size,
        height: size,
        background: NETWORK_GRADIENT[network],
        borderRadius: shape === 'circle' ? '9999px' : 14,
        boxShadow: '0 2px 6px -2px rgba(0,0,0,0.25)',
      }}
    >
      <NetworkIcon network={network} size={iconSize} variant="mono" color="#FFFFFF" />
    </span>
  );
}

/* ------------------------------------------------------------------------- *
 * Token (stablecoin) icons
 *
 * Self-contained branded coins. Drop in anywhere — the library renders the
 * full coloured circle so callers don't need a wrapping badge.
 * ------------------------------------------------------------------------- */

export interface TokenIconProps {
  token: CryptoToken;
  /** Pixel size. Defaults to 36. */
  size?: number;
  /** `branded` (default) full coloured coin / `mono` flat shape. */
  variant?: 'branded' | 'mono';
}

export function TokenIcon({
  token,
  size = 36,
  variant = 'branded',
}: TokenIconProps): JSX.Element {
  const Comp = TOKEN_COMPONENT[token];
  return <Comp variant={variant} size={size} />;
}
