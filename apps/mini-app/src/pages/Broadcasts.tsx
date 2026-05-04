/**
 * VaultLink Mini App — broadcast list.
 *
 * Top-level admin page for the broadcast system. Lists every broadcast
 * the operator can see (founder = system-wide; bot owner = own bots) with
 * status pills, progress bars for in-flight ones, and a tap-through to
 * the detail page. Composer lives at `/admin/broadcasts/new`.
 */

import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ListIcon,
} from '../components/icons.js';
import { apiGet } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatDate } from '../lib/format.js';
import type {
  BroadcastRow,
  BroadcastStatus,
  PageResponse,
} from '../types/api.js';

const PAGE_SIZE = 20;

const ALL_STATUSES: ReadonlyArray<BroadcastStatus | 'all'> = [
  'all',
  'draft',
  'scheduled',
  'sending',
  'completed',
  'cancelled',
  'failed',
] as const;

function statusToneClass(status: BroadcastStatus): string {
  switch (status) {
    case 'draft':
      return 'bg-tg-secondary-bg text-tg-subtitle-text';
    case 'scheduled':
      return 'bg-blue-500/10 text-blue-600 dark:text-blue-400';
    case 'sending':
      return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'completed':
      return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'cancelled':
      return 'bg-tg-secondary-bg text-tg-hint';
    case 'failed':
      return 'bg-tg-destructive-text/10 text-tg-destructive-text';
    default:
      return 'bg-tg-secondary-bg text-tg-subtitle-text';
  }
}

function progressPct(row: BroadcastRow): number {
  if (row.audience_count === 0) return 0;
  const sent = row.count_sent + row.count_failed + row.count_blocked;
  return Math.min(100, Math.round((sent / row.audience_count) * 100));
}

export function Broadcasts(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<BroadcastStatus | 'all'>('all');

  const filterStatus = statusFilter === 'all' ? null : statusFilter;
  const query = useQuery({
    queryKey: qk.broadcasts.list(filterStatus, null, page, PAGE_SIZE),
    queryFn: () => {
      const sp = new URLSearchParams();
      sp.set('limit', String(PAGE_SIZE));
      sp.set('offset', String(page * PAGE_SIZE));
      if (filterStatus) sp.set('status', filterStatus);
      return apiGet<PageResponse<BroadcastRow>>(`/broadcasts?${sp.toString()}`);
    },
    // Keep the list reasonably fresh while the user lingers — sending rows
    // change every few seconds. 4-second poll is the same trade-off the
    // other admin pages use.
    refetchInterval: 4_000,
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const filterChips = useMemo(() => ALL_STATUSES, []);

  return (
    <Layout title={t('broadcast.title')} back={() => navigate(-1)} hideNav>
      <div className="mb-3 flex items-center justify-between gap-2">
        <Link to="/admin/broadcasts/new">
          <Button variant="primary" size="sm">
            {t('broadcast.actions.new')}
          </Button>
        </Link>
        <div className="text-[11px] text-tg-subtitle-text">
          {total} {t('broadcast.total_label')}
        </div>
      </div>

      <div className="mb-3 -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {filterChips.map((s) => {
          const active = statusFilter === s;
          return (
            <button
              key={s}
              type="button"
              onClick={() => {
                setStatusFilter(s);
                setPage(0);
              }}
              className={[
                'press-scale shrink-0 rounded-full px-3 py-1 text-[11px] font-semibold',
                active
                  ? 'bg-gradient-hero text-white shadow-soft'
                  : 'bg-tg-secondary-bg text-tg-subtitle-text',
              ].join(' ')}
            >
              {t(`broadcast.status.${s}`)}
            </button>
          );
        })}
      </div>

      {query.isLoading ? (
        <SkeletonList rows={4} lines={2} />
      ) : query.isError ? (
        <ErrorState
          message={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ListIcon size={48} />}
          title={t('broadcast.empty.title')}
          description={t('broadcast.empty.description')}
        />
      ) : (
        <ul className="space-y-2 stagger">
          {items.map((row) => (
            <li key={row.id} className="animate-fade-up">
              <Link to={`/admin/broadcasts/${row.id}`}>
                <Card interactive padding="sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-tg-text leading-tight">
                        {row.text.slice(0, 80) || t('broadcast.untitled')}
                      </p>
                      <p className="mt-0.5 text-[10px] text-tg-subtitle-text leading-tight">
                        bot #{row.bot_id} · {formatDate(row.created_at, locale)}
                        {row.scheduled_at
                          ? ` · ⏰ ${formatDate(row.scheduled_at, locale)}`
                          : ''}
                      </p>
                    </div>
                    <span
                      className={[
                        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                        statusToneClass(row.status),
                      ].join(' ')}
                    >
                      {t(`broadcast.status.${row.status}`)}
                    </span>
                  </div>
                  {(row.status === 'sending' || row.status === 'completed') &&
                  row.audience_count > 0 ? (
                    <>
                      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-tg-secondary-bg">
                        <div
                          className="h-full bg-gradient-to-r from-brand-violet to-brand-fuchsia transition-all"
                          style={{ width: `${progressPct(row)}%` }}
                        />
                      </div>
                      <p className="mt-1 text-[10px] text-tg-subtitle-text">
                        {row.count_sent} ✓ · {row.count_failed} ✗ · {row.count_blocked} 🚫
                        {' '}/ {row.audience_count}
                      </p>
                    </>
                  ) : null}
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {!query.isLoading && total > PAGE_SIZE ? (
        <div className="mt-3 flex items-center justify-between">
          <Button
            variant="secondary"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            leftIcon={<ChevronLeftIcon size={14} />}
          >
            {t('common.prev')}
          </Button>
          <span className="text-[11px] text-tg-subtitle-text">
            {page + 1} / {lastPage + 1}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= lastPage}
            onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            rightIcon={<ChevronRightIcon size={14} />}
          >
            {t('common.next')}
          </Button>
        </div>
      ) : null}
    </Layout>
  );
}
