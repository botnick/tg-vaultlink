/**
 * VaultLink Mini App — outside-Telegram guard screen.
 *
 * Rendered whenever `Telegram.WebApp` is missing or `initData` is empty.
 * The CTA tries to deep-link into the Telegram app via
 * `https://t.me/<bot_username>`; if `VITE_BOT_USERNAME` is not set we
 * fall back to a plain text instruction.
 */

import { useT } from '../lib/i18n.js';

const BOT_USERNAME = (import.meta.env.VITE_BOT_USERNAME ?? '').replace(/^@/, '');

export function OutsideTelegramScreen(): JSX.Element {
  const t = useT();
  const href = BOT_USERNAME ? `https://t.me/${BOT_USERNAME}` : null;

  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center bg-tg-bg px-6 text-center"
      style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}
    >
      <div
        className="mb-5 flex h-16 w-16 items-center justify-center rounded-3xl bg-tg-button text-tg-button-text shadow-md"
        aria-hidden="true"
      >
        <svg width={32} height={32} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21.5 4.5L2.5 11.5l5.5 2 2 6 3-3.5 5 4 3.5-15.5z"
            fill="currentColor"
            fillOpacity="0.15"
          />
        </svg>
      </div>
      <h1 className="text-xl font-semibold text-tg-text">{t('outside_telegram.title')}</h1>
      <p className="mt-2 max-w-sm text-sm text-tg-subtitle-text">
        {t('outside_telegram.description')}
      </p>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="press-scale mt-6 inline-flex h-12 items-center justify-center rounded-2xl bg-tg-button px-6 font-medium text-tg-button-text shadow-sm"
        >
          {t('outside_telegram.cta')}
        </a>
      ) : (
        <p className="mt-6 rounded-2xl bg-tg-secondary-bg px-4 py-3 text-xs text-tg-hint">
          VITE_BOT_USERNAME is not configured.
        </p>
      )}
    </div>
  );
}
