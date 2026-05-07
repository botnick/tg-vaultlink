/**
 * VaultLink Mini App — "Report this content" bottom sheet.
 *
 * Reused by every place a user can flag a file or collection (file detail,
 * collection detail, public decode preview). The sheet collects:
 *
 *   • Reason category — radio over the small enum the backend stores in
 *     `reports.reason_category`. Defaults to `spam` because that's the
 *     overwhelmingly most-common case in moderation logs.
 *   • Optional free-text note — required by the server (POST /reports
 *     rejects empty `reason`), but the UX nudges the user with a
 *     placeholder appropriate to the chosen category.
 *
 * Submit goes through `lib/reports.api.ts#submitReport` so the api wrapper
 * stays the single source of truth for URL shape + envelope handling. On
 * success we show a 1.5s success toast then auto-close — invalidating
 * `qk.myReports.all` so the My Reports page picks up the new row when the
 * user navigates there.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from './Button.js';
import { ApiError } from '../lib/api.js';
import { hapticNotify } from '../lib/telegram.js';
import { useT } from '../lib/i18n.js';
import { qk } from '../lib/queryKeys.js';
import {
  REPORT_REASON_CATEGORIES,
  type ReportReasonCategory,
  type ReportTargetType,
} from '../types/api.js';
import { submitReport } from '../lib/reports.api.js';

interface Props {
  open: boolean;
  target: { type: ReportTargetType; id: number; label?: string };
  onClose: () => void;
  onSubmitted?: () => void;
}

const NOTE_MAX = 500;

export function ReportSheet({ open, target, onClose, onSubmitted }: Props): JSX.Element | null {
  const t = useT();
  const qc = useQueryClient();
  const [category, setCategory] = useState<ReportReasonCategory>('spam');
  const [note, setNote] = useState('');
  const [submittedAt, setSubmittedAt] = useState<number | null>(null);

  // Reset state every time the sheet re-opens so consecutive reports never
  // bleed leftover text from a previous submission.
  useEffect(() => {
    if (open) {
      setCategory('spam');
      setNote('');
      setSubmittedAt(null);
    }
  }, [open]);

  const mutation = useMutation({
    mutationFn: () =>
      submitReport({
        target_type: target.type,
        target_id: target.id,
        reason: note.trim().length > 0 ? note : t(`report_sheet.placeholder.${category}`),
        reason_category: category,
      }),
    onSuccess: () => {
      hapticNotify('success');
      qc.invalidateQueries({ queryKey: qk.myReports.all });
      setSubmittedAt(Date.now());
      onSubmitted?.();
      window.setTimeout(() => onClose(), 1500);
    },
    onError: () => hapticNotify('error'),
  });

  if (!open) return null;

  const errorMessage: string | null = (() => {
    const err = mutation.error;
    if (!err) return null;
    if (err instanceof ApiError) return err.message;
    return err instanceof Error ? err.message : 'unknown error';
  })();

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget && !mutation.isPending) onClose();
      }}
    >
      <div className="sheet-up w-full max-w-md rounded-t-3xl bg-tg-bg p-5 pb-[calc(1.25rem+var(--safe-bottom))] shadow-2xl">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-tg-hint/40" aria-hidden="true" />
        <h3 className="text-base font-semibold text-tg-text">{t('report_sheet.title')}</h3>
        {target.label ? (
          <p className="mt-1 truncate text-xs text-tg-subtitle-text">{target.label}</p>
        ) : null}

        {submittedAt !== null ? (
          <SuccessBadge>{t('report_sheet.success')}</SuccessBadge>
        ) : (
          <>
            <fieldset className="mt-4 space-y-1">
              <legend className="mb-2 text-xs uppercase tracking-wider text-tg-hint">
                {t('report_sheet.category_label')}
              </legend>
              {REPORT_REASON_CATEGORIES.map((c) => (
                <label
                  key={c}
                  className={[
                    'flex cursor-pointer items-center gap-3 rounded-2xl border p-3',
                    category === c
                      ? 'border-tg-link bg-tg-link/5'
                      : 'border-transparent bg-tg-secondary-bg',
                  ].join(' ')}
                >
                  <input
                    type="radio"
                    className="accent-tg-link"
                    checked={category === c}
                    onChange={() => setCategory(c)}
                    name="report-category"
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-tg-text">
                      {t(`reports.category.${c}`)}
                    </span>
                    <span className="text-xs text-tg-subtitle-text">
                      {t(`report_sheet.category_hint.${c}`)}
                    </span>
                  </div>
                </label>
              ))}
            </fieldset>

            <label className="mt-4 block">
              <span className="text-xs uppercase tracking-wider text-tg-hint">
                {t('report_sheet.note_label')}
              </span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
                placeholder={t(`report_sheet.placeholder.${category}`)}
                rows={3}
                className="mt-1 w-full resize-none rounded-2xl border border-black/10 bg-tg-secondary-bg px-3 py-2.5 text-sm text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
              />
              <span className="mt-1 block text-right text-[10px] text-tg-hint">
                {note.length}/{NOTE_MAX}
              </span>
            </label>

            {errorMessage ? (
              <p className="mt-2 rounded-xl bg-rose-500/10 p-2 text-xs text-rose-400">
                {errorMessage}
              </p>
            ) : null}

            <div className="mt-5 flex gap-2">
              <Button
                variant="secondary"
                block
                onClick={onClose}
                disabled={mutation.isPending}
              >
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                block
                loading={mutation.isPending}
                onClick={() => mutation.mutate()}
              >
                {t('report_sheet.submit')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function SuccessBadge({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mt-4 rounded-2xl bg-emerald-500/10 p-4 text-center text-sm text-emerald-400">
      {children}
    </div>
  );
}
