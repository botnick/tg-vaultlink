/**
 * VaultLink Mini App — Home dashboard.
 *
 * Greeting card + quick stats + shortcut tiles to the main sections.
 * Stats come from `/files?limit=1` and `/bots?limit=1` so we get the
 * `total` count cheaply without fetching list bodies.
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
      <div className="space-y-4">
        <Card padding="md" className="fade-up bg-gradient-to-br from-tg-button to-tg-link text-tg-button-text">
          <p className="text-xs uppercase tracking-wider opacity-80">VaultLink</p>
          <h2 className="mt-1 text-xl font-semibold">
            {greetingName
              ? t('home.greeting_with_name', { name: greetingName })
              : t('home.greeting')}
          </h2>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-white/10 p-3 backdrop-blur-sm">
              <p className="text-xs opacity-80">{t('home.stats.files')}</p>
              <p className="mt-1 text-2xl font-semibold">{fileCount}</p>
            </div>
            <div className="rounded-2xl bg-white/10 p-3 backdrop-blur-sm">
              <p className="text-xs opacity-80">{t('home.stats.bots')}</p>
              <p className="mt-1 text-2xl font-semibold">{botCount}</p>
            </div>
          </div>
        </Card>

        <div className="grid grid-cols-1 gap-3">
          <Link to="/files" className="fade-up block">
            <Card interactive padding="md">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-tg-secondary-bg text-tg-link">
                  <FilesIcon size={22} />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-tg-text">{t('nav.files')}</p>
                  <p className="text-xs text-tg-subtitle-text">{t('home.shortcuts.files')}</p>
                </div>
              </div>
            </Card>
          </Link>
          <Link to="/bots" className="fade-up block">
            <Card interactive padding="md">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-tg-secondary-bg text-tg-link">
                  <BotsIcon size={22} />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-tg-text">{t('nav.bots')}</p>
                  <p className="text-xs text-tg-subtitle-text">{t('home.shortcuts.bots')}</p>
                </div>
              </div>
            </Card>
          </Link>
          <Link to="/settings" className="fade-up block">
            <Card interactive padding="md">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-tg-secondary-bg text-tg-link">
                  <SettingsIcon size={22} />
                </div>
                <div className="flex-1">
                  <p className="font-semibold text-tg-text">{t('nav.settings')}</p>
                  <p className="text-xs text-tg-subtitle-text">{t('home.shortcuts.settings')}</p>
                </div>
              </div>
            </Card>
          </Link>
          {isAdmin ? (
            <Link to="/admin" className="fade-up block">
              <Card interactive padding="md">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-tg-secondary-bg text-tg-accent-text">
                    <AdminIcon size={22} />
                  </div>
                  <div className="flex-1">
                    <p className="font-semibold text-tg-text">{t('nav.admin')}</p>
                    <p className="text-xs text-tg-subtitle-text">{t('home.shortcuts.admin')}</p>
                  </div>
                </div>
              </Card>
            </Link>
          ) : null}
        </div>
      </div>
    </Layout>
  );
}
