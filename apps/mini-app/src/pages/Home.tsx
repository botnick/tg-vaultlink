/**
 * VaultLink Mini App — Home dashboard.
 *
 * Fintech-card-inspired layout:
 *   - Hero card: aurora-mesh background, slowly drifts; one-shot shine
 *     sweep on first paint. Inside, big gradient-tinted glass tiles show
 *     the file / bot counters — the "balance" of the wallet.
 *   - Action grid: rounded glass cards with gradient icon bubbles. Each
 *     card uses a different brand gradient so the row reads as a
 *     deliberate palette, not random badges.
 *   - Stagger animation: rows fade-up with cascading delays.
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { useAuth } from '../providers/AuthProvider.js';
import { useT } from '../lib/i18n.js';
import { apiGet } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import type { BotSummary, FileSummary, PageResponse } from '../types/api.js';
import { AdminIcon, BotsIcon, FilesIcon, SettingsIcon } from '../components/icons.js';

interface ShortcutTileProps {
  to: string;
  icon: JSX.Element;
  iconBg: string;
  title: string;
  subtitle: string;
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
          <div className="flex-1">
            <p className="font-semibold text-tg-text">{title}</p>
            <p className="text-xs text-tg-subtitle-text">{subtitle}</p>
          </div>
          <span className="text-tg-subtitle-text transition-transform group-active:translate-x-0.5">
            ›
          </span>
        </div>
      </Card>
    </Link>
  );
}

export function Home(): JSX.Element {
  const t = useT();
  const { user, isAdmin } = useAuth();

  const filesQuery = useQuery({
    queryKey: qk.files.list(0, 1),
    queryFn: () => apiGet<PageResponse<FileSummary>>('/files?limit=1'),
  });
  const botsQuery = useQuery({
    queryKey: qk.bots.list(0, 1),
    queryFn: () => apiGet<PageResponse<BotSummary>>('/bots?limit=1'),
  });

  const fileCount = filesQuery.data?.total ?? filesQuery.data?.items.length ?? 0;
  const botCount = botsQuery.data?.total ?? botsQuery.data?.items.length ?? 0;
  const greetingName = user?.first_name ?? user?.username ?? null;

  return (
    <Layout title="VaultLink">
      <div className="space-y-5 stagger">
        {/* Hero card — aurora mesh + glass stat tiles + shine sweep */}
        <div className="aurora-mesh shine-host relative overflow-hidden rounded-4xl border border-white/15 p-5 text-white shadow-glow animate-fade-up">
          <div className="relative z-[1]">
            <p className="text-[11px] uppercase tracking-[0.2em] opacity-75">VaultLink</p>
            <h2 className="mt-1 text-2xl font-bold leading-tight">
              {greetingName
                ? t('home.greeting_with_name', { name: greetingName })
                : t('home.greeting')}
            </h2>

            <div className="mt-5 grid grid-cols-2 gap-3">
              <div className="glass-dark rounded-2xl p-4">
                <p className="text-[11px] uppercase tracking-wider opacity-75">
                  {t('home.stats.files')}
                </p>
                <p className="mt-1.5 text-3xl font-bold">{fileCount}</p>
              </div>
              <div className="glass-dark rounded-2xl p-4">
                <p className="text-[11px] uppercase tracking-wider opacity-75">
                  {t('home.stats.bots')}
                </p>
                <p className="mt-1.5 text-3xl font-bold">{botCount}</p>
              </div>
            </div>
          </div>
          <span className="shine-overlay" />
        </div>

        {/* Action grid */}
        <div className="grid grid-cols-1 gap-3">
          <ShortcutTile
            to="/files"
            icon={<FilesIcon size={22} />}
            iconBg="bg-gradient-to-br from-brand-indigo to-brand-violet"
            title={t('nav.files')}
            subtitle={t('home.shortcuts.files')}
          />
          <ShortcutTile
            to="/bots"
            icon={<BotsIcon size={22} />}
            iconBg="bg-gradient-to-br from-brand-cyan to-brand-teal"
            title={t('nav.bots')}
            subtitle={t('home.shortcuts.bots')}
          />
          <ShortcutTile
            to="/settings"
            icon={<SettingsIcon size={22} />}
            iconBg="bg-gradient-to-br from-brand-amber to-brand-pink"
            title={t('nav.settings')}
            subtitle={t('home.shortcuts.settings')}
          />
          {isAdmin ? (
            <ShortcutTile
              to="/admin"
              icon={<AdminIcon size={22} />}
              iconBg="bg-gradient-to-br from-brand-fuchsia to-brand-pink"
              title={t('nav.admin')}
              subtitle={t('home.shortcuts.admin')}
            />
          ) : null}
        </div>
      </div>
    </Layout>
  );
}
