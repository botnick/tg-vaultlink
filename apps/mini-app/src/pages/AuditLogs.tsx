/**
 * VaultLink Mini App — audit log viewer.
 *
 * Filters: action substring + actor user id. The backend matches on
 * exact action by default — we keep the UI as a free-text input
 * because most call-site actions are short tokens (`file.upload`,
 * `bot.add`, etc).
 */

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { ChevronLeftIcon, ChevronRightIcon, ListIcon } from '../components/icons.js';
import { apiGet } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatDate } from '../lib/format.js';
import type { AuditLogRow, PageResponse } from '../types/api.js';

const PAGE_SIZE = 20;

interface Filters {
  action: string;
  actorUserId: string;
}

function buildQuery(filters: Filters, page: number): string {
  const sp = new URLSearchParams();
  sp.set('limit', String(PAGE_SIZE));
  sp.set('offset', String(page * PAGE_SIZE));
  if (filters.action.trim()) sp.set('action', filters.action.trim());
  if (filters.actorUserId.trim()) sp.set('actorUserId', filters.actorUserId.trim());
  return sp.toString();
}

export function AuditLogs(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);
  const [filters, setFilters] = useState<Filters>({ action: '', actorUserId: '' });
  const [submitted, setSubmitted] = useState<Filters>({ action: '', actorUserId: '' });

  const query = useQuery({
    queryKey: qk.admin.audit(
      { actorUserId: submitted.actorUserId, action: submitted.action },
      page,
      PAGE_SIZE,
    ),
    queryFn: () => apiGet<PageResponse<AuditLogRow>>(`/admin/audit?${buildQuery(submitted, page)}`),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const onSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    setSubmitted(filters);
    setPage(0);
  };

  return (
    <Layout title={t('audit.title')} back={() => navigate(-1)} hideNav>
      <form onSubmit={onSubmit} className="mb-4 grid grid-cols-2 gap-2">
        <input
          value={filters.action}
          onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
          placeholder={t('audit.action')}
          className="h-10 rounded-2xl border border-black/10 bg-tg-secondary-bg px-3 text-sm text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
        />
        <input
          value={filters.actorUserId}
          onChange={(e) => setFilters((f) => ({ ...f, actorUserId: e.target.value }))}
          placeholder={t('audit.actor')}
          inputMode="numeric"
          className="h-10 rounded-2xl border border-black/10 bg-tg-secondary-bg px-3 text-sm text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
        />
        <Button type="submit" variant="primary" size="sm" block className="col-span-2">
          {t('common.save')}
        </Button>
      </form>

      {query.isLoading ? (
        <SkeletonList rows={5} lines={1} />
      ) : query.isError ? (
        <ErrorState
          message={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<ListIcon size={48} />}
          title={t('audit.empty.title')}
          description={t('audit.empty.description')}
        />
      ) : (
        <ul className="space-y-2">
          {items.map((row, idx) => (
            <li key={row.id} className="fade-up" style={{ animationDelay: `${Math.min(idx, 10) * 14}ms` }}>
              <Card padding="sm">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-tg-link">{row.action}</p>
                    <p className="mt-0.5 text-[11px] text-tg-subtitle-text">
                      {t('audit.actor')}: #{row.actor_user_id ?? '—'} · {t('audit.target')}:{' '}
                      {row.target_type ?? '—'}/{row.target_id ?? '—'}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-tg-subtitle-text">
                    {formatDate(row.created_at, locale)}
                  </span>
                </div>
                {row.metadata_json ? (
                  <pre className="mt-2 overflow-x-auto rounded-xl bg-tg-secondary-bg p-2 text-[11px] text-tg-subtitle-text">
                    {row.metadata_json}
                  </pre>
                ) : null}
              </Card>
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
