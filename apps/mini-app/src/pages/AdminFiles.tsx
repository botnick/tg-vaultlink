/**
 * VaultLink Mini App — Admin: every file in the system.
 *
 * Lists files across all bots (newest-first), with the owner profile and
 * the owning bot inlined server-side so a paged sweep doesn't fan out
 * extra round-trips. Status pills (locked / deleted / private / pwd /
 * expired) tell an admin at a glance which rows need attention.
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { ChevronLeftIcon, ChevronRightIcon, FilesIcon } from '../components/icons.js';
import { CopyButton } from '../components/CopyButton.js';
import { apiGet } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatDate } from '../lib/format.js';
import { formatBytes } from '../lib/format.js';
import type { AdminFileRow, PageResponse } from '../types/api.js';

/** Build the canonical copy form `botname:CODE` straight from a row. */
function shareCodeFor(row: AdminFileRow): string {
  return row.bot ? `${row.bot.username}:${row.code}` : row.code;
}

const PAGE_SIZE = 20;

function actorLabel(owner: AdminFileRow['owner']): string {
  if (!owner) return '—';
  const handle = owner.username !== null ? `@${owner.username}` : `#${owner.id}`;
  const name = owner.first_name?.trim();
  return name && name.length > 0 ? `${handle} · ${name}` : handle;
}

export function AdminFiles(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const [page, setPage] = useState(0);

  const query = useQuery({
    queryKey: qk.admin.files(page, PAGE_SIZE),
    queryFn: () =>
      apiGet<PageResponse<AdminFileRow>>(
        `/admin/files?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <Layout title={t('admin.files.title')} back={() => navigate(-1)} hideNav>
      {query.isLoading ? (
        <SkeletonList rows={5} lines={2} />
      ) : query.isError ? (
        <ErrorState
          message={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<FilesIcon size={48} />}
          title={t('admin.files.empty.title')}
          description={t('admin.files.empty.description')}
        />
      ) : (
        <ul className="space-y-1.5 stagger">
          {items.map((row) => {
            const hasPills =
              row.is_deleted || row.is_locked || row.has_password || row.visibility === 'private';
            return (
              <li key={row.id} className="animate-fade-up">
                <Card padding="sm">
                  <div className="flex items-center gap-2">
                    <code
                      onClick={() => void navigator.clipboard?.writeText(shareCodeFor(row))}
                      className="truncate font-mono text-[11px] text-tg-link flex-1 cursor-pointer"
                      title={t('file_detail.copy')}
                    >
                      {shareCodeFor(row)}
                    </code>
                    <CopyButton value={shareCodeFor(row)} label={t('file_detail.copy')} />
                  </div>
                  <p className="mt-1 truncate text-xs font-semibold text-tg-text leading-tight">
                    {row.file_name ?? `${row.file_type}`}
                  </p>
                  <p className="mt-0.5 truncate text-[10px] text-tg-subtitle-text leading-tight">
                    {actorLabel(row.owner)} · {row.file_type}
                    {row.size_bytes !== null ? ` · ${formatBytes(row.size_bytes)}` : ''}
                    {row.download_count > 0 ? ` · ⬇ ${row.download_count}` : ''} ·{' '}
                    {formatDate(row.created_at, locale)}
                  </p>
                  {hasPills ? (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {row.is_deleted ? (
                        <span className="rounded-full bg-tg-destructive-text/10 px-1.5 py-0.5 text-[9px] font-semibold text-tg-destructive-text">
                          🗑
                        </span>
                      ) : null}
                      {row.is_locked ? (
                        <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-600 dark:text-amber-400">
                          🔒
                        </span>
                      ) : null}
                      {row.has_password ? (
                        <span className="rounded-full bg-tg-link/10 px-1.5 py-0.5 text-[9px] font-semibold text-tg-link">
                          🔑
                        </span>
                      ) : null}
                      {row.visibility === 'private' ? (
                        <span className="rounded-full bg-purple-500/10 px-1.5 py-0.5 text-[9px] font-semibold text-purple-600 dark:text-purple-400">
                          private
                        </span>
                      ) : null}
                      {row.expires_at ? (
                        <span className="rounded-full bg-tg-secondary-bg px-1.5 py-0.5 text-[9px] font-semibold text-tg-subtitle-text">
                          ⌛ {formatDate(row.expires_at, locale)}
                        </span>
                      ) : null}
                    </div>
                  ) : null}
                </Card>
              </li>
            );
          })}
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
