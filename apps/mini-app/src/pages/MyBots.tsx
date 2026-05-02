/**
 * VaultLink Mini App — bot list.
 *
 * The owner-scoped backend doesn't currently paginate, so we render
 * everything we get back. The "add bot" CTA is informational — the
 * actual flow lives in the bot itself (`/add_bot <token>`).
 */

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { BotsIcon } from '../components/icons.js';
import { apiGet } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT } from '../lib/i18n.js';
import type { BotSummary, PageResponse } from '../types/api.js';

function modeBadge(mode: BotSummary['mode'], t: (k: string) => string): JSX.Element {
  if (mode === 'personal_public') {
    return <StatusBadge tone="success">{t('bot_detail.mode.public')}</StatusBadge>;
  }
  return <StatusBadge tone="info">{t('bot_detail.mode.private')}</StatusBadge>;
}

function statusBadge(status: BotSummary['status']): JSX.Element {
  switch (status) {
    case 'active':
      return <StatusBadge tone="success">active</StatusBadge>;
    case 'errored':
      return <StatusBadge tone="danger">errored</StatusBadge>;
    case 'disabled':
    default:
      return <StatusBadge tone="neutral">{status}</StatusBadge>;
  }
}

export function MyBots(): JSX.Element {
  const t = useT();
  const query = useQuery({
    queryKey: qk.bots.list(0, 100),
    queryFn: () => apiGet<PageResponse<BotSummary>>('/bots'),
  });

  const items = query.data?.items ?? [];

  return (
    <Layout title={t('bots.title')}>
      <Card padding="md" className="mb-4 border-dashed bg-tg-secondary-bg/60 fade-up">
        <p className="text-sm text-tg-subtitle-text">{t('bots.add_hint')}</p>
      </Card>

      {query.isLoading ? (
        <SkeletonList rows={3} />
      ) : query.isError ? (
        <ErrorState
          message={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<BotsIcon size={48} />}
          title={t('bots.empty.title')}
          description={t('bots.empty.description')}
        />
      ) : (
        <ul className="space-y-3">
          {items.map((b, idx) => (
            <li key={b.id} className="fade-up" style={{ animationDelay: `${Math.min(idx, 8) * 18}ms` }}>
              <Link to={`/bots/${b.id}`}>
                <Card interactive padding="md">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-tg-secondary-bg text-tg-link">
                      <BotsIcon size={22} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-tg-text">@{b.username}</p>
                      {b.display_name ? (
                        <p className="truncate text-xs text-tg-subtitle-text">{b.display_name}</p>
                      ) : null}
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {modeBadge(b.mode, t)}
                        {statusBadge(b.status)}
                      </div>
                    </div>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}
