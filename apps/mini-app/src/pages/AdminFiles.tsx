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
        <ul className="space-y-2 stagger">
          {items.map((row) => (
            <li key={row.id} className="animate-fade-up">
              <Card padding="md">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {/* Tap the code (or the icon button) to copy. The whole
                       <code> block is also a copy surface so a one-finger
                       tap on a small phone screen still works. */}
                    <div className="flex items-center gap-2">
                      <code className="truncate font-mono text-xs text-tg-link flex-1">
                        {shareCodeFor(row)}
                      </code>
                      <CopyButton value={shareCodeFor(row)} label={t('file_detail.copy')} />
                    </div>
                    <p className="mt-1 truncate text-sm font-semibold text-tg-text">
                      {row.file_name ?? `${row.file_type}`}
                    </p>
                    <p className="mt-0.5 text-[11px] text-tg-subtitle-text">
                      {actorLabel(row.owner)} · {row.file_type}
                      {row.size_bytes !== null ? ` · ${formatBytes(row.size_bytes)}` : ''}
                      {row.download_count > 0 ? ` · ⬇ ${row.download_count}` : ''}
                    </p>
                  </div>
                  <span className="shrink-0 text-[11px] text-tg-subtitle-text">
                    {formatDate(row.created_at, locale)}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  {row.is_deleted ? (
                    <span className="rounded-full bg-tg-destructive-text/10 px-2 py-0.5 text-[10px] font-semibold text-tg-destructive-text">
                      🗑 deleted
                    </span>
                  ) : null}
                  {row.is_locked ? (
                    <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                      🔒 locked
                    </span>
                  ) : null}
                  {row.has_password ? (
                    <span className="rounded-full bg-tg-link/10 px-2 py-0.5 text-[10px] font-semibold text-tg-link">
                      🔑 pwd
                    </span>
                  ) : null}
                  {row.visibility === 'private' ? (
                    <span className="rounded-full bg-purple-500/10 px-2 py-0.5 text-[10px] font-semibold text-purple-600 dark:text-purple-400">
                      private
                    </span>
                  ) : null}
                  {row.expires_at ? (
                    <span className="rounded-full bg-tg-secondary-bg px-2 py-0.5 text-[10px] font-semibold text-tg-subtitle-text">
                      ⌛ {formatDate(row.expires_at, locale)}
                    </span>
                  ) : null}
                </div>
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
