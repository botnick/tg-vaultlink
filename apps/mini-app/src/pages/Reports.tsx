/**
 * VaultLink Mini App — admin Reports queue.
 *
 * One row per submitted report, server-side enriched with target metadata
 * (file name, share code, type, size, owner @username, bot username) and
 * reporter chip so the moderator never has to chase IDs across pages. The
 * card surfaces every action a moderator might take on a single tap:
 *
 *   • Send-to-me   — owning bot DMs the reported file/items to the moderator.
 *   • Lock target  — toggle is_locked on file/collection.
 *   • Delete target — soft-delete the file/collection (auto-marks reviewed).
 *   • Ban owner / reporter — hard ban with audit log + auto-status change.
 *   • Mark reviewed / Dismiss — single-row status change.
 *   • Bulk select — long-press / checkbox + sticky bottom action bar.
 *
 * Status tabs (pending / reviewed / dismissed) carry their own counts in
 * badges so the moderator can see the queue health at a glance.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { EmptyState } from '../components/EmptyState.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  FlagIcon,
  LockIcon,
  UnlockIcon,
  TrashIcon,
  fileTypeIcon,
} from '../components/icons.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatBytes, formatDate } from '../lib/format.js';
import { useNavigate } from 'react-router-dom';
import { hapticImpact, hapticNotify } from '../lib/telegram.js';
import type { ReportReasonCategory, ReportRow, ReportStatus } from '../types/api.js';
import {
  banReportOwner,
  banReporter,
  bulkSetReportStatus,
  deleteReportTarget,
  listAdminReports,
  lockReportTarget,
  sendReportPreviewToMe,
  setReportStatus,
  unlockReportTarget,
} from '../lib/reports.api.js';

const PAGE_SIZE = 20;
const TAB_ORDER: ReportStatus[] = ['pending', 'reviewed', 'dismissed'];

type ActionKind =
  | 'review'
  | 'dismiss'
  | 'lock'
  | 'unlock'
  | 'delete'
  | 'ban_owner'
  | 'ban_reporter';

interface PendingAction {
  report: ReportRow;
  kind: ActionKind;
}

function categoryClass(cat: ReportReasonCategory): string {
  switch (cat) {
    case 'illegal':
    case 'malware':
      return 'bg-rose-500/15 text-rose-400';
    case 'copyright':
      return 'bg-amber-500/15 text-amber-400';
    case 'scam':
      return 'bg-orange-500/15 text-orange-400';
    case 'spam':
      return 'bg-sky-500/15 text-sky-400';
    case 'other':
    default:
      return 'bg-tg-secondary-bg text-tg-subtitle-text';
  }
}

function targetIcon(report: ReportRow): JSX.Element {
  if (report.target?.kind === 'collection') return fileTypeIcon('document', 20);
  return fileTypeIcon(report.target?.file_type ?? 'document', 20);
}

function userHandle(
  user: { username: string | null; first_name: string | null; telegram_user_id?: string } | null,
): string {
  if (!user) return '—';
  if (user.username) return `@${user.username}`;
  if (user.first_name) return user.first_name;
  return user.telegram_user_id ? `id:${user.telegram_user_id}` : '—';
}

/**
 * Inline share-code button. Tap-to-copy, full-width pill that truncates the
 * code at the right edge with an icon on the left. We don't reuse the
 * shared `CopyButton`'s pill variant because it can't truncate the inner
 * label — share codes are long enough that we need an explicit truncate
 * span here.
 */
function ShareCodePill({ code }: { code: string }): JSX.Element {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const onClick = async (): Promise<void> => {
    hapticImpact('light');
    let ok = false;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(code);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      // Legacy fallback for older Telegram webviews.
      try {
        const ta = document.createElement('textarea');
        ta.value = code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        ok = true;
      } catch {
        ok = false;
      }
    }
    if (ok) {
      hapticNotify('success');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? t('common.copied') : t('common.copy')}
      className="press-scale mt-2 flex w-full items-center gap-2 rounded-full bg-tg-secondary-bg px-3 py-1.5 text-xs text-tg-link"
    >
      {copied ? (
        <CheckIcon size={14} className="shrink-0" />
      ) : (
        <CopyIcon size={14} className="shrink-0" />
      )}
      <span className="truncate font-mono">{code}</span>
    </button>
  );
}

export function Reports(): JSX.Element {
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [status, setStatus] = useState<ReportStatus>('pending');
  const [page, setPage] = useState(0);
  const [pending, setPending] = useState<PendingAction | null>(null);
  // Bulk-select state. Map keyed by id so toggle/check are O(1).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [bulkPending, setBulkPending] = useState<'reviewed' | 'dismissed' | null>(null);

  const query = useQuery({
    queryKey: qk.admin.reports(status, page, PAGE_SIZE),
    queryFn: () => listAdminReports(status, page, PAGE_SIZE),
  });

  const items = query.data?.items ?? [];
  const total = query.data?.total ?? items.length;
  const counts = query.data?.counts ?? { pending: 0, reviewed: 0, dismissed: 0 };
  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1);

  const invalidate = (): void => {
    qc.invalidateQueries({ queryKey: qk.admin.all });
  };

  const actionMutation = useMutation({
    mutationFn: async (a: PendingAction) => {
      switch (a.kind) {
        case 'review':
          return setReportStatus(a.report.id, 'reviewed');
        case 'dismiss':
          return setReportStatus(a.report.id, 'dismissed');
        case 'lock':
          return lockReportTarget(a.report.id);
        case 'unlock':
          return unlockReportTarget(a.report.id);
        case 'delete':
          return deleteReportTarget(a.report.id);
        case 'ban_owner':
          return banReportOwner(a.report.id, null);
        case 'ban_reporter':
          return banReporter(a.report.id, null);
      }
    },
    onSuccess: () => {
      hapticNotify('success');
      invalidate();
    },
  });

  const sendToMeMutation = useMutation({
    mutationFn: (id: number) => sendReportPreviewToMe(id),
    onSuccess: () => hapticNotify('success'),
    onError: () => hapticNotify('error'),
  });

  const bulkMutation = useMutation({
    mutationFn: (input: { ids: number[]; status: 'reviewed' | 'dismissed' }) =>
      bulkSetReportStatus(input.ids, input.status),
    onSuccess: () => {
      hapticNotify('success');
      setSelected(new Set());
      invalidate();
    },
  });

  const visibleSelectedIds = useMemo(
    () => items.filter((r) => selected.has(r.id)).map((r) => r.id),
    [items, selected],
  );

  const toggleSelect = (id: number): void => {
    hapticImpact('light');
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const tabs: Array<{ key: ReportStatus; label: string; n: number }> = TAB_ORDER.map((s) => ({
    key: s,
    label: t(`reports.tabs.${s}`),
    n: counts[s],
  }));

  return (
    <Layout title={t('reports.title')} back={() => navigate(-1)} hideNav>
      {/* Status tabs with badge counts. */}
      <div className="flex items-center gap-1 overflow-x-auto rounded-full bg-tg-secondary-bg p-1">
        {tabs.map((tab) => {
          const active = tab.key === status;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => {
                if (status === tab.key) return;
                hapticImpact('light');
                setStatus(tab.key);
                setPage(0);
                setSelected(new Set());
              }}
              className={[
                'press-scale flex-1 rounded-full px-3 py-2 text-xs font-semibold whitespace-nowrap',
                active ? 'bg-tg-bg text-tg-text shadow-sm' : 'text-tg-subtitle-text',
              ].join(' ')}
            >
              {tab.label}
              <span className="ml-1.5 inline-block min-w-[1.25rem] rounded-full bg-tg-link/15 px-1.5 text-[10px] text-tg-link">
                {tab.n}
              </span>
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
            title={t('reports.empty.title')}
            description={t('reports.empty.description')}
          />
        ) : (
          <ul className="space-y-3">
            {items.map((r, idx) => {
              const isSelected = selected.has(r.id);
              const target = r.target;
              const isLocked = target?.is_locked === true;
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
                  <Card
                    padding="md"
                    className={isSelected ? 'ring-1 ring-tg-link/50' : ''}
                  >
                    {/* Header row: status pill + meta. The selection
                        checkbox only renders on the pending tab — bulk
                        actions only have a use case while the report is
                        still actionable, and showing the checkbox on
                        already-reviewed rows just adds noise. */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-start gap-2 min-w-0 flex-1">
                        {status === 'pending' ? (
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleSelect(r.id)}
                            className="mt-0.5 h-4 w-4 cursor-pointer accent-tg-link"
                            aria-label={t('reports.bulk.select')}
                          />
                        ) : null}
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 text-xs uppercase tracking-wider text-tg-hint">
                            <span>#{r.id}</span>
                            <span>·</span>
                            <span>{formatDate(r.created_at, locale)}</span>
                            {isLocked ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-400">
                                <LockIcon size={10} /> {t('reports.locked_pill')}
                              </span>
                            ) : null}
                            {r.pending_count_for_target >= 2 ? (
                              <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-semibold text-rose-400">
                                {t('reports.pending_count', { n: r.pending_count_for_target })}
                              </span>
                            ) : null}
                          </div>
                          {/* Target row. Avatar bubble + title + a single
                              tight meta line ("photo · 118.4 KB"). The
                              share-code lives on its own row beneath as a
                              full-width tap-to-copy pill so the line never
                              has to compete with the meta for space. */}
                          <div className="mt-2 flex items-start gap-3">
                            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-tg-secondary-bg text-tg-link">
                              {targetIcon(r)}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-tg-text">
                                {titleLine}
                              </p>
                              {target ? (
                                <p className="mt-0.5 truncate text-xs text-tg-subtitle-text">
                                  {target.kind === 'file'
                                    ? [
                                        target.file_type ?? 'file',
                                        target.size_bytes !== null
                                          ? formatBytes(target.size_bytes)
                                          : null,
                                      ]
                                        .filter(Boolean)
                                        .join(' · ')
                                    : t('reports.items_count', {
                                        n: target.total_items ?? 0,
                                      })}
                                </p>
                              ) : (
                                <p className="text-xs italic text-tg-hint">
                                  {t('reports.target_missing')}
                                </p>
                              )}
                            </div>
                          </div>
                          {target ? (
                            <ShareCodePill code={target.share_code} />
                          ) : null}
                        </div>
                      </div>
                    </div>

                    {/* Reason. */}
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <span
                        className={[
                          'rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide',
                          categoryClass(r.reason_category),
                        ].join(' ')}
                      >
                        {t(`reports.category.${r.reason_category}`)}
                      </span>
                      <span className="text-sm text-tg-text break-words">{r.reason}</span>
                    </div>

                    {/* Owner / reporter chips. */}
                    <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-tg-subtitle-text">
                      {target?.owner ? (
                        <a
                          href={`tg://user?id=${target.owner.telegram_user_id}`}
                          className="text-tg-link"
                        >
                          {t('reports.owner')}: {userHandle(target.owner)}
                        </a>
                      ) : (
                        <span>{t('reports.owner')}: —</span>
                      )}
                      {target?.bot ? (
                        <span>
                          {t('reports.bot')}: @{target.bot.username}
                        </span>
                      ) : null}
                      {r.reporter ? (
                        <a
                          href={`tg://user?id=${r.reporter.telegram_user_id}`}
                          className="text-tg-link"
                        >
                          {t('reports.reporter')}: {userHandle(r.reporter)}
                        </a>
                      ) : (
                        <span>{t('reports.reporter')}: —</span>
                      )}
                    </div>

                    {/* Action row — primary moderation. */}
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      <Button
                        size="sm"
                        block
                        variant="secondary"
                        onClick={() => sendToMeMutation.mutate(r.id)}
                        loading={
                          sendToMeMutation.isPending && sendToMeMutation.variables === r.id
                        }
                        disabled={!target}
                      >
                        {t('reports.actions.send_to_me')}
                      </Button>
                      {r.status === 'pending' ? (
                        <Button
                          size="sm"
                          block
                          variant="primary"
                          onClick={() => setPending({ report: r, kind: 'review' })}
                        >
                          {t('reports.review')}
                        </Button>
                      ) : (
                        <Button size="sm" block variant="ghost" disabled>
                          {t(`reports.tabs.${r.status}`)}
                        </Button>
                      )}
                    </div>

                    {/* Action row — destructive / advanced. */}
                    {target ? (
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <Button
                          size="sm"
                          block
                          variant="secondary"
                          leftIcon={
                            isLocked ? <UnlockIcon size={14} /> : <LockIcon size={14} />
                          }
                          onClick={() =>
                            setPending({
                              report: r,
                              kind: isLocked ? 'unlock' : 'lock',
                            })
                          }
                        >
                          {isLocked ? t('reports.actions.unlock') : t('reports.actions.lock')}
                        </Button>
                        <Button
                          size="sm"
                          block
                          variant="destructive"
                          leftIcon={<TrashIcon size={14} />}
                          onClick={() => setPending({ report: r, kind: 'delete' })}
                        >
                          {t('reports.actions.delete')}
                        </Button>
                      </div>
                    ) : null}

                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <Button
                        size="sm"
                        block
                        variant="ghost"
                        disabled={!target?.owner}
                        onClick={() => setPending({ report: r, kind: 'ban_owner' })}
                      >
                        {t('reports.actions.ban_owner')}
                      </Button>
                      <Button
                        size="sm"
                        block
                        variant="ghost"
                        disabled={!r.reporter}
                        onClick={() => setPending({ report: r, kind: 'ban_reporter' })}
                      >
                        {t('reports.actions.ban_reporter')}
                      </Button>
                    </div>

                    {r.status === 'pending' ? (
                      <div className="mt-2 flex">
                        <Button
                          size="sm"
                          block
                          variant="ghost"
                          onClick={() => setPending({ report: r, kind: 'dismiss' })}
                        >
                          {t('reports.dismiss')}
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

      {/* Sticky bulk-action bar — only rendered on the pending tab where
          mark-reviewed / dismiss are meaningful operations. Two-row layout
          (count on top, two equal-width buttons underneath) keeps the
          longer Thai labels from breaking the bar in narrow viewports. */}
      {status === 'pending' && visibleSelectedIds.length > 0 ? (
        <div className="sticky bottom-0 left-0 right-0 mt-4 rounded-2xl bg-tg-bg p-3 shadow-lg ring-1 ring-tg-link/30">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-tg-text">
              {t('reports.bulk.selected', { n: visibleSelectedIds.length })}
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="press-scale text-xs text-tg-link"
            >
              {t('common.cancel')}
            </button>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button
              size="sm"
              block
              variant="secondary"
              onClick={() => setBulkPending('dismissed')}
            >
              {t('reports.bulk.dismiss')}
            </Button>
            <Button
              size="sm"
              block
              variant="primary"
              onClick={() => setBulkPending('reviewed')}
            >
              {t('reports.bulk.review')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Single-action confirmation dialog. */}
      <ConfirmDialog
        open={pending !== null}
        title={pending ? t(`reports.confirm.${pending.kind}.title`) : ''}
        message={pending ? t(`reports.confirm.${pending.kind}.message`) : ''}
        destructive={
          pending !== null &&
          (pending.kind === 'dismiss' ||
            pending.kind === 'delete' ||
            pending.kind === 'ban_owner' ||
            pending.kind === 'ban_reporter')
        }
        loading={actionMutation.isPending}
        onCancel={() => setPending(null)}
        onConfirm={() => {
          if (!pending) return;
          actionMutation.mutate(pending, {
            onSettled: () => setPending(null),
          });
        }}
      />

      {/* Bulk confirmation dialog. */}
      <ConfirmDialog
        open={bulkPending !== null}
        title={
          bulkPending === 'reviewed'
            ? t('reports.bulk.review_confirm_title')
            : t('reports.bulk.dismiss_confirm_title')
        }
        message={t('reports.bulk.confirm_message', { n: visibleSelectedIds.length })}
        destructive={bulkPending === 'dismissed'}
        loading={bulkMutation.isPending}
        onCancel={() => setBulkPending(null)}
        onConfirm={() => {
          if (!bulkPending || visibleSelectedIds.length === 0) return;
          bulkMutation.mutate(
            { ids: visibleSelectedIds, status: bulkPending },
            { onSettled: () => setBulkPending(null) },
          );
        }}
      />
    </Layout>
  );
}
