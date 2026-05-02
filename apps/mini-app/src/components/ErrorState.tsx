/**
 * VaultLink Mini App — error placeholder with retry.
 *
 * Used by every page that owns a network query — keeps the UX
 * consistent (the user always knows where the retry button lives).
 */

import { useT } from '../lib/i18n.js';
import { Button } from './Button.js';

interface Props {
  message?: string | undefined;
  onRetry?: (() => void) | undefined;
}

export function ErrorState({ message, onRetry }: Props): JSX.Element {
  const t = useT();
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div
        className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-tg-secondary-bg text-tg-destructive-text"
        aria-hidden="true"
      >
        <svg
          width={24}
          height={24}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v5" />
          <path d="M12 16h.01" />
        </svg>
      </div>
      <h2 className="text-base font-semibold text-tg-text">{t('common.error_title')}</h2>
      <p className="mt-1 max-w-sm text-sm text-tg-subtitle-text">
        {message ?? t('common.error_description')}
      </p>
      {onRetry ? (
        <Button className="mt-4" variant="secondary" onClick={onRetry}>
          {t('common.retry')}
        </Button>
      ) : null}
    </div>
  );
}
