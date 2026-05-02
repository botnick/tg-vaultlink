/**
 * VaultLink Mini App — pill badge.
 *
 * Used for bot status, file lock state, report status, mode toggles.
 * Tones reference the Telegram theme variables so dark/light both work.
 */

import type { ReactNode } from 'react';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';

interface Props {
  tone?: Tone;
  children: ReactNode;
  icon?: ReactNode;
  className?: string;
}

const TONE: Record<Tone, string> = {
  neutral: 'bg-tg-secondary-bg text-tg-subtitle-text',
  success: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-300',
  danger: 'bg-tg-secondary-bg text-tg-destructive-text',
  info: 'bg-tg-secondary-bg text-tg-accent-text',
};

export function StatusBadge({ tone = 'neutral', children, icon, className = '' }: Props): JSX.Element {
  return (
    <span
      className={[
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        TONE[tone],
        className,
      ].join(' ')}
    >
      {icon}
      {children}
    </span>
  );
}
