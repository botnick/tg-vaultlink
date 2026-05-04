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
import {
  BotsIcon,
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

export function AdminDashboard(): JSX.Element {
  const t = useT();
  const query = useQuery({
    queryKey: qk.admin.stats,
    queryFn: () => apiGet<AdminStats>('/admin/stats'),
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
        </div>
      </div>
    </Layout>
  );
}
