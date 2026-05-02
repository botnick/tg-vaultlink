/**
 * VaultLink Mini App — Card primitive.
 *
 * Soft, rounded, themed surface used as the base for every list item
 * and detail block. Padding is configurable so list items can opt out
 * (e.g. when a child component owns its own padding).
 */

import type { HTMLAttributes, ReactNode } from 'react';

interface Props extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  padding?: 'none' | 'sm' | 'md';
  interactive?: boolean;
}

const PAD: Record<NonNullable<Props['padding']>, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
};

export function Card({
  children,
  padding = 'md',
  interactive = false,
  className = '',
  ...rest
}: Props): JSX.Element {
  return (
    <div
      {...rest}
      className={[
        'rounded-2xl bg-tg-section-bg shadow-sm border border-black/[0.04] dark:border-white/[0.06]',
        PAD[padding],
        interactive ? 'press-scale cursor-pointer active:opacity-90' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {children}
    </div>
  );
}
