/**
 * VaultLink Mini App — single file management.
 *
 * Surfaces every owner action the backend exposes:
 *   - copy share code / deep link
 *   - set / remove password
 *   - set expiry (days)
 *   - delete (soft)
 *
 * Every mutation invalidates `qk.files.all` so the list view stays
 * fresh on back-navigation, and the local cache for this detail row
 * is updated optimistically when the server returns the new shape.
 */

import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonCard } from '../components/SkeletonCard.js';
import { StatusBadge } from '../components/StatusBadge.js';
import { CopyButton } from '../components/CopyButton.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { LockIcon, TrashIcon, UnlockIcon, fileTypeIcon } from '../components/icons.js';
import { apiDelete, apiGet, apiPost } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT, useLocale } from '../lib/i18n.js';
import { formatBytes, formatDate, relativeDays } from '../lib/format.js';
import { hapticNotify } from '../lib/telegram.js';
import type { FileDetail } from '../types/api.js';

const BOT_USERNAME = (import.meta.env.VITE_BOT_USERNAME ?? '').replace(/^@/, '');

function buildDeepLink(code: string): string {
  if (!BOT_USERNAME) return code;
  return `https://t.me/${BOT_USERNAME}?start=${encodeURIComponent(code)}`;
}

type DialogKind = 'delete' | 'password' | 'expiry' | null;

export function FileDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const fileId = id ?? '';
  const t = useT();
  const { locale } = useLocale();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [toast, setToast] = useState<string | null>(null);

  const query = useQuery({
    queryKey: qk.files.detail(fileId),
    queryFn: () => apiGet<FileDetail>(`/files/${fileId}`),
    enabled: fileId.length > 0,
  });

  const flashToast = (msg: string): void => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  const invalidate = (): void => {
    qc.invalidateQueries({ queryKey: qk.files.all });
    qc.invalidateQueries({ queryKey: qk.files.detail(fileId) });
  };

  const deleteMutation = useMutation({
    mutationFn: () => apiDelete<unknown>(`/files/${fileId}`),
    onSuccess: () => {
      hapticNotify('success');
      invalidate();
      navigate('/files', { replace: true });
    },
  });

  const passwordSetMutation = useMutation({
    mutationFn: (password: string) => apiPost<FileDetail>(`/files/${fileId}/password`, { password }),
    onSuccess: (data) => {
      hapticNotify('success');
      qc.setQueryData(qk.files.detail(fileId), data);
      qc.invalidateQueries({ queryKey: qk.files.all });
      flashToast(t('file_detail.password_set'));
    },
  });

  const passwordRemoveMutation = useMutation({
    mutationFn: () => apiDelete<FileDetail>(`/files/${fileId}/password`),
    onSuccess: (data) => {
      hapticNotify('success');
      qc.setQueryData(qk.files.detail(fileId), data);
      qc.invalidateQueries({ queryKey: qk.files.all });
      flashToast(t('file_detail.password_removed'));
    },
  });

  const expiryMutation = useMutation({
    mutationFn: (days: number | null) => apiPost<FileDetail>(`/files/${fileId}/expiry`, { days }),
    onSuccess: (data) => {
      hapticNotify('success');
      qc.setQueryData(qk.files.detail(fileId), data);
      qc.invalidateQueries({ queryKey: qk.files.all });
      flashToast(t('file_detail.expiry_updated'));
    },
  });

  const file = query.data;
  const back = (): void => navigate(-1);

  return (
    <Layout title={t('file_detail.title')} back={back} hideNav>
      {query.isLoading ? (
        <div className="space-y-3">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={2} />
        </div>
      ) : query.isError || !file ? (
        <ErrorState
          message={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => query.refetch()}
        />
      ) : (
        <div className="space-y-4">
          <Card padding="md" className="fade-up">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-tg-secondary-bg text-tg-link">
                {fileTypeIcon(file.file_type, 26)}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-tg-text">
                  {file.file_name ?? file.code}
                </p>
                <p className="mt-0.5 text-xs text-tg-subtitle-text">
                  {file.mime_type ?? file.file_type} · {formatBytes(file.size_bytes)}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {file.has_password ? (
                    <StatusBadge tone="info" icon={<LockIcon size={12} />}>
                      {t('files.password_protected')}
                    </StatusBadge>
                  ) : null}
                  {file.is_locked ? (
                    <StatusBadge tone="danger">{t('files.locked')}</StatusBadge>
                  ) : null}
                  <StatusBadge tone="neutral">
                    {file.expires_at
                      ? `${t('files.expires_at')} · ${relativeDays(file.expires_at, locale)}`
                      : t('files.no_expiry')}
                  </StatusBadge>
                  <StatusBadge tone="neutral">
                    {file.download_count} {t('files.downloads')}
                  </StatusBadge>
                </div>
              </div>
            </div>
          </Card>

          <Card padding="md" className="fade-up">
            <p className="text-xs uppercase tracking-wider text-tg-hint">
              {t('file_detail.share_code')}
            </p>
            <div className="mt-1 flex items-center justify-between gap-2">
              <code className="truncate font-mono text-sm text-tg-text">{file.code}</code>
              <CopyButton value={file.code} label={t('file_detail.copy')} />
            </div>
            <div className="mt-4">
              <p className="text-xs uppercase tracking-wider text-tg-hint">
                {t('file_detail.deep_link')}
              </p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <code className="truncate font-mono text-xs text-tg-link">
                  {buildDeepLink(file.code)}
                </code>
                <CopyButton value={buildDeepLink(file.code)} label={t('file_detail.copy')} />
              </div>
            </div>
            {file.expires_at ? (
              <p className="mt-4 text-xs text-tg-subtitle-text">
                {t('files.expires_at')}: {formatDate(file.expires_at, locale)}
              </p>
            ) : null}
          </Card>

          <Card padding="md" className="fade-up">
            <div className="grid grid-cols-1 gap-2">
              {file.has_password ? (
                <Button
                  variant="secondary"
                  block
                  leftIcon={<UnlockIcon size={18} />}
                  loading={passwordRemoveMutation.isPending}
                  onClick={() => passwordRemoveMutation.mutate()}
                >
                  {t('file_detail.remove_password')}
                </Button>
              ) : (
                <Button
                  variant="secondary"
                  block
                  leftIcon={<LockIcon size={18} />}
                  onClick={() => setDialog('password')}
                >
                  {t('file_detail.set_password')}
                </Button>
              )}
              <Button variant="secondary" block onClick={() => setDialog('expiry')}>
                {t('file_detail.set_expiry')}
              </Button>
              <Button
                variant="destructive"
                block
                leftIcon={<TrashIcon size={18} />}
                onClick={() => setDialog('delete')}
              >
                {t('file_detail.delete')}
              </Button>
            </div>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={dialog === 'delete'}
        title={t('file_detail.delete_confirm_title')}
        message={t('file_detail.delete_confirm_message')}
        confirmLabel={t('common.delete')}
        destructive
        loading={deleteMutation.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={() => deleteMutation.mutate()}
      />
      <ConfirmDialog
        open={dialog === 'password'}
        title={t('file_detail.password_dialog_title')}
        inputLabel={t('file_detail.password_dialog_label')}
        inputType="password"
        confirmLabel={t('common.save')}
        loading={passwordSetMutation.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={(value) => {
          if (!value) return;
          passwordSetMutation.mutate(value, {
            onSettled: () => setDialog(null),
          });
        }}
      />
      <ConfirmDialog
        open={dialog === 'expiry'}
        title={t('file_detail.expiry_dialog_title')}
        inputLabel={t('file_detail.expiry_dialog_label')}
        inputType="number"
        inputPlaceholder="0"
        confirmLabel={t('common.save')}
        loading={expiryMutation.isPending}
        onCancel={() => setDialog(null)}
        onConfirm={(value) => {
          const raw = (value ?? '').trim();
          const days = raw === '' ? null : Math.max(0, Math.floor(Number(raw)));
          if (raw !== '' && !Number.isFinite(Number(raw))) return;
          expiryMutation.mutate(days, { onSettled: () => setDialog(null) });
        }}
      />

      {toast ? (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-24 z-40 flex justify-center"
          aria-live="polite"
        >
          <div className="fade-up rounded-full bg-tg-section-bg px-4 py-2 text-sm shadow-md">
            {toast}
          </div>
        </div>
      ) : null}
    </Layout>
  );
}
