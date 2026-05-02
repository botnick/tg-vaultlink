/**
 * VaultLink Mini App — Card primitive.
 *
 * Soft, rounded surface with a few visual variants:
 *
 *   - `default` — opaque themed surface (light shadow). Default.
 *   - `glass` — frosted glass on top of the parent (Aurora). Use inside
 *     hero contexts where the background is rich.
 *   - `gradient` — solid violet→pink hero gradient with shine overlay.
 *   - `outline` — flat, no shadow, hairline border. For dense lists.
 *
 * `interactive` adds press feedback (scale + glow). `accentGlow` adds a
 * coloured drop shadow to the elevated edge — pick from the brand palette.
 */

import type { HTMLAttributes, ReactNode } from 'react';

type Variant = 'default' | 'glass' | 'gradient' | 'outline';
type Glow = 'none' | 'violet' | 'pink' | 'cyan';

interface Props extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padding?: 'none' | 'sm' | 'md' | 'lg';
  interactive?: boolean;
  variant?: Variant;
  accentGlow?: Glow;
}

const PAD: Record<NonNullable<Props['padding']>, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
};

const VARIANT: Record<Variant, string> = {
  default:
    'bg-tg-section-bg shadow-soft border border-black/[0.04] dark:border-white/[0.06]',
  glass: 'glass shadow-soft',
  gradient:
    'bg-gradient-hero text-white border border-white/15 shadow-glow shine-host',
  outline: 'bg-tg-section-bg border border-black/[0.06] dark:border-white/[0.08]',
};

const GLOW: Record<Glow, string> = {
  none: '',
  violet: 'shadow-glow',
  pink: 'shadow-glow-pink',
  cyan: 'shadow-glow-cyan',
};

export function Card({
  children,
  padding = 'md',
  interactive = false,
  variant = 'default',
  accentGlow = 'none',
  className = '',
  ...rest
}: Props): JSX.Element {
  return (
    <div
      {...rest}
      className={[
        'rounded-3xl',
        VARIANT[variant],
        PAD[padding],
        GLOW[accentGlow],
        interactive ? 'press-scale cursor-pointer' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
      {variant === 'gradient' ? <span className="shine-overlay" /> : null}
    </div>
  );
}
