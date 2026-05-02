/**
 * VaultLink Mini App — Admin dashboard.
 *
 * Stats tiles + shortcut cards. Gated by `<RequireAdmin>` at the
 * router level; the API also re-checks `is_admin` on every request.
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
import { BotsIcon, FlagIcon, ListIcon } from '../components/icons.js';

function StatTile({ label, value }: { label: string; value: number | string }): JSX.Element {
  return (
    <div className="rounded-2xl bg-tg-section-bg p-4 shadow-sm border border-black/[0.04] dark:border-white/[0.06]">
      <p className="text-xs uppercase tracking-wider text-tg-hint">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-tg-text">{value}</p>
    </div>
  );
}

export function AdminDashboard(): JSX.Element {
  const t = useT();
  const query = useQuery({
    queryKey: qk.admin.stats,
    queryFn: () => apiGet<AdminStats>('/admin/stats'),
  });

  return (
    <Layout title={t('admin.title')}>
      <div className="space-y-4">
        {query.isLoading ? (
          <div className="grid grid-cols-2 gap-3">
            <SkeletonCard lines={1} />
            <SkeletonCard lines={1} />
            <SkeletonCard lines={1} />
            <SkeletonCard lines={1} />
          </div>
        ) : query.isError ? (
          <ErrorState
            message={query.error instanceof Error ? query.error.message : undefined}
            onRetry={() => query.refetch()}
          />
        ) : (
          <div className="grid grid-cols-2 gap-3 fade-up">
            <StatTile label={t('admin.stats.users')} value={query.data?.users ?? 0} />
            <StatTile label={t('admin.stats.bots')} value={query.data?.bots ?? 0} />
            <StatTile label={t('admin.stats.files')} value={query.data?.files ?? 0} />
            <StatTile label={t('admin.stats.downloads')} value={query.data?.downloads ?? 0} />
            <StatTile
              label={t('admin.stats.pending_reports')}
              value={query.data?.pendingReports ?? 0}
            />
          </div>
        )}

        <Link to="/admin/reports" className="block fade-up">
          <Card interactive padding="md">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-tg-secondary-bg text-tg-destructive-text">
                <FlagIcon size={22} />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-tg-text">{t('admin.shortcuts.reports')}</p>
                <p className="text-xs text-tg-subtitle-text">{t('admin.stats.pending_reports')}</p>
              </div>
            </div>
          </Card>
        </Link>
        <Link to="/admin/audit" className="block fade-up">
          <Card interactive padding="md">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-tg-secondary-bg text-tg-link">
                <ListIcon size={22} />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-tg-text">{t('admin.shortcuts.audit')}</p>
              </div>
            </div>
          </Card>
        </Link>
        <Link to="/bots" className="block fade-up">
          <Card interactive padding="md">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-tg-secondary-bg text-tg-accent-text">
                <BotsIcon size={22} />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-tg-text">{t('admin.shortcuts.bots')}</p>
              </div>
            </div>
          </Card>
        </Link>
      </div>
    </Layout>
  );
}
