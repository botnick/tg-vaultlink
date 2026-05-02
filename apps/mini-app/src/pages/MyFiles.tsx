/**
 * VaultLink Mini App — file list.
 *
 * Server-side pagination (limit=20). Client-side search filters the
 * current page only — full-corpus search would require a backend
 * endpoint we don't have yet, and the typical user has well under
 * a single page anyway.
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
  fileTypeIcon,
} from '../components/icons.js';
import { apiGet } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatBytes, relativeDays } from '../lib/format.js';
import { hapticImpact } from '../lib/telegram.js';
import type { FileSummary, PageResponse } from '../types/api.js';

const PAGE_SIZE = 20;

function fileLabel(f: FileSummary): string {
  return f.file_name ?? f.code;
}

export function MyFiles(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');

  const query = useQuery({
    queryKey: qk.files.list(page, PAGE_SIZE),
    queryFn: () =>
      apiGet<PageResponse<FileSummary>>(
        `/files?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return items;
    return items.filter((f) => fileLabel(f).toLowerCase().includes(s) || f.code.toLowerCase().includes(s));
  }, [items, search]);

  return (
    <Layout title={t('files.title')}>
      <div
        className="mb-3 flex gap-1 rounded-full bg-tg-secondary-bg p-1"
        role="tablist"
        aria-label={t('files.title')}
      >
        <button
          type="button"
          role="tab"
          aria-selected="true"
          className="press-scale inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-tg-button text-sm font-medium text-tg-button-text"
        >
          <FilesIcon size={16} />
          <span>{t('files.tabs.files')}</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected="false"
          onClick={() => {
            hapticImpact('light');
            navigate('/collections');
          }}
          className="press-scale inline-flex h-9 flex-1 items-center justify-center gap-1.5 rounded-full bg-transparent text-sm font-medium text-tg-subtitle-text"
        >
          <ListIcon size={16} />
          <span>{t('files.tabs.collections')}</span>
        </button>
      </div>

      <div className="mb-3">
        <label className="relative block">
          <span className="sr-only">{t('files.search_placeholder')}</span>
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-tg-hint">
            <SearchIcon size={18} />
          </span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('files.search_placeholder')}
            className="h-11 w-full rounded-2xl border border-black/10 bg-tg-secondary-bg pl-9 pr-3 text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
          />
        </label>
      </div>

      {query.isLoading ? (
        <SkeletonList rows={4} />
      ) : query.isError ? (
        <ErrorState
          message={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<FilesIcon size={48} />}
          title={t('files.empty.title')}
          description={t('files.empty.description')}
        />
      ) : (
        <ul className="space-y-3">
          {filtered.map((f, idx) => (
            <li key={f.id} className="fade-up" style={{ animationDelay: `${Math.min(idx, 8) * 18}ms` }}>
              <Link to={`/files/${f.id}`}>
                <Card interactive padding="md">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-tg-secondary-bg text-tg-link">
                      {fileTypeIcon(f.file_type, 22)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-semibold text-tg-text">{fileLabel(f)}</p>
                      </div>
                      <p className="mt-0.5 truncate text-xs text-tg-subtitle-text">
                        <code className="font-mono">{f.share_code}</code>
                        {' · '}
                        {formatBytes(f.size_bytes)}
                        {' · '}
                        {f.download_count} {t('files.downloads')}
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {f.has_password ? (
                          <StatusBadge tone="info" icon={<LockIcon size={12} />}>
                            {t('files.password_protected')}
                          </StatusBadge>
                        ) : null}
                        {f.is_locked ? (
                          <StatusBadge tone="danger">{t('files.locked')}</StatusBadge>
                        ) : null}
                        <StatusBadge tone="neutral">
                          {f.expires_at
                            ? `${t('files.expires_at')} · ${relativeDays(f.expires_at, locale)}`
                            : t('files.no_expiry')}
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
