/**
 * VaultLink Mini App — broadcast detail.
 *
 * Read-only view of one broadcast: rendered content + filter snapshot +
 * live progress (auto-refresh every 2s while sending) + a paginated
 * recipients table. Available actions depend on `status`:
 *
 *   - draft     → "Edit" (jumps to composer)
 *   - scheduled → "Cancel"
 *   - sending   → "Cancel"
 *   - completed → no actions (will gain "Edit message" / "Delete message"
 *                 in v0.3.1)
 *
 * The recipients table filter chips drive a server-side `?status=` query
 * so a 5 000-row broadcast doesn't fan out a single big response.
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
} from '../components/icons.js';
import { apiGet, apiPost } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatDate } from '../lib/format.js';
import { hapticNotify } from '../lib/telegram.js';
import type {
  BroadcastRecipientRow,
  BroadcastRecipientStatus,
  BroadcastRow,
  PageResponse,
} from '../types/api.js';

const PAGE_SIZE = 20;

const RECIPIENT_FILTERS: ReadonlyArray<BroadcastRecipientStatus | 'all'> = [
  'all',
  'pending',
  'sent',
  'failed',
  'blocked',
] as const;

function recipientToneClass(status: BroadcastRecipientStatus): string {
  switch (status) {
    case 'sent':
      return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400';
    case 'pending':
      return 'bg-amber-500/10 text-amber-600 dark:text-amber-400';
    case 'sending':
      return 'bg-blue-500/10 text-blue-600 dark:text-blue-400';
    case 'failed':
      return 'bg-tg-destructive-text/10 text-tg-destructive-text';
    case 'blocked':
      return 'bg-tg-secondary-bg text-tg-hint';
    case 'cancelled':
      return 'bg-tg-secondary-bg text-tg-hint';
    default:
      return 'bg-tg-secondary-bg text-tg-subtitle-text';
  }
}

export function BroadcastDetail(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const id = Number.parseInt(params.id ?? '', 10);
  const qc = useQueryClient();

  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState<BroadcastRecipientStatus | 'all'>('all');
  const [confirmCancel, setConfirmCancel] = useState(false);

  const detail = useQuery({
    queryKey: qk.broadcasts.detail(id),
    enabled: Number.isFinite(id),
    queryFn: () => apiGet<BroadcastRow>(`/broadcasts/${id}`),
    refetchInterval: (q) => {
      const data = q.state.data as BroadcastRow | undefined;
      return data && (data.status === 'sending' || data.status === 'scheduled') ? 2_000 : false;
    },
  });

  const filterStatus = filter === 'all' ? null : filter;
  const recipients = useQuery({
    queryKey: qk.broadcasts.recipients(id, filterStatus, page, PAGE_SIZE),
    enabled: Number.isFinite(id),
    queryFn: () => {
      const sp = new URLSearchParams();
      sp.set('limit', String(PAGE_SIZE));
      sp.set('offset', String(page * PAGE_SIZE));
      if (filterStatus) sp.set('status', filterStatus);
      return apiGet<PageResponse<BroadcastRecipientRow>>(
        `/broadcasts/${id}/recipients?${sp.toString()}`,
      );
    },
    refetchInterval: () => {
      const det = qc.getQueryData<BroadcastRow>(qk.broadcasts.detail(id));
      return det?.status === 'sending' ? 2_000 : false;
    },
  });

  const cancel = useMutation({
    mutationFn: () => apiPost<BroadcastRow>(`/broadcasts/${id}/cancel`, {}),
    onSuccess: () => {
      hapticNotify('success');
      void qc.invalidateQueries({ queryKey: qk.broadcasts.all });
      void detail.refetch();
    },
  });

  if (!Number.isFinite(id)) {
    return (
      <Layout title={t('broadcast.detail.title')} back={() => navigate(-1)} hideNav>
        <ErrorState message="invalid id" />
      </Layout>
    );
  }
  if (detail.isLoading) {
    return (
      <Layout title={t('broadcast.detail.title')} back={() => navigate(-1)} hideNav>
        <SkeletonList rows={4} lines={2} />
      </Layout>
    );
  }
  if (detail.isError || !detail.data) {
    return (
      <Layout title={t('broadcast.detail.title')} back={() => navigate(-1)} hideNav>
        <ErrorState
          message={detail.error instanceof Error ? detail.error.message : undefined}
          onRetry={() => detail.refetch()}
        />
      </Layout>
    );
  }

  const row = detail.data;
  const recipientItems = recipients.data?.items ?? [];
  const recipientTotal = recipients.data?.total ?? recipientItems.length;
  const lastPage = Math.max(0, Math.ceil(recipientTotal / PAGE_SIZE) - 1);

  const totalReached = row.count_sent + row.count_failed + row.count_blocked;
  const pct =
    row.audience_count > 0 ? Math.min(100, Math.round((totalReached / row.audience_count) * 100)) : 0;

  const canCancel =
    row.status === 'draft' || row.status === 'scheduled' || row.status === 'sending';
  const canEdit = row.status === 'draft';

  return (
    <Layout title={t('broadcast.detail.title')} back={() => navigate(-1)} hideNav>
      {/* Status hero */}
      <Card padding="md" className="mb-3" variant="default">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wider text-tg-hint">
              {t('broadcast.detail.title')} #{row.id}
            </p>
            <p className="mt-0.5 text-sm font-semibold text-tg-text">
              bot #{row.bot_id} · {formatDate(row.created_at, locale)}
            </p>
          </div>
          <span
            className={[
              'shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
              row.status === 'completed'
                ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                : row.status === 'sending'
                ? 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
                : row.status === 'failed'
                ? 'bg-tg-destructive-text/10 text-tg-destructive-text'
                : 'bg-tg-secondary-bg text-tg-subtitle-text',
            ].join(' ')}
          >
            {t(`broadcast.status.${row.status}`)}
          </span>
        </div>

        {/* Progress */}
        <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-tg-secondary-bg">
          <div
            className="h-full bg-gradient-to-r from-brand-violet to-brand-fuchsia transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-2 grid grid-cols-4 gap-2 text-center text-[10px]">
          <div>
            <p className="font-bold text-emerald-600 dark:text-emerald-400">{row.count_sent}</p>
            <p className="text-tg-hint">{t('broadcast.detail.sent')}</p>
          </div>
          <div>
            <p className="font-bold text-tg-destructive-text">{row.count_failed}</p>
            <p className="text-tg-hint">{t('broadcast.detail.failed')}</p>
          </div>
          <div>
            <p className="font-bold text-tg-hint">{row.count_blocked}</p>
            <p className="text-tg-hint">{t('broadcast.detail.blocked')}</p>
          </div>
          <div>
            <p className="font-bold text-tg-text">{row.count_pending}</p>
            <p className="text-tg-hint">{t('broadcast.detail.pending')}</p>
          </div>
        </div>
        <p className="mt-1 text-center text-[10px] text-tg-subtitle-text">
          {totalReached.toLocaleString()} / {row.audience_count.toLocaleString()} ({pct}%)
        </p>
      </Card>

      {/* Content preview */}
      <Card padding="sm" className="mb-3">
        <p className="text-[10px] uppercase tracking-wider text-tg-hint">
          {t('broadcast.detail.content')}
        </p>
        <pre className="mt-1 whitespace-pre-wrap break-words text-xs text-tg-text">
          {row.text}
        </pre>
        <p className="mt-2 text-[10px] text-tg-hint">
          parse_mode: {row.parse_mode ?? 'plain'}
          {row.media_type ? ` · media: ${row.media_type}` : ''}
          {row.silent ? ' · silent' : ''}
          {row.protect_content ? ' · protected' : ''}
        </p>
        {row.buttons && row.buttons.length > 0 ? (
          <div className="mt-2 space-y-1">
            {row.buttons.map((rowBtns, i) => (
              <div key={i} className="flex flex-wrap gap-1">
                {rowBtns.map((b, j) => (
                  <span
                    key={j}
                    className="truncate rounded-full bg-tg-secondary-bg px-2 py-0.5 text-[10px] text-tg-link"
                  >
                    {b.text} → {b.url}
                  </span>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </Card>

      {/* Audience snapshot */}
      <Card padding="sm" className="mb-3">
        <p className="text-[10px] uppercase tracking-wider text-tg-hint">
          {t('broadcast.detail.audience')}
        </p>
        <p className="mt-1 text-[11px] text-tg-subtitle-text">
          locale: {row.audience.locale} · role: {row.audience.role}
          {row.audience.exclude_banned ? ' · excl banned' : ''}
          {row.audience.exclude_unsubscribed ? ' · excl unsub' : ''}
          {row.audience.registered_within_days
            ? ` · ≤${row.audience.registered_within_days}d`
            : ''}
          {row.audience.user_ids.length > 0
            ? ` · ${row.audience.user_ids.length} explicit`
            : ''}
        </p>
        {row.scheduled_at ? (
          <p className="mt-1 text-[11px] text-tg-subtitle-text">
            ⏰ {formatDate(row.scheduled_at, locale)}
          </p>
        ) : null}
      </Card>

      {/* Actions */}
      {canCancel || canEdit ? (
        <div className="mb-3 flex gap-2">
          {canEdit ? (
            <Button
              variant="secondary"
              size="sm"
              block
              onClick={() => navigate(`/admin/broadcasts/${row.id}/edit`)}
            >
              {t('broadcast.detail.edit')}
            </Button>
          ) : null}
          {canCancel ? (
            <Button
              variant="destructive"
              size="sm"
              block
              onClick={() => setConfirmCancel(true)}
              loading={cancel.isPending}
            >
              {t('broadcast.detail.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/* Recipients */}
      <Card padding="sm">
        <p className="text-[10px] uppercase tracking-wider text-tg-hint">
          {t('broadcast.detail.recipients')}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {RECIPIENT_FILTERS.map((s) => {
            const active = filter === s;
            return (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setFilter(s);
                  setPage(0);
                }}
                className={[
                  'press-scale rounded-full px-2.5 py-0.5 text-[10px] font-semibold',
                  active
                    ? 'bg-gradient-hero text-white shadow-soft'
                    : 'bg-tg-secondary-bg text-tg-subtitle-text',
                ].join(' ')}
              >
                {t(`broadcast.recipient_status.${s}`)}
              </button>
            );
          })}
        </div>

        {recipients.isLoading ? (
          <div className="mt-3">
            <SkeletonList rows={4} lines={1} />
          </div>
        ) : recipientItems.length === 0 ? (
          <p className="mt-3 text-center text-[11px] text-tg-hint">
            {t('broadcast.detail.no_recipients')}
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-black/5 dark:divide-white/5">
            {recipientItems.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between gap-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-tg-text">
                    {r.user
                      ? r.user.username
                        ? `@${r.user.username}`
                        : r.user.first_name ?? `#${r.user_id}`
                      : `#${r.user_id}`}
                  </p>
                  <p className="truncate font-mono text-[10px] text-tg-subtitle-text">
                    tg #{r.telegram_user_id}
                    {r.error_message ? ` · ${r.error_message}` : ''}
                    {r.retry_count > 0 ? ` · retry ×${r.retry_count}` : ''}
                  </p>
                </div>
                <span
                  className={[
                    'shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold',
                    recipientToneClass(r.status),
                  ].join(' ')}
                >
                  {r.status}
                </span>
              </li>
            ))}
          </ul>
        )}

        {recipientTotal > PAGE_SIZE ? (
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
      </Card>

      <ConfirmDialog
        open={confirmCancel}
        title={t('broadcast.detail.cancel_confirm.title')}
        message={t('broadcast.detail.cancel_confirm.message')}
        destructive
        loading={cancel.isPending}
        onCancel={() => setConfirmCancel(false)}
        onConfirm={() => {
          setConfirmCancel(false);
          cancel.mutate();
        }}
      />
    </Layout>
  );
}
