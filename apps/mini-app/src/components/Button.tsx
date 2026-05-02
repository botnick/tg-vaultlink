/**
 * VaultLink Mini App — Button primitive.
 *
 * Variants:
 *   - `primary`     → Telegram button color (filled).
 *   - `secondary`   → outlined, neutral.
 *   - `destructive` → red text on subtle background.
 *   - `ghost`       → text-only.
 *
 * Every press fires a light haptic. Disabled / loading states swallow
 * clicks and dim the surface.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { hapticImpact } from '../lib/telegram.js';

type Variant = 'primary' | 'secondary' | 'destructive' | 'ghost';
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
  primary: 'bg-tg-button text-tg-button-text hover:opacity-95',
  secondary:
    'bg-transparent text-tg-text border border-black/10 dark:border-white/15 hover:bg-tg-secondary-bg',
  destructive: 'bg-tg-secondary-bg text-tg-destructive-text hover:opacity-90',
  ghost: 'bg-transparent text-tg-link hover:bg-tg-secondary-bg',
};

const SIZE: Record<Size, string> = {
  sm: 'h-8 px-3 text-sm',
  md: 'h-11 px-4 text-base',
  lg: 'h-12 px-5 text-base',
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
        'press-scale inline-flex items-center justify-center gap-2 rounded-2xl font-medium select-none',
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
      <span>{children}</span>
      {!loading && rightIcon}
    </button>
  );
});
