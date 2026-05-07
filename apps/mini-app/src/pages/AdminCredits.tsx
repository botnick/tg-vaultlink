/**
 * VaultLink Mini App — Credits admin page.
 *
 * Surfaces every dynamic credit setting as a togglable / editable widget,
 * plus a grant form for per-user adjustments. Founder-only mutations are
 * gated server-side; we hide the "Apply" buttons for non-founders so the
 * UI stays honest.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { ErrorState } from '../components/ErrorState.js';
import { useT } from '../lib/i18n.js';
import { qk } from '../lib/queryKeys.js';
import { adminCreditsApi, type AdminCreditSettings } from '../lib/credits.api.js';
import { useAuth } from '../providers/AuthProvider.js';
import { hapticNotify, showConfirm } from '../lib/telegram.js';
import { ApiError } from '../types/api.js';

const FLAG_KEYS = [
  'enabled',
  'referralEnabled',
  'topupEnabled',
  'bypassForOwner',
  'bypassForAdmin',
] as const;

const NUMBER_FIELDS: ReadonlyArray<{
  key: keyof AdminCreditSettings['numbers'];
  settingKey: string;
}> = [
  { key: 'signupBonus', settingKey: 'credits.signup_bonus' },
  { key: 'costDecode', settingKey: 'credits.cost_decode' },
  { key: 'costCollectionOpen', settingKey: 'credits.cost_collection_open' },
  { key: 'costCollectionSendBase', settingKey: 'credits.cost_collection_send' },
  { key: 'costCollectionPerItem', settingKey: 'credits.cost_collection_per_item' },
  { key: 'referralReward', settingKey: 'credits.referral_reward' },
  { key: 'referralDailyCap', settingKey: 'credits.referral_daily_cap' },
  { key: 'referralPairLifetimeCap', settingKey: 'credits.referral_pair_lifetime_cap' },
  { key: 'referralPairWindowMinutes', settingKey: 'credits.referral_pair_window_minutes' },
  { key: 'referralPairWindowMax', settingKey: 'credits.referral_pair_window_max' },
  { key: 'referralRedeemerMinAgeMinutes', settingKey: 'credits.referral_redeemer_min_age_minutes' },
];

const FILE_TYPES = [
  'document',
  'photo',
  'video',
  'audio',
  'voice',
  'animation',
  'sticker',
] as const;

const FLAG_SETTING_KEYS: Record<(typeof FLAG_KEYS)[number], string> = {
  enabled: 'credits.enabled',
  referralEnabled: 'credits.referral_enabled',
  topupEnabled: 'credits.topup_enabled',
  bypassForOwner: 'credits.bypass_for_owner',
  bypassForAdmin: 'credits.bypass_for_admin',
};

export function AdminCredits(): JSX.Element {
  const t = useT();
  const { isFounder } = useAuth();
  const qc = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: qk.adminCredits.settings,
    queryFn: () => adminCreditsApi.getSettings(),
    staleTime: 15_000,
  });

  const patchMutation = useMutation({
    mutationFn: (input: { key: string; bool?: boolean; number?: number; clear?: boolean }) =>
      adminCreditsApi.patchSetting(input),
    onSuccess: () => {
      hapticNotify('success');
      qc.invalidateQueries({ queryKey: qk.adminCredits.settings });
    },
  });

  if (settingsQuery.isLoading) {
    return (
      <Layout title={t('admin_credits.title')} back={() => history.back()}>
        <SkeletonList rows={5} />
      </Layout>
    );
  }
  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <Layout title={t('admin_credits.title')} back={() => history.back()}>
        <ErrorState
          message={String(settingsQuery.error)}
          onRetry={() => settingsQuery.refetch()}
        />
      </Layout>
    );
  }
  const s = settingsQuery.data;

  return (
    <Layout title={t('admin_credits.title')} back={() => history.back()}>
      <div className="space-y-4">
        {/* Flags */}
        <Card padding="md" className="fade-up">
          <p className="text-xs uppercase tracking-wider text-tg-hint">
            {t('admin_credits.section.flags')}
          </p>
          <div className="mt-2 divide-y divide-black/5 dark:divide-white/5">
            {FLAG_KEYS.map((k) => (
              <FlagRow
                key={k}
                label={t(`admin_credits.flag.${k}`)}
                value={s.flags[k]}
                onToggle={(next) =>
                  patchMutation.mutate({ key: FLAG_SETTING_KEYS[k], bool: next })
                }
                disabled={!isFounder || patchMutation.isPending}
              />
            ))}
          </div>
        </Card>

        {/* Numbers */}
        <Card padding="md" className="fade-up">
          <p className="text-xs uppercase tracking-wider text-tg-hint">
            {t('admin_credits.section.numbers')}
          </p>
          <div className="mt-2 space-y-3">
            {NUMBER_FIELDS.map((f) => (
              <NumberRow
                key={f.settingKey}
                label={t(`admin_credits.number.${f.key}`)}
                value={s.numbers[f.key]}
                onSave={(next) =>
                  patchMutation.mutate({ key: f.settingKey, number: next })
                }
                disabled={!isFounder || patchMutation.isPending}
              />
            ))}
          </div>
        </Card>

        {/* File-type overrides */}
        <Card padding="md" className="fade-up">
          <p className="text-xs uppercase tracking-wider text-tg-hint">
            {t('admin_credits.section.file_overrides')}
          </p>
          <div className="mt-2 space-y-3">
            {FILE_TYPES.map((ft) => (
              <NumberRow
                key={ft}
                label={`${ft} (override)`}
                value={s.fileTypeOverrides[ft] ?? null}
                placeholder={`inherit (${s.numbers.costDecode})`}
                onSave={(next) =>
                  patchMutation.mutate({
                    key: `credits.cost_decode.${ft}`,
                    number: next,
                  })
                }
                onClear={() =>
                  patchMutation.mutate({
                    key: `credits.cost_decode.${ft}`,
                    clear: true,
                  })
                }
                disabled={!isFounder || patchMutation.isPending}
              />
            ))}
          </div>
        </Card>

        {/* Per-user grant */}
        {isFounder && <GrantForm t={t} />}

        {/* Wave 9.2 — Stars refund tab */}
        {isFounder && <RefundsPanel t={t} />}
      </div>
    </Layout>
  );
}

/* ----------------------------------------------------------- refunds --- */

function RefundsPanel({
  t,
}: {
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const qc = useQueryClient();
  const topupsQuery = useQuery({
    queryKey: ['admin', 'credits', 'topups'] as const,
    queryFn: () => adminCreditsApi.recentTopups(50),
    staleTime: 30_000,
  });
  const refundMutation = useMutation({
    mutationFn: (input: { telegram_user_id: string; payment_charge_id: string }) =>
      adminCreditsApi.refundStars(input),
    onSuccess: () => {
      hapticNotify('success');
      qc.invalidateQueries({ queryKey: ['admin', 'credits', 'topups'] });
    },
    onError: () => {
      hapticNotify('error');
    },
  });
  const clearLockMutation = useMutation({
    mutationFn: (input: { telegram_user_id: string; write_off?: boolean }) =>
      adminCreditsApi.clearLock(input),
    onSuccess: () => {
      hapticNotify('success');
      qc.invalidateQueries({ queryKey: ['admin', 'credits', 'topups'] });
    },
    onError: () => {
      hapticNotify('error');
    },
  });

  const items = topupsQuery.data?.items ?? [];

  return (
    <Card padding="md" className="fade-up">
      <p className="text-xs uppercase tracking-wider text-tg-hint">
        {t('admin_credits.refunds.title')}
      </p>
      <p className="mt-1 text-xs text-tg-subtitle-text">{t('admin_credits.refunds.help')}</p>
      {topupsQuery.isLoading ? (
        <div className="mt-3"><SkeletonList rows={3} /></div>
      ) : items.length === 0 ? (
        <p className="mt-3 text-sm text-tg-subtitle-text">
          {t('admin_credits.refunds.empty')}
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-black/5 dark:divide-white/5">
          {items.map((row) => (
            <li key={row.id} className="py-2 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-tg-text">
                    {row.user?.username ? `@${row.user.username}` : row.user?.telegram_user_id ?? '—'}
                    {' · '}
                    {row.stars}⭐ → +{row.credits}
                  </p>
                  <p className="truncate font-mono text-[10px] text-tg-subtitle-text">
                    {row.payment_charge_id ?? '—'}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={row.refunded ? 'ghost' : 'destructive'}
                  disabled={
                    row.refunded ||
                    !row.payment_charge_id ||
                    !row.user?.telegram_user_id ||
                    refundMutation.isPending
                  }
                  onClick={async () => {
                    if (!row.payment_charge_id || !row.user?.telegram_user_id) return;
                    const ok = await showConfirm(
                      t('admin_credits.refunds.confirm', {
                        stars: row.stars ?? 0,
                        credits: row.credits ?? 0,
                      }),
                    );
                    if (!ok) return;
                    refundMutation.mutate({
                      telegram_user_id: row.user.telegram_user_id,
                      payment_charge_id: row.payment_charge_id,
                    });
                  }}
                >
                  {row.refunded
                    ? t('admin_credits.refunds.already')
                    : t('admin_credits.refunds.action')}
                </Button>
              </div>
              {row.refunded && row.user?.telegram_user_id && (
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={clearLockMutation.isPending}
                    onClick={async () => {
                      if (!row.user?.telegram_user_id) return;
                      const ok = await showConfirm(
                        t('admin_credits.refunds.confirm_clear_lock'),
                      );
                      if (!ok) return;
                      clearLockMutation.mutate({
                        telegram_user_id: row.user.telegram_user_id,
                      });
                    }}
                  >
                    {t('admin_credits.refunds.clear_lock')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={clearLockMutation.isPending}
                    onClick={async () => {
                      if (!row.user?.telegram_user_id) return;
                      const ok = await showConfirm(
                        t('admin_credits.refunds.confirm_writeoff'),
                      );
                      if (!ok) return;
                      clearLockMutation.mutate({
                        telegram_user_id: row.user.telegram_user_id,
                        write_off: true,
                      });
                    }}
                  >
                    {t('admin_credits.refunds.write_off')}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ----------------------------------------------------------- sub-rows --- */

function FlagRow({
  label,
  value,
  onToggle,
  disabled,
}: {
  label: string;
  value: boolean;
  onToggle: (next: boolean) => void;
  disabled: boolean;
}): JSX.Element {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-tg-text">{label}</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onToggle(!value)}
        className={[
          'h-7 w-12 rounded-full transition-colors',
          value ? 'bg-emerald-500' : 'bg-tg-secondary-bg',
          disabled ? 'opacity-50' : 'press-scale',
        ].join(' ')}
        aria-pressed={value}
      >
        <span
          className={[
            'block h-5 w-5 rounded-full bg-white shadow transition-transform',
            value ? 'translate-x-6' : 'translate-x-1',
          ].join(' ')}
        />
      </button>
    </div>
  );
}

function NumberRow({
  label,
  value,
  placeholder,
  onSave,
  onClear,
  disabled,
}: {
  label: string;
  value: number | null;
  placeholder?: string;
  onSave: (next: number) => void;
  onClear?: () => void;
  disabled: boolean;
}): JSX.Element {
  const [draft, setDraft] = useState<string>(value === null ? '' : String(value));

  return (
    <div className="space-y-1">
      <label className="text-xs text-tg-subtitle-text">{label}</label>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          value={draft}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          className="h-10 flex-1 rounded-xl border border-black/10 bg-tg-secondary-bg px-3 text-sm text-tg-text outline-none focus:ring-2 focus:ring-tg-link/40 dark:border-white/15"
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || draft.length === 0 || draft === String(value)}
          onClick={() => {
            const n = Number.parseInt(draft, 10);
            if (Number.isInteger(n) && n >= 0) onSave(n);
          }}
        >
          Save
        </Button>
        {onClear && value !== null && (
          <Button size="sm" variant="ghost" disabled={disabled} onClick={onClear}>
            ×
          </Button>
        )}
      </div>
    </div>
  );
}

function GrantForm({
  t,
}: {
  t: (k: string, p?: Record<string, string | number>) => string;
}): JSX.Element {
  const [tg, setTg] = useState('');
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [okMessage, setOkMessage] = useState<string | null>(null);

  const grantMutation = useMutation({
    mutationFn: () => {
      const d = Number.parseInt(delta, 10);
      if (!tg || !Number.isInteger(d) || d === 0) {
        throw new ApiError(0, 'invalid_input', 'Fill in tg id and a non-zero integer delta');
      }
      return adminCreditsApi.grant({
        telegram_user_id: tg,
        delta: d,
        ...(note ? { note } : {}),
      });
    },
    onSuccess: () => {
      hapticNotify('success');
      setOkMessage('✓ Applied');
      setError(null);
      setDelta('');
      setNote('');
    },
    onError: (err) => {
      setOkMessage(null);
      setError(err instanceof ApiError ? err.message : String(err));
    },
  });

  return (
    <Card padding="md" className="fade-up">
      <p className="text-xs uppercase tracking-wider text-tg-hint">
        {t('admin_credits.grant.title')}
      </p>
      <div className="mt-3 space-y-2">
        <input
          type="text"
          inputMode="numeric"
          value={tg}
          onChange={(e) => setTg(e.target.value.trim())}
          placeholder={t('admin_credits.grant.tg_id')}
          className="h-10 w-full rounded-xl border border-black/10 bg-tg-secondary-bg px-3 text-sm text-tg-text outline-none focus:ring-2 focus:ring-tg-link/40 dark:border-white/15"
        />
        <input
          type="text"
          inputMode="numeric"
          value={delta}
          onChange={(e) => setDelta(e.target.value.trim())}
          placeholder={t('admin_credits.grant.delta')}
          className="h-10 w-full rounded-xl border border-black/10 bg-tg-secondary-bg px-3 text-sm text-tg-text outline-none focus:ring-2 focus:ring-tg-link/40 dark:border-white/15"
        />
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('admin_credits.grant.note')}
          className="h-10 w-full rounded-xl border border-black/10 bg-tg-secondary-bg px-3 text-sm text-tg-text outline-none focus:ring-2 focus:ring-tg-link/40 dark:border-white/15"
        />
        {error && <p className="text-xs text-tg-destructive-text">{error}</p>}
        {okMessage && <p className="text-xs text-emerald-500">{okMessage}</p>}
        <Button
          block
          variant="primary"
          loading={grantMutation.isPending}
          onClick={() => grantMutation.mutate()}
        >
          {t('admin_credits.grant.submit')}
        </Button>
      </div>
    </Card>
  );
}
