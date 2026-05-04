/**
 * VaultLink Mini App — broadcast composer (v0.3.2 simplified).
 *
 * Layout — single column, hero textarea, everything else hidden behind
 * one "More options" toggle.
 *
 *  ┌──────────────────────────────┐  ← sticky preview bubble
 *  │  MessagePreview              │
 *  └──────────────────────────────┘
 *  ┌──────────────────────────────┐  ← format bar (B I U code link var)
 *  │  [textarea: hero]            │
 *  └──────────────────────────────┘
 *
 *  👥 1,234 people     ⏰ tomorrow 09:00     ⚙ More options
 *
 *  ┌──────────────────────────────┐  ← sticky bottom send bar
 *  │  💾 Save · 🚀 Send to N      │
 *  └──────────────────────────────┘
 *
 * "More options" expands a single panel containing every advanced
 * control (bot picker, parse_mode, media, inline buttons, audience
 * filter detail, schedule, flags). Default broadcast = pick bot →
 * type → send. The 80% case never opens it.
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { MessagePreview } from '../components/MessagePreview.js';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT } from '../lib/i18n.js';
import { hapticNotify } from '../lib/telegram.js';
import { useAuth } from '../providers/AuthProvider.js';
import type {
  BotSummary,
  BroadcastAudience,
  BroadcastAudiencePreview,
  BroadcastButton,
  BroadcastParseMode,
  BroadcastRow,
} from '../types/api.js';

interface ComposerState {
  bot_id: number | null;
  text: string;
  parse_mode: BroadcastParseMode | 'plain';
  buttons: BroadcastButton[][];
  media_type: '' | 'photo' | 'video' | 'document' | 'animation';
  media_file_id: string;
  disable_web_page_preview: boolean;
  protect_content: boolean;
  silent: boolean;
  audience: BroadcastAudience;
  scheduled_at: string;
}

function defaultState(): ComposerState {
  return {
    bot_id: null,
    text: '',
    parse_mode: 'HTML',
    buttons: [],
    media_type: '',
    media_file_id: '',
    disable_web_page_preview: false,
    protect_content: false,
    silent: false,
    audience: {
      locale: 'all',
      role: 'all',
      exclude_banned: true,
      exclude_unsubscribed: true,
      registered_within_days: null,
      user_ids: [],
    },
    scheduled_at: '',
  };
}

function rowToState(row: BroadcastRow): ComposerState {
  return {
    bot_id: row.bot_id,
    text: row.text,
    parse_mode: row.parse_mode ?? 'plain',
    buttons: row.buttons ?? [],
    media_type: (row.media_type as ComposerState['media_type']) || '',
    media_file_id: row.media_file_id ?? '',
    disable_web_page_preview: row.disable_web_page_preview,
    protect_content: row.protect_content,
    silent: row.silent,
    audience: row.audience,
    scheduled_at: row.scheduled_at ?? '',
  };
}

function cleanButtons(buttons: BroadcastButton[][]): BroadcastButton[][] {
  return buttons
    .map((row) =>
      row
        .map((b) => ({ text: b.text.trim(), url: b.url.trim() }))
        .filter((b) => b.text.length > 0 && b.url.length > 0),
    )
    .filter((row) => row.length > 0);
}

function stateToPayload(s: ComposerState): Record<string, unknown> {
  const audience: BroadcastAudience = {
    ...s.audience,
    user_ids: s.audience.user_ids.filter((u) => u.trim().length > 0),
  };
  const cleanedButtons = cleanButtons(s.buttons);
  return {
    bot_id: s.bot_id,
    text: s.text,
    parse_mode: s.parse_mode === 'plain' ? null : s.parse_mode,
    buttons: cleanedButtons.length > 0 ? cleanedButtons : null,
    media_type: s.media_type === '' ? null : s.media_type,
    media_file_id: s.media_file_id.trim() === '' ? null : s.media_file_id.trim(),
    disable_web_page_preview: s.disable_web_page_preview,
    protect_content: s.protect_content,
    silent: s.silent,
    audience,
  };
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [out, setOut] = useState<T>(value);
  useEffect(() => {
    const id = window.setTimeout(() => setOut(value), delayMs);
    return () => window.clearTimeout(id);
  }, [value, delayMs]);
  return out;
}

/* -------------------------------------------------------------------------- *
 * Insertion helpers
 * -------------------------------------------------------------------------- */

function wrapSelection(
  ta: HTMLTextAreaElement,
  before: string,
  after: string = before,
): { value: string; selStart: number; selEnd: number } {
  const start = ta.selectionStart ?? 0;
  const end = ta.selectionEnd ?? 0;
  const v = ta.value;
  const next = `${v.slice(0, start)}${before}${v.slice(start, end)}${after}${v.slice(end)}`;
  return { value: next, selStart: start + before.length, selEnd: end + before.length };
}

function insertAtCursor(
  ta: HTMLTextAreaElement,
  text: string,
): { value: string; selStart: number; selEnd: number } {
  const start = ta.selectionStart ?? ta.value.length;
  const end = ta.selectionEnd ?? ta.value.length;
  const v = ta.value;
  const next = `${v.slice(0, start)}${text}${v.slice(end)}`;
  const cursor = start + text.length;
  return { value: next, selStart: cursor, selEnd: cursor };
}

/* -------------------------------------------------------------------------- *
 * Composer page
 * -------------------------------------------------------------------------- */

export function BroadcastComposer(): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const editingId = params.id ? Number.parseInt(params.id, 10) : null;
  const isEditing = editingId !== null && Number.isFinite(editingId);
  const qc = useQueryClient();
  const { user: me } = useAuth();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const [state, setState] = useState<ComposerState>(defaultState());
  const [hydrated, setHydrated] = useState(!isEditing);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);

  // -------- bots --------
  const botsQuery = useQuery({
    queryKey: ['bots-for-broadcast'],
    queryFn: () =>
      apiGet<{ items: BotSummary[] }>('/admin/bots?limit=100&offset=0').catch(() =>
        apiGet<{ items: BotSummary[] }>('/bots'),
      ),
  });
  const bots = botsQuery.data?.items ?? [];

  // -------- hydrate draft --------
  const draftQuery = useQuery({
    queryKey: editingId ? qk.broadcasts.detail(editingId) : ['broadcast-noop'],
    enabled: isEditing,
    queryFn: () => apiGet<BroadcastRow>(`/broadcasts/${editingId}`),
  });
  useEffect(() => {
    if (isEditing && draftQuery.data) {
      setState(rowToState(draftQuery.data));
      setHydrated(true);
    }
  }, [isEditing, draftQuery.data]);

  // Auto-pick first bot.
  useEffect(() => {
    if (!isEditing && state.bot_id === null && bots.length > 0 && bots[0]) {
      setState((s) => ({ ...s, bot_id: bots[0]!.id }));
    }
  }, [bots, state.bot_id, isEditing]);

  // -------- live audience preview --------
  const debouncedAudience = useDebounced(state.audience, 500);
  const debouncedBotId = useDebounced(state.bot_id, 500);
  const audienceQuery = useQuery({
    queryKey: [
      'audience-live',
      debouncedBotId,
      debouncedAudience.locale,
      debouncedAudience.role,
      debouncedAudience.exclude_banned,
      debouncedAudience.exclude_unsubscribed,
      debouncedAudience.registered_within_days,
      debouncedAudience.user_ids.length,
      debouncedAudience.user_ids.join(','),
    ],
    enabled: debouncedBotId !== null,
    staleTime: 5_000,
    queryFn: () =>
      apiPost<BroadcastAudiencePreview>('/broadcasts/preview-audience', {
        bot_id: debouncedBotId,
        audience: {
          ...debouncedAudience,
          user_ids: debouncedAudience.user_ids.filter((u) => u.trim().length > 0),
        },
      }),
  });
  const audienceCount = audienceQuery.data?.count ?? null;

  /* --------------------------- mutations ------------------------------- */

  const saveDraft = useMutation({
    mutationFn: async (): Promise<BroadcastRow> => {
      const payload = stateToPayload(state);
      if (isEditing) {
        return apiPatch<BroadcastRow>(`/broadcasts/${editingId}`, payload);
      }
      return apiPost<BroadcastRow>('/broadcasts', payload);
    },
    onSuccess: (row) => {
      hapticNotify('success');
      void qc.invalidateQueries({ queryKey: qk.broadcasts.all });
      if (!isEditing) navigate(`/admin/broadcasts/${row.id}/edit`, { replace: true });
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'save failed'),
  });

  const sendNow = useMutation({
    mutationFn: async (): Promise<BroadcastRow> => {
      let id = editingId;
      if (!isEditing) {
        const created = await apiPost<BroadcastRow>('/broadcasts', stateToPayload(state));
        id = created.id;
      } else {
        await apiPatch(`/broadcasts/${id}`, stateToPayload(state));
      }
      return apiPost<BroadcastRow>(`/broadcasts/${id}/send`, { confirmation: 'SEND' });
    },
    onSuccess: (row) => {
      hapticNotify('success');
      void qc.invalidateQueries({ queryKey: qk.broadcasts.all });
      navigate(`/admin/broadcasts/${row.id}`, { replace: true });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'send failed'),
  });

  const schedule = useMutation({
    mutationFn: async (when: string): Promise<BroadcastRow> => {
      let id = editingId;
      if (!isEditing) {
        const created = await apiPost<BroadcastRow>('/broadcasts', stateToPayload(state));
        id = created.id;
      } else {
        await apiPatch(`/broadcasts/${id}`, stateToPayload(state));
      }
      return apiPost<BroadcastRow>(`/broadcasts/${id}/schedule`, { scheduled_at: when });
    },
    onSuccess: (row) => {
      hapticNotify('success');
      void qc.invalidateQueries({ queryKey: qk.broadcasts.all });
      navigate(`/admin/broadcasts/${row.id}`, { replace: true });
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'schedule failed'),
  });

  const deleteDraft = useMutation({
    mutationFn: async (): Promise<void> => {
      if (!isEditing) return;
      await apiDelete(`/broadcasts/${editingId}`);
    },
    onSuccess: () => {
      hapticNotify('success');
      void qc.invalidateQueries({ queryKey: qk.broadcasts.all });
      navigate('/admin/broadcasts', { replace: true });
    },
  });

  /* --------------------------- helpers ------------------------------- */

  const setText = (text: string): void => setState((s) => ({ ...s, text }));
  const setBotId = (bot_id: number): void => setState((s) => ({ ...s, bot_id }));
  const setParseMode = (parse_mode: ComposerState['parse_mode']): void =>
    setState((s) => ({ ...s, parse_mode }));
  const setAudience = (a: Partial<BroadcastAudience>): void =>
    setState((s) => ({ ...s, audience: { ...s.audience, ...a } }));

  const addButtonRow = (): void =>
    setState((s) => ({ ...s, buttons: [...s.buttons, [{ text: '', url: '' }]] }));
  const updateButton = (
    rowIdx: number,
    colIdx: number,
    patch: Partial<BroadcastButton>,
  ): void => {
    setState((s) => {
      const buttons = s.buttons.map((row, i) =>
        i !== rowIdx ? row : row.map((b, j) => (j !== colIdx ? b : { ...b, ...patch })),
      );
      return { ...s, buttons };
    });
  };
  const removeButton = (rowIdx: number, colIdx: number): void => {
    setState((s) => {
      const buttons = s.buttons
        .map((row, i) => (i !== rowIdx ? row : row.filter((_, j) => j !== colIdx)))
        .filter((row) => row.length > 0);
      return { ...s, buttons };
    });
  };

  const userIdsCsv = useMemo(() => state.audience.user_ids.join(', '), [state.audience.user_ids]);
  const onUserIdsChange = (e: ChangeEvent<HTMLTextAreaElement>): void => {
    const list = e.target.value
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    setAudience({ user_ids: list });
  };

  const wrap = (before: string, after?: string): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    const next = wrapSelection(ta, before, after);
    setText(next.value);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(next.selStart, next.selEnd);
    });
  };

  const insertToken = (token: string): void => {
    const ta = textareaRef.current;
    if (!ta) return;
    const next = insertAtCursor(ta, token);
    setText(next.value);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(next.selStart, next.selEnd);
    });
  };

  /* --------------------------- preview props ------------------------------- */

  const selectedBot = useMemo(
    () => bots.find((b) => b.id === state.bot_id) ?? null,
    [bots, state.bot_id],
  );
  const previewSampleUser = me
    ? {
        first_name: me.first_name,
        last_name: me.last_name,
        username: me.username,
        telegram_user_id: me.telegram_user_id,
      }
    : { first_name: 'You', last_name: null, username: null, telegram_user_id: '0' };

  const cleanedPreviewButtons = useMemo(() => cleanButtons(state.buttons), [state.buttons]);
  const hasMedia = state.media_type !== '' && state.media_file_id.trim().length > 0;

  /* --------------------------- error banner ------------------------------- */

  const errBanner = error || saveDraft.error || sendNow.error;
  const errMsg =
    errBanner instanceof Error ? errBanner.message : typeof errBanner === 'string' ? errBanner : '';

  if (isEditing && (!hydrated || draftQuery.isLoading)) {
    return (
      <Layout title={t('broadcast.composer.title')} back={() => navigate(-1)} hideNav>
        <SkeletonList rows={4} lines={2} />
      </Layout>
    );
  }
  if (isEditing && draftQuery.isError) {
    return (
      <Layout title={t('broadcast.composer.title')} back={() => navigate(-1)} hideNav>
        <ErrorState
          message={
            draftQuery.error instanceof Error ? draftQuery.error.message : undefined
          }
          onRetry={() => draftQuery.refetch()}
        />
      </Layout>
    );
  }

  /* --------------------------- chips data ------------------------------- */

  const formatChips: Array<{ label: string; wrap: readonly [string, string] }> =
    state.parse_mode === 'HTML'
      ? [
          { label: 'B', wrap: ['<b>', '</b>'] },
          { label: 'I', wrap: ['<i>', '</i>'] },
          { label: 'U', wrap: ['<u>', '</u>'] },
          { label: '</>', wrap: ['<code>', '</code>'] },
          { label: '🔗', wrap: ['<a href="https://">', '</a>'] },
        ]
      : state.parse_mode === 'MarkdownV2'
      ? [
          { label: 'B', wrap: ['*', '*'] },
          { label: 'I', wrap: ['_', '_'] },
          { label: 'U', wrap: ['__', '__'] },
          { label: '</>', wrap: ['`', '`'] },
          { label: '🔗', wrap: ['[', '](https://)'] },
        ]
      : [];

  const sendDisabled =
    state.bot_id === null ||
    state.text.trim().length === 0 ||
    audienceCount === 0;

  const audiencePill =
    audienceCount === null
      ? t('broadcast.composer.audience_pick_bot')
      : audienceCount === 0
      ? t('broadcast.composer.audience_empty')
      : `${audienceCount.toLocaleString()} ${t('broadcast.composer.recipients')}`;

  const scheduledLabel = state.scheduled_at
    ? new Date(state.scheduled_at).toLocaleString()
    : '';

  /* --------------------------- render ------------------------------- */

  return (
    <Layout title={t('broadcast.composer.title')} back={() => navigate(-1)} hideNav>
      {/* Sticky 1:1 preview */}
      <div className="sticky top-0 z-10 -mx-4 mb-3 bg-tg-bg/90 px-4 py-2 backdrop-blur">
        <MessagePreview
          text={state.text}
          parseMode={state.parse_mode}
          buttons={cleanedPreviewButtons}
          mediaType={state.media_type}
          hasMedia={hasMedia}
          botName={selectedBot?.display_name ?? selectedBot?.username ?? 'bot'}
          botUsername={selectedBot?.username}
          sampleUser={previewSampleUser}
          mediaLabel={t('broadcast.composer.media')}
        />
      </div>

      {errMsg ? (
        <p className="mb-3 rounded-xl bg-tg-destructive-text/10 px-3 py-2 text-xs text-tg-destructive-text">
          {errMsg}
        </p>
      ) : null}

      {/* Hero textarea + format bar (the only thing 80% of users touch) */}
      <Card padding="sm" className="mb-2">
        {formatChips.length > 0 ? (
          <div className="mb-2 flex flex-wrap gap-1">
            {formatChips.map((c) => (
              <button
                key={c.label}
                type="button"
                onClick={() => wrap(c.wrap[0], c.wrap[1])}
                className="press-scale rounded-md bg-tg-secondary-bg px-2 py-1 font-mono text-[11px] font-semibold text-tg-link"
              >
                {c.label}
              </button>
            ))}
            <span className="mx-1 h-5 w-px bg-tg-secondary-bg" aria-hidden="true" />
            {(['{{first_name}}', '{{username}}'] as const).map((tok) => (
              <button
                key={tok}
                type="button"
                onClick={() => insertToken(tok)}
                className="press-scale rounded-md bg-tg-secondary-bg px-2 py-1 font-mono text-[10px] text-tg-subtitle-text hover:text-tg-link"
              >
                {tok}
              </button>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          value={state.text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('broadcast.composer.text_placeholder')}
          rows={6}
          className="w-full resize-none rounded-xl border border-black/10 bg-tg-secondary-bg px-3 py-2 text-sm text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
        />
      </Card>

      {/* Status row — single line summarizing every important setting */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5 text-[11px]">
        <span
          className={[
            'rounded-full px-2.5 py-1 font-semibold',
            audienceCount === null || audienceCount === 0
              ? 'bg-tg-destructive-text/10 text-tg-destructive-text'
              : 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
          ].join(' ')}
        >
          👥 {audiencePill}
        </span>
        {scheduledLabel ? (
          <span className="rounded-full bg-blue-500/10 px-2.5 py-1 font-semibold text-blue-600 dark:text-blue-400">
            ⏰ {scheduledLabel}
          </span>
        ) : null}
        {state.media_type !== '' ? (
          <span className="rounded-full bg-tg-secondary-bg px-2.5 py-1 font-semibold text-tg-subtitle-text">
            🖼️ {state.media_type}
          </span>
        ) : null}
        {cleanedPreviewButtons.length > 0 ? (
          <span className="rounded-full bg-tg-secondary-bg px-2.5 py-1 font-semibold text-tg-subtitle-text">
            🔘 {cleanedPreviewButtons.flat().length}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => setOptionsOpen((v) => !v)}
          className="press-scale ml-auto rounded-full bg-tg-secondary-bg px-2.5 py-1 font-semibold text-tg-link"
        >
          {optionsOpen ? '▴' : '▾'} {t('broadcast.composer.more_options')}
        </button>
      </div>

      {/* Single "More options" panel — every advanced control lives here */}
      {optionsOpen ? (
        <Card padding="md" className="mb-3 space-y-4 animate-fade-up">
          {/* Bot picker — only useful with multiple bots */}
          {bots.length > 1 ? (
            <Section title={t('broadcast.composer.bot')}>
              <select
                value={state.bot_id ?? ''}
                onChange={(e) => setBotId(Number.parseInt(e.target.value, 10))}
                className="w-full rounded-xl border border-black/10 bg-tg-secondary-bg px-3 py-2 text-sm text-tg-text focus:border-tg-link focus:outline-none dark:border-white/10"
              >
                <option value="">{t('broadcast.composer.bot_placeholder')}</option>
                {bots.map((b) => (
                  <option key={b.id} value={b.id}>
                    @{b.username}
                    {b.display_name ? ` · ${b.display_name}` : ''}
                  </option>
                ))}
              </select>
            </Section>
          ) : null}

          {/* Format mode */}
          <Section title={t('broadcast.composer.format_mode')}>
            <div className="flex flex-wrap gap-1.5">
              {(['HTML', 'MarkdownV2', 'plain'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setParseMode(m)}
                  className={[
                    'press-scale rounded-full px-3 py-1 text-[11px] font-semibold',
                    state.parse_mode === m
                      ? 'bg-gradient-hero text-white shadow-soft'
                      : 'bg-tg-secondary-bg text-tg-subtitle-text',
                  ].join(' ')}
                >
                  {m === 'plain' ? 'Plain' : m}
                </button>
              ))}
            </div>
          </Section>

          {/* Audience filter */}
          <Section title={t('broadcast.composer.audience')}>
            <div className="grid grid-cols-2 gap-2">
              <select
                value={state.audience.locale}
                onChange={(e) =>
                  setAudience({ locale: e.target.value as BroadcastAudience['locale'] })
                }
                className="w-full rounded-lg border border-black/10 bg-tg-secondary-bg px-2 py-1.5 text-xs text-tg-text focus:border-tg-link focus:outline-none dark:border-white/10"
              >
                <option value="all">🌐 {t('broadcast.composer.locale_all')}</option>
                <option value="en">🇬🇧 English</option>
                <option value="th">🇹🇭 ไทย</option>
              </select>
              <select
                value={state.audience.role}
                onChange={(e) =>
                  setAudience({ role: e.target.value as BroadcastAudience['role'] })
                }
                className="w-full rounded-lg border border-black/10 bg-tg-secondary-bg px-2 py-1.5 text-xs text-tg-text focus:border-tg-link focus:outline-none dark:border-white/10"
              >
                <option value="all">{t('broadcast.composer.role_all')}</option>
                <option value="user">user</option>
                <option value="super_admin">super_admin</option>
              </select>
            </div>
            <input
              type="number"
              min={1}
              value={state.audience.registered_within_days ?? ''}
              onChange={(e) => {
                const n = Number.parseInt(e.target.value, 10);
                setAudience({
                  registered_within_days: Number.isFinite(n) && n > 0 ? n : null,
                });
              }}
              placeholder={t('broadcast.composer.registered_within_placeholder')}
              className="mt-2 w-full rounded-lg border border-black/10 bg-tg-secondary-bg px-2 py-1.5 text-xs text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
            />
            <textarea
              rows={2}
              value={userIdsCsv}
              onChange={onUserIdsChange}
              placeholder={t('broadcast.composer.user_ids_placeholder')}
              className="mt-2 w-full resize-none rounded-lg border border-black/10 bg-tg-secondary-bg px-2 py-1.5 text-xs text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
            />
          </Section>

          {/* Schedule */}
          <Section title={t('broadcast.composer.schedule')}>
            <div className="flex gap-2">
              <input
                type="datetime-local"
                value={state.scheduled_at}
                onChange={(e) => setState((s) => ({ ...s, scheduled_at: e.target.value }))}
                className="flex-1 rounded-xl border border-black/10 bg-tg-secondary-bg px-3 py-1.5 text-xs text-tg-text focus:border-tg-link focus:outline-none dark:border-white/10"
              />
              {state.scheduled_at ? (
                <button
                  type="button"
                  onClick={() => setState((s) => ({ ...s, scheduled_at: '' }))}
                  className="press-scale rounded-xl bg-tg-secondary-bg px-3 text-xs font-semibold text-tg-subtitle-text"
                >
                  ×
                </button>
              ) : null}
            </div>
          </Section>

          {/* Media */}
          <Section title={t('broadcast.composer.media')}>
            <div className="grid grid-cols-5 gap-1.5 text-[11px]">
              {(['', 'photo', 'video', 'document', 'animation'] as const).map((m) => (
                <button
                  key={m || 'none'}
                  type="button"
                  onClick={() => setState((s) => ({ ...s, media_type: m }))}
                  className={[
                    'press-scale rounded-full px-2 py-1 font-semibold',
                    state.media_type === m
                      ? 'bg-gradient-hero text-white shadow-soft'
                      : 'bg-tg-secondary-bg text-tg-subtitle-text',
                  ].join(' ')}
                >
                  {m === '' ? t('broadcast.composer.media_none') : m}
                </button>
              ))}
            </div>
            {state.media_type !== '' ? (
              <input
                value={state.media_file_id}
                onChange={(e) => setState((s) => ({ ...s, media_file_id: e.target.value }))}
                placeholder={t('broadcast.composer.media_file_id_placeholder')}
                className="mt-2 w-full rounded-xl border border-black/10 bg-tg-secondary-bg px-3 py-2 font-mono text-xs text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
              />
            ) : null}
          </Section>

          {/* Inline buttons */}
          <Section title={t('broadcast.composer.buttons')}>
            <button
              type="button"
              onClick={addButtonRow}
              className="press-scale w-full rounded-xl bg-tg-secondary-bg px-3 py-1.5 text-[11px] font-semibold text-tg-link"
            >
              + {t('broadcast.composer.add_row')}
            </button>
            {state.buttons.length > 0 ? (
              <div className="mt-2 space-y-2">
                {state.buttons.map((row, ri) => (
                  <div key={ri} className="rounded-xl bg-tg-secondary-bg/60 p-2">
                    {row.map((btn, ci) => (
                      <div key={ci} className="mb-1 flex gap-1.5">
                        <input
                          value={btn.text}
                          onChange={(e) => updateButton(ri, ci, { text: e.target.value })}
                          placeholder={t('broadcast.composer.button_text')}
                          className="flex-1 rounded-lg border border-black/10 bg-tg-bg px-2 py-1.5 text-xs text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
                        />
                        <input
                          value={btn.url}
                          onChange={(e) => updateButton(ri, ci, { url: e.target.value })}
                          placeholder="https://"
                          className="flex-[1.5] rounded-lg border border-black/10 bg-tg-bg px-2 py-1.5 text-xs text-tg-link placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
                        />
                        <button
                          type="button"
                          onClick={() => removeButton(ri, ci)}
                          className="press-scale rounded-lg bg-tg-destructive-text/10 px-2 text-xs font-semibold text-tg-destructive-text"
                          aria-label={t('broadcast.composer.remove_button')}
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}
          </Section>

          {/* Flags */}
          <Section title={t('broadcast.composer.flags')}>
            <div className="grid grid-cols-1 gap-1.5 text-[11px]">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.silent}
                  onChange={(e) => setState((s) => ({ ...s, silent: e.target.checked }))}
                />
                🔕 {t('broadcast.composer.flags.silent')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.protect_content}
                  onChange={(e) =>
                    setState((s) => ({ ...s, protect_content: e.target.checked }))
                  }
                />
                🔒 {t('broadcast.composer.flags.protect')}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.disable_web_page_preview}
                  onChange={(e) =>
                    setState((s) => ({ ...s, disable_web_page_preview: e.target.checked }))
                  }
                />
                🚫 {t('broadcast.composer.flags.no_preview')}
              </label>
            </div>
          </Section>

          <label className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={state.audience.exclude_banned}
              onChange={(e) => setAudience({ exclude_banned: e.target.checked })}
            />
            {t('broadcast.composer.exclude_banned')}
          </label>
          <label className="flex items-center gap-2 text-[11px]">
            <input
              type="checkbox"
              checked={state.audience.exclude_unsubscribed}
              onChange={(e) => setAudience({ exclude_unsubscribed: e.target.checked })}
            />
            {t('broadcast.composer.exclude_unsubscribed')}
          </label>
        </Card>
      ) : null}

      {/* Sticky bottom bar */}
      <div className="sticky bottom-3 z-10 mt-4 flex flex-col gap-2 rounded-2xl bg-tg-bg/95 p-2 shadow-glow backdrop-blur">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => saveDraft.mutate()}
            loading={saveDraft.isPending}
            disabled={state.bot_id === null || state.text.trim().length === 0}
          >
            💾
          </Button>
          <Button
            variant="primary"
            size="sm"
            block
            onClick={() =>
              state.scheduled_at
                ? schedule.mutate(new Date(state.scheduled_at).toISOString())
                : setConfirmOpen(true)
            }
            disabled={sendDisabled}
            loading={schedule.isPending}
          >
            {state.scheduled_at
              ? `⏰ ${t('broadcast.composer.schedule')}`
              : audienceCount && audienceCount > 0
              ? `🚀 ${t('broadcast.composer.send_to', { n: audienceCount.toLocaleString() })}`
              : `🚀 ${t('broadcast.composer.send_now')}`}
          </Button>
          {isEditing ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleteDraft.mutate()}
              loading={deleteDraft.isPending}
            >
              🗑
            </Button>
          ) : null}
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        title={t('broadcast.composer.confirm.title')}
        message={
          <>
            <p>
              {t('broadcast.composer.confirm.message', {
                n: audienceCount !== null ? audienceCount.toLocaleString() : '?',
              })}
            </p>
            <p className="mt-2 text-tg-destructive-text">
              {t('broadcast.composer.confirm.type_send')}
            </p>
          </>
        }
        inputLabel="SEND"
        inputPlaceholder="SEND"
        confirmLabel={t('broadcast.composer.send_now')}
        destructive
        loading={sendNow.isPending}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={(v) => {
          if (v !== 'SEND') {
            setError(t('broadcast.composer.confirm.type_send'));
            return;
          }
          setConfirmOpen(false);
          sendNow.mutate();
        }}
      />
    </Layout>
  );
}

/** Tiny labeled section inside the "More options" panel. */
function Section({ title, children }: { title: string; children: ReactNode }): JSX.Element {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-tg-hint">
        {title}
      </p>
      {children}
    </div>
  );
}
