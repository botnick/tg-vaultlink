/**
 * VaultLink Mini App — Credits page.
 *
 * Three sections:
 *   1. Balance card (large number + lifetime aggregates)
 *   2. Top-up CTAs (Stars + Crypto, surfaced only when each is enabled)
 *   3. Recent activity (paginated ledger)
 *
 * Stays out of the way when `ENABLE_CREDITS=false`: shows a single
 * "system off" banner and no other affordances.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { useT } from '../lib/i18n.js';
import { qk } from '../lib/queryKeys.js';
import { creditsApi } from '../lib/credits.api.js';
import type { CreditTxRow } from '../lib/credits.api.js';
import { hapticNotify, openInvoice, showAlert } from '../lib/telegram.js';
import { ApiError } from '../types/api.js';

export function Credits(): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [packagePickerOpen, setPackagePickerOpen] = useState(false);

  const summaryQuery = useQuery({
    queryKey: qk.credits.summary,
    queryFn: () => creditsApi.summary(),
    staleTime: 15_000,
  });

  const historyQuery = useQuery({
    queryKey: qk.credits.history(0),
    queryFn: () => creditsApi.history(0, 30),
    staleTime: 15_000,
  });

  /** Wave 9.2 — Stars in-app top-up flow.
   *
   * 1. POST /credits/stars/invoice → server builds invoice link.
   * 2. Telegram.WebApp.openInvoice() → native payment sheet.
   * 3. On 'paid' callback: invalidate summary + history so the new
   *    balance shows up after the bot's successful_payment handler runs.
   */
  const starsMutation = useMutation({
    mutationFn: async (packageIndex: number) => {
      const res = await creditsApi.createStarsInvoice(packageIndex);
      const status = await openInvoice(res.invoiceLink);
      return { status, ...res };
    },
    onSuccess: async (res) => {
      setPackagePickerOpen(false);
      if (res.status === 'paid') {
        hapticNotify('success');
        // Refresh after a brief delay to give the bot's
        // `successful_payment` handler time to apply the topup ledger.
        await new Promise((r) => setTimeout(r, 800));
        await qc.invalidateQueries({ queryKey: qk.credits.summary });
        await qc.invalidateQueries({ queryKey: qk.credits.history(0) });
      } else if (res.status === 'unsupported') {
        await showAlert(t('credits.topup.unsupported'));
      } else if (res.status === 'failed') {
        hapticNotify('error');
        await showAlert(t('credits.topup.failed_alert'));
      }
      // 'cancelled' / 'pending' — silent.
    },
    onError: async (err) => {
      hapticNotify('error');
      const msg = err instanceof ApiError ? err.message : String(err);
      await showAlert(msg);
    },
  });

  if (summaryQuery.isLoading) {
    return (
      <Layout title={t('credits.title')}>
        <SkeletonList rows={4} />
      </Layout>
    );
  }
  if (summaryQuery.isError) {
    return (
      <Layout title={t('credits.title')}>
        <ErrorState message={String(summaryQuery.error)} onRetry={() => summaryQuery.refetch()} />
      </Layout>
    );
  }

  const s = summaryQuery.data;
  if (!s) {
    return <Layout title={t('credits.title')}>{null}</Layout>;
  }

  if (!s.enabled) {
    return (
      <Layout title={t('credits.title')}>
        <Card padding="md" className="fade-up">
          <p className="text-sm text-tg-text">{t('credits.disabled')}</p>
        </Card>
      </Layout>
    );
  }

  // Spend-lock banner state — when the server says spending is locked,
  // surface the unlock countdown prominently above the balance card.
  const lockedUntilMs =
    s.spendLockedUntil === null ? 0 : Date.parse(s.spendLockedUntil);
  const isLocked = Number.isFinite(lockedUntilMs) && lockedUntilMs > Date.now();

  return (
    <Layout title={t('credits.title')}>
      <div className="space-y-4">
        {/* Spend-lock banner (Wave 9.2) */}
        {isLocked && (
          <Card padding="md" className="fade-up border border-tg-destructive-text/40">
            <p className="text-xs uppercase tracking-wider text-tg-destructive-text">
              {t('credits.lock.title')}
            </p>
            <p className="mt-2 text-sm text-tg-text">
              {t('credits.lock.body', {
                until: new Date(lockedUntilMs).toLocaleString(),
              })}
            </p>
            <p className="mt-1 text-xs text-tg-subtitle-text">
              {t('credits.lock.hint')}
            </p>
          </Card>
        )}

        {/* Balance card */}
        <Card padding="lg" variant="gradient" accentGlow="cyan" className="fade-up text-white">
          <p className="text-xs uppercase tracking-wider opacity-80">{t('credits.balance')}</p>
          <p className="mt-2 text-5xl font-bold tabular-nums">{s.balance}</p>
          <div className="mt-4 grid grid-cols-2 gap-3 text-sm opacity-90">
            <div>
              <p className="text-xs opacity-80">{t('credits.lifetime.gained')}</p>
              <p className="font-semibold tabular-nums">+{s.lifetime.gained}</p>
            </div>
            <div>
              <p className="text-xs opacity-80">{t('credits.lifetime.spent')}</p>
              <p className="font-semibold tabular-nums">−{s.lifetime.spent}</p>
            </div>
          </div>
        </Card>

        {/* Top-up CTAs */}
        {(s.topupEnabled || s.cryptoEnabled) && (
          <Card padding="md" className="fade-up">
            <p className="text-xs uppercase tracking-wider text-tg-hint">
              {t('credits.section.topup')}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {s.topupEnabled && s.packages.length > 0 && (
                <Button
                  block
                  variant="primary"
                  onClick={() => setPackagePickerOpen(true)}
                  disabled={starsMutation.isPending}
                >
                  {t('credits.button.topup_stars')}
                </Button>
              )}
              {s.cryptoEnabled && s.cryptoChainsAvailable > 0 && (
                <Button
                  block
                  variant="solid"
                  onClick={() => navigate('/credits/crypto')}
                >
                  {t('credits.button.topup_crypto')}
                </Button>
              )}
            </div>
          </Card>
        )}

        {/* Stars package picker (modal sheet) */}
        {packagePickerOpen && (
          <Card padding="md" className="fade-up">
            <p className="text-xs uppercase tracking-wider text-tg-hint">
              {t('credits.topup.choose_package')}
            </p>
            <div className="mt-3 flex flex-col gap-2">
              {s.packages.map((pkg, i) => (
                <Button
                  key={`${pkg.stars}-${pkg.credits}`}
                  block
                  variant="secondary"
                  loading={starsMutation.isPending && starsMutation.variables === i}
                  disabled={starsMutation.isPending}
                  onClick={() => starsMutation.mutate(i)}
                >
                  {t('credits.topup.package_label', {
                    credits: pkg.credits,
                    stars: pkg.stars,
                  })}
                </Button>
              ))}
              <Button
                block
                variant="ghost"
                onClick={() => setPackagePickerOpen(false)}
                disabled={starsMutation.isPending}
              >
                {t('credits.button.back')}
              </Button>
            </div>
          </Card>
        )}

        {/* Referral */}
        {s.referralEnabled && s.referralReward > 0 && (
          <Card padding="md" className="fade-up">
            <p className="text-xs uppercase tracking-wider text-tg-hint">
              {t('credits.button.invite_friends')}
            </p>
            <p className="mt-2 text-sm text-tg-text">
              {t('credits.invite_hint', { reward: s.referralReward })}
            </p>
            {s.referralDailyCap > 0 && (
              <p className="mt-1 text-xs text-tg-subtitle-text">
                {t('credits.referral_cap_hint', { cap: s.referralDailyCap })}
              </p>
            )}
          </Card>
        )}

        {/* History */}
        <Card padding="md" className="fade-up">
          <p className="text-xs uppercase tracking-wider text-tg-hint">
            {t('credits.section.history')}
          </p>
          {historyQuery.isLoading ? (
            <div className="mt-3">
              <SkeletonList rows={3} />
            </div>
          ) : historyQuery.data && historyQuery.data.items.length > 0 ? (
            <ul className="mt-2 divide-y divide-black/5 dark:divide-white/5">
              {historyQuery.data.items.map((row) => (
                <HistoryRow key={row.id} row={row} t={t} />
              ))}
            </ul>
          ) : (
            <div className="mt-3">
              <EmptyState title={t('credits.history.empty')} />
            </div>
          )}
        </Card>
      </div>
    </Layout>
  );
}

function HistoryRow({
  row,
  t,
}: {
  row: CreditTxRow;
  t: (key: string, params?: Record<string, string | number>) => string;
}): JSX.Element {
  const sign = row.delta >= 0 ? '+' : '−';
  const abs = Math.abs(row.delta);
  const reasonKey = `credits.history.reason.${row.reason}`;
  const reasonLabel = t(reasonKey);
  const date = row.created_at.replace('T', ' ').slice(0, 16);
  const isCredit = row.delta >= 0;
  return (
    <li className="flex items-center justify-between py-2 text-sm">
      <div>
        <p className="font-medium text-tg-text">{reasonLabel}</p>
        <p className="text-xs text-tg-subtitle-text tabular-nums">{date}</p>
      </div>
      <div className="text-right">
        <p
          className={[
            'font-semibold tabular-nums',
            isCredit ? 'text-emerald-500' : 'text-tg-destructive-text',
          ].join(' ')}
        >
          {sign}
          {abs}
        </p>
        <p className="text-xs text-tg-subtitle-text tabular-nums">bal: {row.balance_after}</p>
      </div>
    </li>
  );
}
