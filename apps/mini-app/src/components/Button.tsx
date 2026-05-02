/**
 * VaultLink Mini App — Button primitive.
 *
 * Variants:
 *   - `primary`     → brand-gradient pill with glow + shine on press.
 *   - `solid`       → flat Telegram button color (legacy, no shine).
 *   - `secondary`   → outlined neutral.
 *   - `destructive` → red text on subtle background.
 *   - `ghost`       → text-only.
 *
 * Every press fires a light haptic. Disabled / loading dim the surface.
 * The shine overlay only renders for the gradient variant so we don't
 * add a no-op pseudo-element to every button on the page.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { hapticImpact } from '../lib/telegram.js';

type Variant = 'primary' | 'solid' | 'secondary' | 'destructive' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  block?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  children: ReactNode;
}

const VARIANT: Record<Variant, string> = {
  primary:
    'bg-gradient-hero text-white shadow-glow shine-host border border-white/15',
  solid: 'bg-tg-button text-tg-button-text hover:opacity-95',
  secondary:
    'bg-transparent text-tg-text border border-black/10 dark:border-white/15 hover:bg-tg-secondary-bg',
  destructive:
    'bg-tg-secondary-bg text-tg-destructive-text hover:opacity-90 border border-transparent',
  ghost: 'bg-transparent text-tg-link hover:bg-tg-secondary-bg',
};

const SIZE: Record<Size, string> = {
  sm: 'h-9 px-4 text-sm',
  md: 'h-12 px-5 text-base',
  lg: 'h-14 px-6 text-base',
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    block = false,
    leftIcon,
    rightIcon,
    className = '',
    onClick,
    disabled,
    children,
    type = 'button',
    ...rest
  },
  ref,
) {
  const isDisabled = disabled === true || loading;
  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      onClick={(e) => {
        if (isDisabled) return;
        hapticImpact('light');
        onClick?.(e);
      }}
      className={[
        'press-scale relative inline-flex items-center justify-center gap-2 rounded-full font-semibold select-none tracking-wide',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-tg-link/60',
        VARIANT[variant],
        SIZE[size],
        block ? 'w-full' : '',
        isDisabled ? 'opacity-50 cursor-not-allowed' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {loading ? (
        <span
          className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : (
        leftIcon
      )}
      <span className="relative z-[1]">{children}</span>
      {!loading && rightIcon}
      {variant === 'primary' ? <span className="shine-overlay" /> : null}
    </button>
  );
});
