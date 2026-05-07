/**
 * VaultLink Mini App — Admin dashboard.
 *
 * Compact fintech-card layout: aurora-mesh hero with a tight 3×2 stat
 * grid + a 1-column shortcut list with small gradient icons. Built for
 * scanability — every actionable surface fits inside one phone-screen
 * height before scroll, including the hero on most viewports.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonCard } from '../components/SkeletonCard.js';
import { apiGet } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT } from '../lib/i18n.js';
import type { AdminStats } from '../types/api.js';
import { adminStatsApi } from '../lib/adminStats.api.js';
import {
  BotsIcon,
  CreditsIcon,
  FilesIcon,
  FlagIcon,
  ListIcon,
  UsersIcon,
  InboxIcon,
} from '../components/icons.js';

interface ShortcutRowProps {
  to: string;
  icon: JSX.Element;
  iconBg: string;
  title: string;
  subtitle?: string;
}

function ShortcutRow({ to, icon, iconBg, title, subtitle }: ShortcutRowProps): JSX.Element {
  return (
    <Link to={to} className="block animate-fade-up">
      <Card interactive padding="sm" className="group">
        <div className="flex items-center gap-2.5">
          <div
            className={[
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-white shadow-soft',
              iconBg,
            ].join(' ')}
          >
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <p className="truncate text-sm font-semibold text-tg-text leading-tight">{title}</p>
            {subtitle ? (
              <p className="truncate text-[11px] text-tg-subtitle-text leading-tight mt-0.5">
                {subtitle}
              </p>
            ) : null}
          </div>
          <span className="text-tg-subtitle-text transition-transform group-active:translate-x-0.5">
            ›
          </span>
        </div>
      </Card>
    </Link>
  );
}

function GlassStat({ label, value }: { label: string; value: number | string }): JSX.Element {
  return (
    <div className="glass-dark rounded-xl px-2.5 py-2">
      <p className="text-[9px] uppercase tracking-wider opacity-75 leading-tight">{label}</p>
      <p className="mt-0.5 text-lg font-bold leading-none">{value}</p>
    </div>
  );
}

/**
 * Tiny inline-SVG sparkline that doesn't pull in a chart library. The
 * Mini App style guide insists on a slim bundle, so the 7-day series is
 * rendered as 7 vertical bars with `currentColor` so dark mode just
 * works.
 */
function Sparkline({
  series,
}: {
  series: ReadonlyArray<{ day: string; credits: number; count: number }>;
}): JSX.Element {
  const max = Math.max(1, ...series.map((d) => d.credits));
  return (
    <svg
      role="img"
      aria-label="7-day topup credits"
      viewBox="0 0 70 22"
      className="h-8 w-full text-tg-link"
      preserveAspectRatio="none"
    >
      {series.map((d, i) => {
        const h = Math.max(1, Math.round((d.credits / max) * 20));
        return (
          <rect
            key={d.day}
            x={i * 10 + 1}
            y={22 - h}
            width={8}
            height={h}
            rx={1.5}
            fill="currentColor"
            opacity={d.credits === 0 ? 0.18 : 0.85}
          />
        );
      })}
    </svg>
  );
}

export function AdminDashboard(): JSX.Element {
  const t = useT();
  const query = useQuery({
    queryKey: qk.admin.stats,
    queryFn: () => apiGet<AdminStats>('/admin/stats'),
    staleTime: 30_000,
  });
  const paymentsQuery = useQuery({
    queryKey: ['admin', 'stats', 'payments'] as const,
    queryFn: () => adminStatsApi.payments(),
    staleTime: 30_000,
  });
  const cryptoQuery = useQuery({
    queryKey: ['admin', 'stats', 'crypto'] as const,
    queryFn: () => adminStatsApi.crypto(),
    staleTime: 30_000,
  });
  const recentQuery = useQuery({
    queryKey: ['admin', 'stats', 'recent'] as const,
    queryFn: () => adminStatsApi.recent(10),
    staleTime: 30_000,
  });

  return (
    <Layout title={t('admin.title')}>
      <div className="space-y-3 stagger">
        {/* Hero — aurora mesh + 3×2 glass stat grid (tight) */}
        <div className="aurora-mesh shine-host relative overflow-hidden rounded-3xl border border-white/15 p-4 text-white shadow-glow animate-fade-up">
          <div className="relative z-[1]">
            <p className="text-[10px] uppercase tracking-[0.18em] opacity-75">
              {t('admin.title')}
            </p>
            <h2 className="mt-0.5 text-lg font-bold leading-tight">
              {t('admin.hero.subtitle')}
            </h2>

            {query.isLoading ? (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <SkeletonCard lines={1} />
                <SkeletonCard lines={1} />
                <SkeletonCard lines={1} />
              </div>
            ) : query.isError ? (
              <div className="mt-3">
                <ErrorState
                  message={query.error instanceof Error ? query.error.message : undefined}
                  onRetry={() => query.refetch()}
                />
              </div>
            ) : (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <GlassStat label={t('admin.stats.users')} value={query.data?.users ?? 0} />
                <GlassStat label={t('admin.stats.files')} value={query.data?.files ?? 0} />
                <GlassStat label={t('admin.stats.bots')} value={query.data?.bots ?? 0} />
                <GlassStat
                  label={t('admin.stats.downloads')}
                  value={query.data?.downloads ?? 0}
                />
                <GlassStat
                  label={t('admin.stats.pending_reports')}
                  value={query.data?.pendingReports ?? 0}
                />
                <GlassStat
                  label={t('admin.stats.active_files')}
                  value={query.data?.activeFiles ?? query.data?.files ?? 0}
                />
              </div>
            )}
          </div>
          <span className="shine-overlay" />
        </div>

        {/* Drill-downs — 1-column compact rows */}
        <div className="grid grid-cols-1 gap-2">
          <ShortcutRow
            to="/admin/files"
            icon={<FilesIcon size={18} />}
            iconBg="bg-gradient-to-br from-brand-indigo to-brand-violet"
            title={t('admin.shortcuts.all_files')}
            subtitle={t('admin.shortcuts.all_files_subtitle')}
          />
          <ShortcutRow
            to="/admin/users"
            icon={<UsersIcon size={18} />}
            iconBg="bg-gradient-to-br from-brand-cyan to-brand-teal"
            title={t('admin.shortcuts.all_users')}
            subtitle={t('admin.shortcuts.all_users_subtitle')}
          />
          <ShortcutRow
            to="/admin/reports"
            icon={<FlagIcon size={18} />}
            iconBg="bg-gradient-to-br from-brand-fuchsia to-brand-pink"
            title={t('admin.shortcuts.reports')}
            subtitle={t('admin.stats.pending_reports')}
          />
          <ShortcutRow
            to="/admin/broadcasts"
            icon={<InboxIcon size={18} />}
            iconBg="bg-gradient-to-br from-brand-violet to-brand-pink"
            title={t('admin.shortcuts.broadcasts')}
            subtitle={t('admin.shortcuts.broadcasts_subtitle')}
          />
          <ShortcutRow
            to="/admin/audit"
            icon={<ListIcon size={18} />}
            iconBg="bg-gradient-to-br from-brand-amber to-brand-pink"
            title={t('admin.shortcuts.audit')}
            subtitle={t('admin.shortcuts.audit_subtitle')}
          />
          <ShortcutRow
            to="/bots"
            icon={<BotsIcon size={18} />}
            iconBg="bg-gradient-to-br from-brand-violet to-brand-fuchsia"
            title={t('admin.shortcuts.bots')}
            subtitle={t('admin.shortcuts.bots_subtitle')}
          />
          <ShortcutRow
            to="/admin/credits"
            icon={<CreditsIcon size={18} />}
            iconBg="bg-gradient-to-br from-brand-cyan to-brand-violet"
            title={t('admin_credits.shortcut')}
          />
          <ShortcutRow
            to="/admin/crypto"
            icon={<CreditsIcon size={18} />}
            iconBg="bg-gradient-to-br from-brand-amber to-brand-fuchsia"
            title={t('admin_credits.crypto_shortcut')}
          />
        </div>

        {/* Revenue card — Stars/credit funnel + 7-day sparkline */}
        {paymentsQuery.data && (
          <Card padding="md" className="fade-up">
            <div className="flex items-center justify-between">
              <p className="text-xs uppercase tracking-wider text-tg-hint">
                {t('admin.revenue.title')}
              </p>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-[11px] text-tg-subtitle-text">
                  {t('admin.revenue.lifetime_credits')}
                </p>
                <p className="text-lg font-bold tabular-nums text-tg-text">
                  +{paymentsQuery.data.topup.lifetimeCredits}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-tg-subtitle-text">
                  {t('admin.revenue.refunds')}
                </p>
                <p className="text-lg font-bold tabular-nums text-tg-destructive-text">
                  −{paymentsQuery.data.refunds.lifetimeCreditsClawedBack}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-tg-subtitle-text">
                  {t('admin.revenue.last7d_credits')}
                </p>
                <p className="text-base font-semibold tabular-nums text-tg-text">
                  +{paymentsQuery.data.topup.last7dCredits}
                </p>
              </div>
              <div>
                <p className="text-[11px] text-tg-subtitle-text">
                  {t('admin.revenue.last7d_refunds')}
                </p>
                <p className="text-base font-semibold tabular-nums text-tg-text">
                  {paymentsQuery.data.refunds.last7dCount}
                </p>
              </div>
            </div>
            <div className="mt-3">
              <Sparkline series={paymentsQuery.data.series} />
            </div>
          </Card>
        )}

        {/* Health card — operator-relevant lifecycle counters */}
        {(query.data || cryptoQuery.data) && (
          <Card padding="md" className="fade-up">
            <p className="text-xs uppercase tracking-wider text-tg-hint">
              {t('admin.health.title')}
            </p>
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div className="flex justify-between">
                <span className="text-tg-subtitle-text">{t('admin.health.banned_users')}</span>
                <span className="font-semibold tabular-nums">
                  {query.data?.bannedUsers ?? 0}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-tg-subtitle-text">{t('admin.health.super_admins')}</span>
                <span className="font-semibold tabular-nums">
                  {query.data?.superAdmins ?? 0}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-tg-subtitle-text">
                  {t('admin.health.spend_locked')}
                </span>
                <span className="font-semibold tabular-nums">
                  {query.data?.spendLockedUsers ?? 0}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-tg-subtitle-text">
                  {t('admin.health.pending_crypto')}
                </span>
                <span className="font-semibold tabular-nums">
                  {query.data?.pendingCryptoInvoices ?? cryptoQuery.data?.pending ?? 0}
                </span>
              </div>
            </div>
          </Card>
        )}

        {/* Recent activity */}
        {recentQuery.data && recentQuery.data.items.length > 0 && (
          <Card padding="md" className="fade-up">
            <p className="text-xs uppercase tracking-wider text-tg-hint">
              {t('admin.recent.title')}
            </p>
            <ul className="mt-2 divide-y divide-black/5 dark:divide-white/5">
              {recentQuery.data.items.slice(0, 8).map((row) => (
                <li
                  key={row.id}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-tg-text">{row.action}</p>
                    <p className="truncate text-[11px] text-tg-subtitle-text">
                      {row.actor?.username
                        ? `@${row.actor.username}`
                        : (row.actor?.first_name ?? '—')}
                    </p>
                  </div>
                  <p className="ml-2 shrink-0 text-[11px] text-tg-subtitle-text tabular-nums">
                    {row.created_at.replace('T', ' ').slice(5, 16)}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </Layout>
  );
}
