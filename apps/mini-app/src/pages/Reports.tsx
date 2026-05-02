/**
 * VaultLink Mini App — pending reports queue.
 *
 * Each row exposes "mark reviewed" and "dismiss" actions, both gated
 * behind a confirmation dialog. The list refreshes after every
 * mutation so the queue empties as the moderator works.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ChevronLeftIcon, ChevronRightIcon, FlagIcon } from '../components/icons.js';
import { apiGet, apiPatch } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatDate } from '../lib/format.js';
import { useNavigate } from 'react-router-dom';
import { hapticNotify } from '../lib/telegram.js';
import type { PageResponse, ReportRow } from '../types/api.js';

const PAGE_SIZE = 20;

interface PendingAction {
  report: ReportRow;
  status: 'reviewed' | 'dismissed';
}

export function Reports(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);

  const query = useQuery({
    queryKey: qk.admin.reports('pending', page, PAGE_SIZE),
    queryFn: () =>
      apiGet<PageResponse<ReportRow>>(
        `/admin/reports?status=pending&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });

  const mutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: 'reviewed' | 'dismissed' }) =>
      apiPatch<unknown>(`/admin/reports/${id}`, { status }),
    onSuccess: () => {
      hapticNotify('success');
      qc.invalidateQueries({ queryKey: qk.admin.all });
    },
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <Layout title={t('reports.title')} back={() => navigate(-1)} hideNav>
      {query.isLoading ? (
        <SkeletonList rows={4} />
      ) : query.isError ? (
        <ErrorState
          message={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          icon={<FlagIcon size={48} />}
          title={t('reports.empty.title')}
          description={t('reports.empty.description')}
        />
      ) : (
        <ul className="space-y-3">
          {items.map((r, idx) => (
            <li key={r.id} className="fade-up" style={{ animationDelay: `${Math.min(idx, 8) * 18}ms` }}>
              <Card padding="md">
                <p className="text-xs uppercase tracking-wider text-tg-hint">
                  #{r.id} · {formatDate(r.created_at, locale)}
                </p>
                <p className="mt-1 text-sm text-tg-text">
                  <span className="text-tg-subtitle-text">{t('reports.reason')}: </span>
                  {r.reason}
                </p>
                <p className="mt-1 text-xs text-tg-subtitle-text">
                  {t('reports.file')}: #{r.file_id ?? '—'} · {t('reports.reporter')}: #
                  {r.reporter_user_id ?? '—'}
                </p>
                <div className="mt-3 flex gap-2">
                  <Button
                    size="sm"
                    block
                    variant="secondary"
                    onClick={() => setPending({ report: r, status: 'reviewed' })}
                  >
                    {t('reports.review')}
                  </Button>
                  <Button
                    size="sm"
                    block
                    variant="destructive"
                    onClick={() => setPending({ report: r, status: 'dismissed' })}
                  >
                    {t('reports.dismiss')}
                  </Button>
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

      <ConfirmDialog
        open={pending !== null}
        title={
          pending?.status === 'reviewed'
            ? t('reports.review_confirm_title')
            : t('reports.dismiss_confirm_title')
        }
        message={
          pending?.status === 'reviewed'
            ? t('reports.review_confirm_message')
            : t('reports.dismiss_confirm_message')
        }
        destructive={pending?.status === 'dismissed'}
        loading={mutation.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          mutation.mutate(
            { id: pending.report.id, status: pending.status },
            { onSettled: () => setPending(null) },
          );
        }}
      />
    </Layout>
  );
}
