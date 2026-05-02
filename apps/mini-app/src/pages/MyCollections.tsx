/**
 * VaultLink Mini App — collections list.
 *
 * Mirrors `MyFiles` for consistency: server-side pagination + a
 * client-side search that filters the current page only. The two are
 * different enough on the backend to warrant separate routes, but we
 * keep the visual + navigation language identical so the user doesn't
 * have to re-learn anything when switching tabs.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { StatusBadge } from '../components/StatusBadge.js';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FilesIcon,
  ListIcon,
  LockIcon,
  SearchIcon,
} from '../components/icons.js';
import { apiGet } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatDate } from '../lib/format.js';
import { hapticImpact } from '../lib/telegram.js';
import type { CollectionSummary, PageResponse } from '../types/api.js';

const PAGE_SIZE = 20;

function collectionLabel(c: CollectionSummary, untitledLabel: string): string {
  if (c.title && c.title.trim().length > 0) return c.title;
  return untitledLabel;
}

export function MyCollections(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');

  const query = useQuery({
    queryKey: qk.collections.list(page, PAGE_SIZE),
    queryFn: () =>
      apiGet<PageResponse<CollectionSummary>>(
        `/collections?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);
  const untitled = t('collections.untitled');

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return items;
    return items.filter((c) => {
      const label = collectionLabel(c, untitled).toLowerCase();
      return label.includes(s) || c.code.toLowerCase().includes(s);
    });
  }, [items, search, untitled]);

  return (
    <Layout title={t('collections.title')}>
      <div
        className="mb-3 flex gap-1 rounded-full bg-tg-secondary-bg p-1"
        role="tablist"
        aria-label={t('collections.title')}
      >
        <button
          type="button"
          role="tab"
          aria-selected="false"
          onClick={() => {
            hapticImpact('light');
            navigate('/files');
          }}
          className="press-scale inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-transparent text-sm font-medium text-tg-subtitle-text"
        >
          <FilesIcon size={16} />
          <span>{t('files.tabs.files')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="true"
          className="press-scale inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-tg-button text-sm font-medium text-tg-button-text"
        >
          <ListIcon size={16} />
          <span>{t('files.tabs.collections')}</span>
        </button>
      </div>

      <div className="mb-3">
        <label className="relative block">
          <span className="sr-only">{t('collections.search_placeholder')}</span>
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tg-hint">
            <SearchIcon size={18} />
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('collections.search_placeholder')}
            className="h-11 w-full rounded-2xl border border-black/10 bg-tg-secondary-bg pl-9 pr-3 text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
          />
        </label>
      </div>

      {query.isLoading ? (
        <SkeletonList rows={5} />
      ) : query.isError ? (
        <ErrorState
          {...(query.error instanceof Error ? { message: query.error.message } : {})}
          onRetry={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ListIcon size={48} />}
          title={t('collections.empty.title')}
          description={t('collections.empty.description')}
        />
      ) : (
        <ul className="space-y-3">
          {filtered.map((c, idx) => (
            <li
              key={c.id}
              className="fade-up"
              style={{ animationDelay: `${Math.min(idx, 8) * 18}ms` }}
            >
              <Link to={`/collections/${c.id}`} onClick={() => hapticImpact('light')}>
                <Card interactive padding="md">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-tg-secondary-bg text-tg-link">
                      <ListIcon size={22} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-semibold text-tg-text">
                          {collectionLabel(c, untitled)}
                        </p>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-tg-subtitle-text">
                        <code className="font-mono">{c.code}</code>
                        {' · '}
                        {c.total_items} {t('collections.items_count')}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {c.has_password ? (
                          <StatusBadge tone="info" icon={<LockIcon size={12} />}>
                            {t('collections.has_password')}
                          </StatusBadge>
                        ) : null}
                        {c.is_locked ? (
                          <StatusBadge tone="danger">{t('collections.locked')}</StatusBadge>
                        ) : null}
                        <StatusBadge tone="neutral">
                          {c.visibility === 'public'
                            ? t('collections.public')
                            : t('collections.private')}
                        </StatusBadge>
                        <StatusBadge tone="neutral">
                          {t('collections.created_at')} · {formatDate(c.created_at, locale)}
                        </StatusBadge>
                      </div>
                    </div>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {!query.isLoading && total > PAGE_SIZE ? (
        <div className="mt-4 flex items-center justify-between">
          <Button
            variant="secondary"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            leftIcon={<ChevronLeftIcon size={16} />}
          >
            {t('common.prev')}
          </Button>
          <span className="text-xs text-tg-subtitle-text">
            {page + 1} / {lastPage + 1}
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={page >= lastPage}
            onClick={() => setPage((p) => Math.min(lastPage, p + 1))}
            rightIcon={<ChevronRightIcon size={16} />}
          >
            {t('common.next')}
          </Button>
        </div>
      ) : null}
    </Layout>
  );
}
