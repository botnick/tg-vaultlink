/**
 * VaultLink Mini App — Admin dashboard.
 *
 * Top stats hero + system-wide drill-downs (all files, all users, every
 * bot, audit log, reports). Gated by `<RequireAdmin>` at the router
 * level; the API re-checks `is_admin` on every request.
 *
 * Adopts the same fintech-card aesthetic as Home: aurora-mesh hero with
 * glassmorphism stat tiles, plus a coloured shortcut grid using the
 * brand gradients so each section has a recognisable accent.
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
} from '../components/icons.js';

interface ShortcutTileProps {
  to: string;
  icon: JSX.Element;
  iconBg: string;
  title: string;
  subtitle?: string;
}

function ShortcutTile({ to, icon, iconBg, title, subtitle }: ShortcutTileProps): JSX.Element {
  return (
    <Link to={to} className="block animate-fade-up">
      <Card interactive padding="md" className="group">
        <div className="flex items-center gap-3">
          <div
            className={[
              'flex h-12 w-12 items-center justify-center rounded-2xl text-white shadow-soft',
              iconBg,
            ].join(' ')}
          >
            {icon}
          </div>
          <div className="flex-1 min-w-0">
            <p className="font-semibold text-tg-text">{title}</p>
            {subtitle ? (
              <p className="truncate text-xs text-tg-subtitle-text">{subtitle}</p>
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

interface GlassStatProps {
  label: string;
  value: number | string;
}

function GlassStat({ label, value }: GlassStatProps): JSX.Element {
  return (
    <div className="glass-dark rounded-2xl p-4">
      <p className="text-[11px] uppercase tracking-wider opacity-75">{label}</p>
      <p className="mt-1 text-2xl font-bold">{value}</p>
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
      <div className="space-y-5 stagger">
        {/* Hero — aurora mesh + glass stat tiles */}
        <div className="aurora-mesh shine-host relative overflow-hidden rounded-4xl border border-white/15 p-5 text-white shadow-glow animate-fade-up">
          <div className="relative z-[1]">
            <p className="text-[11px] uppercase tracking-[0.2em] opacity-75">
              {t('admin.title')}
            </p>
            <h2 className="mt-1 text-2xl font-bold leading-tight">
              {t('admin.hero.subtitle')}
            </h2>

            {query.isLoading ? (
              <div className="mt-5 grid grid-cols-3 gap-3">
                <SkeletonCard lines={1} />
                <SkeletonCard lines={1} />
                <SkeletonCard lines={1} />
              </div>
            ) : query.isError ? (
              <div className="mt-5">
                <ErrorState
                  message={query.error instanceof Error ? query.error.message : undefined}
                  onRetry={() => query.refetch()}
                />
              </div>
            ) : (
              <div className="mt-5 grid grid-cols-3 gap-3">
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

        {/* Drill-downs */}
        <div className="grid grid-cols-1 gap-3">
          <ShortcutTile
            to="/admin/files"
            icon={<FilesIcon size={22} />}
            iconBg="bg-gradient-to-br from-brand-indigo to-brand-violet"
            title={t('admin.shortcuts.all_files')}
            subtitle={t('admin.shortcuts.all_files_subtitle')}
          />
          <ShortcutTile
            to="/admin/users"
            icon={<UsersIcon size={22} />}
            iconBg="bg-gradient-to-br from-brand-cyan to-brand-teal"
            title={t('admin.shortcuts.all_users')}
            subtitle={t('admin.shortcuts.all_users_subtitle')}
          />
          <ShortcutTile
            to="/admin/reports"
            icon={<FlagIcon size={22} />}
            iconBg="bg-gradient-to-br from-brand-fuchsia to-brand-pink"
            title={t('admin.shortcuts.reports')}
            subtitle={t('admin.stats.pending_reports')}
          />
          <ShortcutTile
            to="/admin/audit"
            icon={<ListIcon size={22} />}
            iconBg="bg-gradient-to-br from-brand-amber to-brand-pink"
            title={t('admin.shortcuts.audit')}
            subtitle={t('admin.shortcuts.audit_subtitle')}
          />
          <ShortcutTile
            to="/bots"
            icon={<BotsIcon size={22} />}
            iconBg="bg-gradient-to-br from-brand-violet to-brand-fuchsia"
            title={t('admin.shortcuts.bots')}
            subtitle={t('admin.shortcuts.bots_subtitle')}
          />
        </div>
      </div>
    </Layout>
  );
}
