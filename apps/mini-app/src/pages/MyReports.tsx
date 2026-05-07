/**
 * VaultLink Mini App — reporter's own report history.
 *
 * The user submits reports from anywhere in the app via {@link ReportSheet};
 * this page is where they can come back to see what happened to them.
 *
 * Per-row content mirrors the admin queue's enriched target summary so the
 * reporter knows exactly what they flagged. Pending rows offer a "withdraw"
 * action that hard-deletes the row — only allowed while the moderator
 * hasn't acted yet, so we don't surface the button on reviewed/dismissed
 * rows.
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
import { ChevronLeftIcon, ChevronRightIcon, FlagIcon, fileTypeIcon } from '../components/icons.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatDate } from '../lib/format.js';
import { useNavigate } from 'react-router-dom';
import { hapticNotify } from '../lib/telegram.js';
import type { MyReportRow, PageResponse, ReportStatus } from '../types/api.js';
import { listMyReports, withdrawMyReport } from '../lib/reports.api.js';

const PAGE_SIZE = 20;
const TAB_ORDER: Array<ReportStatus | null> = [null, 'pending', 'reviewed', 'dismissed'];

function statusClass(s: ReportStatus): string {
  switch (s) {
    case 'pending':
      return 'bg-amber-500/15 text-amber-400';
    case 'reviewed':
      return 'bg-emerald-500/15 text-emerald-400';
    case 'dismissed':
    default:
      return 'bg-tg-secondary-bg text-tg-subtitle-text';
  }
}

export function MyReports(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [status, setStatus] = useState<ReportStatus | null>(null);
  const [page, setPage] = useState(0);
  const [pendingWithdraw, setPendingWithdraw] = useState<MyReportRow | null>(null);

  const query = useQuery<PageResponse<MyReportRow>>({
    queryKey: qk.myReports.list(status, page, PAGE_SIZE),
    queryFn: () => listMyReports(status, page, PAGE_SIZE),
  });

  const withdraw = useMutation({
    mutationFn: (id: number) => withdrawMyReport(id),
    onSuccess: () => {
      hapticNotify('success');
      qc.invalidateQueries({ queryKey: qk.myReports.all });
    },
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  return (
    <Layout title={t('my_reports.title')} back={() => navigate(-1)} hideNav>
      <div className="flex items-center gap-1 overflow-x-auto rounded-full bg-tg-secondary-bg p-1">
        {TAB_ORDER.map((s) => {
          const active = status === s;
          const label = s === null ? t('my_reports.tabs.all') : t(`reports.tabs.${s}`);
          return (
            <button
              key={String(s)}
              type="button"
              onClick={() => {
                setStatus(s);
                setPage(0);
              }}
              className={[
                'press-scale flex-1 rounded-full px-3 py-2 text-xs font-semibold whitespace-nowrap',
                active ? 'bg-tg-bg text-tg-text shadow-sm' : 'text-tg-subtitle-text',
              ].join(' ')}
            >
              {label}
            </button>
          );
        })}
      </div>

      <div className="mt-4">
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
            title={t('my_reports.empty.title')}
            description={t('my_reports.empty.description')}
          />
        ) : (
          <ul className="space-y-3">
            {items.map((r, idx) => {
              const target = r.target;
              const titleLine =
                target?.kind === 'collection'
                  ? (target.title ?? t('collections.untitled'))
                  : (target?.file_name ?? t('reports.unnamed_file'));
              return (
                <li
                  key={r.id}
                  className="fade-up"
                  style={{ animationDelay: `${Math.min(idx, 8) * 18}ms` }}
                >
                  <Card padding="md">
                    <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-tg-hint">
                      <span>#{r.id}</span>
                      <span>·</span>
                      <span>{formatDate(r.created_at, locale)}</span>
                      <span
                        className={[
                          'ml-auto rounded-full px-2 py-0.5 text-[10px] font-semibold',
                          statusClass(r.status),
                        ].join(' ')}
                      >
                        {t(`reports.tabs.${r.status}`)}
                      </span>
                    </div>
                    <div className="mt-2 flex items-start gap-2">
                      <span className="mt-0.5 text-tg-subtitle-text">
                        {fileTypeIcon(target?.file_type ?? 'document', 20)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-tg-text">
                          {titleLine}
                        </p>
                        {target ? (
                          <p className="truncate text-xs text-tg-subtitle-text font-mono">
                            {target.share_code}
                          </p>
                        ) : (
                          <p className="text-xs italic text-tg-hint">
                            {t('reports.target_missing')}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <span className="rounded-full bg-tg-secondary-bg px-2.5 py-0.5 text-[11px] font-semibold uppercase">
                        {t(`reports.category.${r.reason_category}`)}
                      </span>
                      <span className="text-sm text-tg-text break-words">{r.reason}</span>
                    </div>
                    {r.status === 'pending' ? (
                      <div className="mt-3">
                        <Button
                          size="sm"
                          variant="secondary"
                          block
                          onClick={() => setPendingWithdraw(r)}
                        >
                          {t('my_reports.withdraw')}
                        </Button>
                      </div>
                    ) : null}
                  </Card>
                </li>
              );
            })}
          </ul>
        )}
      </div>

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
        open={pendingWithdraw !== null}
        title={t('my_reports.withdraw_confirm_title')}
        message={t('my_reports.withdraw_confirm_message')}
        destructive
        loading={withdraw.isPending}
        onCancel={() => setPendingWithdraw(null)}
        onConfirm={() => {
          if (!pendingWithdraw) return;
          withdraw.mutate(pendingWithdraw.id, {
            onSettled: () => setPendingWithdraw(null),
          });
        }}
      />
    </Layout>
  );
}
