/**
 * VaultLink Mini App — Settings.
 *
 * Locale switch, theme info, and an About section. The locale switch
 * fires `PATCH /settings` so the bot ↔ Mini App stay in sync.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { useLocale, useT } from '../lib/i18n.js';
import { apiPatch } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useTheme } from '../providers/ThemeProvider.js';
import { useAuth } from '../providers/AuthProvider.js';
import { hapticImpact, hapticNotify } from '../lib/telegram.js';
import type { Locale } from '../types/api.js';

const APP_VERSION = (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'dev';

export function Settings(): JSX.Element {
  const t = useT();
  const { locale, setLocale } = useLocale();
  const { colorScheme } = useTheme();
  const { refresh } = useAuth();
  const qc = useQueryClient();

  const localeMutation = useMutation({
    mutationFn: (next: Locale) =>
      apiPatch<{ user?: { locale?: string } }>('/settings', { locale: next }),
    onSuccess: (_data, next) => {
      hapticNotify('success');
      setLocale(next);
      qc.invalidateQueries({ queryKey: qk.me });
      refresh();
    },
  });

  return (
    <Layout title={t('settings.title')}>
      <div className="space-y-4">
        <Card padding="md" className="fade-up">
          <p className="text-xs uppercase tracking-wider text-tg-hint">{t('settings.language')}</p>
          <div className="mt-2 grid grid-cols-2 overflow-hidden rounded-2xl bg-tg-secondary-bg p-1">
            {(['th', 'en'] as Locale[]).map((l) => {
              const active = locale === l;
              return (
                <button
                  key={l}
                  type="button"
                  disabled={localeMutation.isPending}
                  onClick={() => {
                    if (active) return;
                    hapticImpact('light');
                    localeMutation.mutate(l);
                  }}
                  className={[
                    'press-scale h-10 rounded-xl text-sm font-medium transition-colors',
                    active
                      ? 'bg-tg-button text-tg-button-text shadow-sm'
                      : 'text-tg-subtitle-text',
                  ].join(' ')}
                >
                  {l === 'th' ? 'ไทย' : 'English'}
                </button>
              );
            })}
          </div>
        </Card>

        <Card padding="md" className="fade-up">
          <p className="text-xs uppercase tracking-wider text-tg-hint">{t('settings.theme')}</p>
          <p className="mt-2 text-sm text-tg-text">
            {t('settings.theme_auto')}{' '}
            <span className="text-tg-subtitle-text">
              ({colorScheme === 'dark' ? 'dark' : 'light'})
            </span>
          </p>
        </Card>

        <Card padding="md" className="fade-up">
          <p className="text-xs uppercase tracking-wider text-tg-hint">{t('settings.about')}</p>
          <dl className="mt-2 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-tg-subtitle-text">{t('settings.version')}</dt>
              <dd className="font-mono text-tg-text">{APP_VERSION}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-tg-subtitle-text">{t('settings.repo')}</dt>
              <dd>
                <a
                  className="text-tg-link"
                  target="_blank"
                  rel="noopener noreferrer"
                  href="https://github.com/"
                >
                  github
                </a>
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </Layout>
  );
}
