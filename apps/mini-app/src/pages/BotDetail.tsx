/**
 * VaultLink Mini App — single bot management.
 *
 * Surfaces:
 *   - mode toggle (public / private)
 *   - read-only allowed-users list (when the backend exposes it)
 *   - remove (with confirm)
 *
 * The encrypted token tuple is *intentionally* never displayed —
 * the backend strips it from every response, and we surface that
 * fact to the user with a friendly note.
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
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { BotsIcon, LockIcon, TrashIcon } from '../components/icons.js';
import { apiDelete, apiGet, apiPost } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT } from '../lib/i18n.js';
import { hapticNotify } from '../lib/telegram.js';
import type { BotDetail, BotMode, BotPermission } from '../types/api.js';

interface BotDetailEnvelope {
  bot?: BotDetail;
  permissions?: BotPermission[];
}

function unwrapBot(raw: unknown): { bot: BotDetail; permissions: BotPermission[] } | null {
  if (raw === null || typeof raw !== 'object') return null;
  // Backend currently returns just the bot under `data` (flat). Some
  // future shapes may return `{ bot, permissions }` — handle both.
  const env = raw as BotDetailEnvelope;
  if (env.bot && typeof env.bot === 'object') {
    return { bot: env.bot, permissions: env.permissions ?? [] };
  }
  return { bot: raw as BotDetail, permissions: [] };
}

export function BotDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const botId = id ?? '';
  const t = useT();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const query = useQuery({
    queryKey: qk.bots.detail(botId),
    queryFn: () => apiGet<unknown>(`/bots/${botId}`),
    enabled: botId.length > 0,
  });

  const modeMutation = useMutation({
    mutationFn: (mode: BotMode) => apiPost<BotDetail>(`/bots/${botId}/mode`, { mode }),
    onSuccess: (data) => {
      hapticNotify('success');
      // Optimistically refresh the detail cache.
      qc.setQueryData(qk.bots.detail(botId), data);
      qc.invalidateQueries({ queryKey: qk.bots.all });
    },
  });

  const removeMutation = useMutation({
    mutationFn: () => apiDelete<unknown>(`/bots/${botId}`),
    onSuccess: () => {
      hapticNotify('success');
      qc.invalidateQueries({ queryKey: qk.bots.all });
      navigate('/bots', { replace: true });
    },
  });

  const back = (): void => navigate(-1);
  const data = query.data ? unwrapBot(query.data) : null;

  return (
    <Layout title={t('bot_detail.title')} back={back} hideNav>
      {query.isLoading ? (
        <div className="space-y-3">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={2} />
        </div>
      ) : query.isError || !data ? (
        <ErrorState
          message={query.error instanceof Error ? query.error.message : undefined}
          onRetry={() => query.refetch()}
        />
      ) : (
        <div className="space-y-4">
          <Card padding="md" className="fade-up">
            <div className="flex items-start gap-3">
              <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-tg-secondary-bg text-tg-link">
                <BotsIcon size={26} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-base font-semibold text-tg-text">
                  @{data.bot.username}
                </p>
                {data.bot.display_name ? (
                  <p className="truncate text-xs text-tg-subtitle-text">{data.bot.display_name}</p>
                ) : null}
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <StatusBadge tone="neutral">{data.bot.status}</StatusBadge>
                  {data.bot.last_error ? (
                    <StatusBadge tone="danger">{data.bot.last_error}</StatusBadge>
                  ) : null}
                </div>
              </div>
            </div>
          </Card>

          <Card padding="md" className="fade-up">
            <p className="text-xs uppercase tracking-wider text-tg-hint">{t('bot_detail.mode')}</p>
            <div className="mt-2 grid grid-cols-2 overflow-hidden rounded-2xl bg-tg-secondary-bg p-1">
              {(['personal_public', 'personal_private'] as BotMode[]).map((m) => {
                const active = data.bot.mode === m;
                return (
                  <button
                    key={m}
                    type="button"
                    disabled={modeMutation.isPending}
                    onClick={() => {
                      if (active) return;
                      modeMutation.mutate(m);
                    }}
                    className={[
                      'press-scale h-9 rounded-xl text-sm font-medium transition-colors',
                      active
                        ? 'bg-tg-button text-tg-button-text shadow-sm'
                        : 'text-tg-subtitle-text',
                    ].join(' ')}
                  >
                    {m === 'personal_public'
                      ? t('bot_detail.mode.public')
                      : t('bot_detail.mode.private')}
                  </button>
                );
              })}
            </div>
          </Card>

          <Card padding="md" className="fade-up">
            <p className="text-xs uppercase tracking-wider text-tg-hint">
              {t('bot_detail.allowed_users')}
            </p>
            {data.permissions.length === 0 ? (
              <p className="mt-2 text-sm text-tg-subtitle-text">
                {t('bot_detail.no_allowed_users')}
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {data.permissions.map((p) => (
                  <li
                    key={p.id}
                    className="flex items-center justify-between rounded-xl bg-tg-secondary-bg px-3 py-2 text-sm"
                  >
                    <span className="font-mono text-tg-text">user #{p.user_id}</span>
                    <StatusBadge tone="neutral">{p.permission_type}</StatusBadge>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card padding="md" className="fade-up">
            <div className="flex items-start gap-2 text-sm text-tg-subtitle-text">
              <span className="mt-0.5 text-tg-hint">
                <LockIcon size={16} />
              </span>
              <p>{t('bot_detail.token_protected')}</p>
            </div>
          </Card>

          <Card padding="md" className="fade-up">
            <Button
              variant="destructive"
              block
              leftIcon={<TrashIcon size={18} />}
              onClick={() => setConfirmRemove(true)}
            >
              {t('bot_detail.remove')}
            </Button>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title={t('bot_detail.remove_confirm_title')}
        message={t('bot_detail.remove_confirm_message')}
        confirmLabel={t('common.delete')}
        destructive
        loading={removeMutation.isPending}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => removeMutation.mutate()}
      />
    </Layout>
  );
}
