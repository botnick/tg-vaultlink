/**
 * VaultLink Mini App — broadcast composer.
 *
 * Single-screen create / edit-draft form. Strategy: keep state local in
 * a ref-shaped object so re-renders don't churn the textarea, then
 * serialize on every save / preview. The page covers:
 *
 *   - bot picker (founder lists every bot; non-founder lists their own)
 *   - text + parse_mode + flags
 *   - inline buttons editor (rows × columns)
 *   - audience filter (locale, role, exclude flags, registered-within,
 *     explicit user_ids list)
 *   - live audience preview (count + 5 sample users)
 *   - "Save draft" / "Send now" / "Schedule"
 *   - typed confirmation dialog before send
 *
 * The composer treats `text + buttons + media + flags` as a single
 * "content" object and `audience` as a separate object — the backend
 * accepts both as a single PATCH so partial saves don't surprise users.
 */

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Layout } from '../components/Layout.js';
import { Card } from '../components/Card.js';
import { Button } from '../components/Button.js';
import { ErrorState } from '../components/ErrorState.js';
import { SkeletonList } from '../components/SkeletonCard.js';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api.js';
import { qk } from '../lib/queryKeys.js';
import { useT } from '../lib/i18n.js';
import { hapticNotify } from '../lib/telegram.js';
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

/** The DB and API accept null parse_mode for "plain"; the UI uses 'plain' as
 * a sentinel so the radio knob reads cleanly. Translate on the way out. */
function stateToPayload(s: ComposerState): Record<string, unknown> {
  const audience: BroadcastAudience = {
    ...s.audience,
    user_ids: s.audience.user_ids.filter((u) => u.trim().length > 0),
  };
  return {
    bot_id: s.bot_id,
    text: s.text,
    parse_mode: s.parse_mode === 'plain' ? null : s.parse_mode,
    buttons: s.buttons.length > 0 ? s.buttons : null,
    media_type: s.media_type === '' ? null : s.media_type,
    media_file_id: s.media_file_id.trim() === '' ? null : s.media_file_id.trim(),
    disable_web_page_preview: s.disable_web_page_preview,
    protect_content: s.protect_content,
    silent: s.silent,
    audience,
  };
}

export function BroadcastComposer(): JSX.Element {
  const t = useT();
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const editingId = params.id ? Number.parseInt(params.id, 10) : null;
  const isEditing = editingId !== null && Number.isFinite(editingId);
  const qc = useQueryClient();

  const [state, setState] = useState<ComposerState>(defaultState());
  const [hydrated, setHydrated] = useState(!isEditing);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<BroadcastAudiencePreview | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);

  // Bot list — required for the picker. Founders see every bot.
  const botsQuery = useQuery({
    queryKey: ['bots-for-broadcast'],
    queryFn: () =>
      apiGet<{ items: BotSummary[] }>('/admin/bots?limit=100&offset=0').catch(() =>
        apiGet<{ items: BotSummary[] }>('/bots'),
      ),
  });
  const bots = botsQuery.data?.items ?? [];

  // Hydrate the form from an existing draft.
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

  // Default the bot to the first one once bots are loaded.
  useEffect(() => {
    if (!isEditing && state.bot_id === null && bots.length > 0 && bots[0]) {
      setState((s) => ({ ...s, bot_id: bots[0]!.id }));
    }
  }, [bots, state.bot_id, isEditing]);

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

  const previewAudience = useMutation({
    mutationFn: async (): Promise<BroadcastAudiencePreview> => {
      // Save first if dirty so the server's preview uses the freshest draft.
      let id = editingId;
      if (!isEditing) {
        const created = await apiPost<BroadcastRow>('/broadcasts', stateToPayload(state));
        id = created.id;
        navigate(`/admin/broadcasts/${id}/edit`, { replace: true });
      } else {
        await apiPatch(`/broadcasts/${id}`, stateToPayload(state));
      }
      return apiPost<BroadcastAudiencePreview>(
        `/broadcasts/${id}/audience-preview`,
        {},
      );
    },
    onSuccess: (p) => {
      setPreview(p);
      setError(null);
    },
    onError: (err) => setError(err instanceof Error ? err.message : 'preview failed'),
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
  const addButtonToRow = (rowIdx: number): void => {
    setState((s) => {
      const buttons = s.buttons.map((row, i) =>
        i !== rowIdx ? row : [...row, { text: '', url: '' }],
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

  const errBanner = error || saveDraft.error || sendNow.error || previewAudience.error;
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

  return (
    <Layout title={t('broadcast.composer.title')} back={() => navigate(-1)} hideNav>
      {errMsg ? (
        <p className="mb-3 rounded-xl bg-tg-destructive-text/10 px-3 py-2 text-xs text-tg-destructive-text">
          {errMsg}
        </p>
      ) : null}

      {/* ----- Bot picker ----- */}
      <Card padding="sm" className="mb-3">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-tg-hint">
            {t('broadcast.composer.bot')}
          </span>
          <select
            value={state.bot_id ?? ''}
            onChange={(e) => setBotId(Number.parseInt(e.target.value, 10))}
            className="mt-1 w-full rounded-xl border border-black/10 bg-tg-secondary-bg px-3 py-2 text-sm text-tg-text focus:border-tg-link focus:outline-none dark:border-white/10"
          >
            <option value="">{t('broadcast.composer.bot_placeholder')}</option>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                @{b.username}
                {b.display_name ? ` · ${b.display_name}` : ''}
              </option>
            ))}
          </select>
        </label>
      </Card>

      {/* ----- Content ----- */}
      <Card padding="sm" className="mb-3">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wider text-tg-hint">
            {t('broadcast.composer.text')}
          </span>
          <textarea
            value={state.text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('broadcast.composer.text_placeholder')}
            rows={6}
            className="mt-1 w-full resize-none rounded-xl border border-black/10 bg-tg-secondary-bg px-3 py-2 text-sm text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
          />
          <p className="mt-1 text-[10px] text-tg-hint">
            {state.text.length} {t('broadcast.composer.chars')} ·{' '}
            {t('broadcast.composer.template_hint')}
          </p>
        </label>

        <div className="mt-3 flex flex-wrap gap-2">
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
              {m}
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.silent}
              onChange={(e) => setState((s) => ({ ...s, silent: e.target.checked }))}
            />
            {t('broadcast.composer.flags.silent')}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.protect_content}
              onChange={(e) => setState((s) => ({ ...s, protect_content: e.target.checked }))}
            />
            {t('broadcast.composer.flags.protect')}
          </label>
          <label className="flex items-center gap-2 col-span-2">
            <input
              type="checkbox"
              checked={state.disable_web_page_preview}
              onChange={(e) =>
                setState((s) => ({ ...s, disable_web_page_preview: e.target.checked }))
              }
            />
            {t('broadcast.composer.flags.no_preview')}
          </label>
        </div>
      </Card>

      {/* ----- Media ----- */}
      <Card padding="sm" className="mb-3">
        <p className="text-[10px] uppercase tracking-wider text-tg-hint">
          {t('broadcast.composer.media')}
        </p>
        <div className="mt-2 grid grid-cols-5 gap-1.5 text-[11px]">
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
            className="mt-2 w-full rounded-xl border border-black/10 bg-tg-secondary-bg px-3 py-2 text-xs text-tg-text font-mono placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
          />
        ) : null}
        <p className="mt-2 text-[10px] text-tg-hint">{t('broadcast.composer.media_hint')}</p>
      </Card>

      {/* ----- Inline buttons ----- */}
      <Card padding="sm" className="mb-3">
        <div className="flex items-center justify-between">
          <p className="text-[10px] uppercase tracking-wider text-tg-hint">
            {t('broadcast.composer.buttons')}
          </p>
          <button
            type="button"
            onClick={addButtonRow}
            className="press-scale rounded-full bg-tg-secondary-bg px-3 py-1 text-[11px] font-semibold text-tg-link"
          >
            + {t('broadcast.composer.add_row')}
          </button>
        </div>
        {state.buttons.length === 0 ? (
          <p className="mt-2 text-[11px] text-tg-hint">{t('broadcast.composer.buttons_empty')}</p>
        ) : (
          <div className="mt-2 space-y-2">
            {state.buttons.map((row, ri) => (
              <div key={ri} className="rounded-xl bg-tg-secondary-bg/60 p-2">
                {row.map((btn, ci) => (
                  <div key={ci} className="mb-1.5 flex gap-1.5">
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
                <button
                  type="button"
                  onClick={() => addButtonToRow(ri)}
                  className="press-scale w-full rounded-lg bg-tg-bg/50 px-2 py-1 text-[10px] font-semibold text-tg-link"
                >
                  + {t('broadcast.composer.add_button')}
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ----- Audience filter ----- */}
      <Card padding="sm" className="mb-3">
        <p className="text-[10px] uppercase tracking-wider text-tg-hint">
          {t('broadcast.composer.audience')}
        </p>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-[10px] text-tg-hint">{t('broadcast.composer.locale')}</span>
            <select
              value={state.audience.locale}
              onChange={(e) =>
                setAudience({ locale: e.target.value as BroadcastAudience['locale'] })
              }
              className="mt-1 w-full rounded-lg border border-black/10 bg-tg-secondary-bg px-2 py-1.5 text-xs text-tg-text focus:border-tg-link focus:outline-none dark:border-white/10"
            >
              <option value="all">{t('broadcast.composer.locale_all')}</option>
              <option value="en">English</option>
              <option value="th">ไทย</option>
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] text-tg-hint">{t('broadcast.composer.role')}</span>
            <select
              value={state.audience.role}
              onChange={(e) => setAudience({ role: e.target.value as BroadcastAudience['role'] })}
              className="mt-1 w-full rounded-lg border border-black/10 bg-tg-secondary-bg px-2 py-1.5 text-xs text-tg-text focus:border-tg-link focus:outline-none dark:border-white/10"
            >
              <option value="all">{t('broadcast.composer.role_all')}</option>
              <option value="user">user</option>
              <option value="super_admin">super_admin</option>
            </select>
          </label>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.audience.exclude_banned}
              onChange={(e) => setAudience({ exclude_banned: e.target.checked })}
            />
            {t('broadcast.composer.exclude_banned')}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.audience.exclude_unsubscribed}
              onChange={(e) => setAudience({ exclude_unsubscribed: e.target.checked })}
            />
            {t('broadcast.composer.exclude_unsubscribed')}
          </label>
        </div>

        <label className="mt-2 block">
          <span className="text-[10px] text-tg-hint">
            {t('broadcast.composer.registered_within')}
          </span>
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
            className="mt-1 w-full rounded-lg border border-black/10 bg-tg-secondary-bg px-2 py-1.5 text-xs text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
          />
        </label>

        <label className="mt-2 block">
          <span className="text-[10px] text-tg-hint">
            {t('broadcast.composer.user_ids')}
          </span>
          <textarea
            rows={2}
            value={userIdsCsv}
            onChange={onUserIdsChange}
            placeholder={t('broadcast.composer.user_ids_placeholder')}
            className="mt-1 w-full resize-none rounded-lg border border-black/10 bg-tg-secondary-bg px-2 py-1.5 text-xs text-tg-text placeholder:text-tg-hint focus:border-tg-link focus:outline-none dark:border-white/10"
          />
        </label>

        <button
          type="button"
          onClick={() => previewAudience.mutate()}
          disabled={previewAudience.isPending || state.bot_id === null || state.text.length === 0}
          className="press-scale mt-3 w-full rounded-full bg-tg-secondary-bg py-2 text-xs font-semibold text-tg-link disabled:opacity-50"
        >
          {previewAudience.isPending
            ? t('broadcast.composer.previewing')
            : t('broadcast.composer.preview_audience')}
        </button>
        {preview ? (
          <div className="mt-2 rounded-xl bg-tg-secondary-bg/60 p-2 text-[11px]">
            <p className="font-semibold text-tg-text">
              {preview.count.toLocaleString()} {t('broadcast.composer.recipients')}
            </p>
            {preview.sample.length > 0 ? (
              <ul className="mt-1 space-y-0.5 text-tg-subtitle-text">
                {preview.sample.map((u) => (
                  <li key={u.id} className="truncate">
                    {u.username ? `@${u.username}` : `#${u.id}`}
                    {u.first_name ? ` · ${u.first_name}` : ''}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </Card>

      {/* ----- Action bar ----- */}
      <div className="sticky bottom-3 z-10 flex flex-col gap-2 rounded-2xl bg-tg-bg/95 p-2 shadow-glow backdrop-blur">
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            block
            onClick={() => saveDraft.mutate()}
            loading={saveDraft.isPending}
            disabled={state.bot_id === null || state.text.trim().length === 0}
          >
            {t('broadcast.composer.save_draft')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            block
            onClick={() => setConfirmOpen(true)}
            disabled={state.bot_id === null || state.text.trim().length === 0}
          >
            {t('broadcast.composer.send_now')}
          </Button>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            block
            onClick={() => setScheduleOpen(true)}
            disabled={state.bot_id === null || state.text.trim().length === 0}
          >
            {t('broadcast.composer.schedule')}
          </Button>
          {isEditing ? (
            <Button
              variant="destructive"
              size="sm"
              block
              onClick={() => deleteDraft.mutate()}
              loading={deleteDraft.isPending}
            >
              {t('broadcast.composer.delete_draft')}
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
                n: preview ? preview.count.toLocaleString() : '?',
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

      <ConfirmDialog
        open={scheduleOpen}
        title={t('broadcast.composer.schedule_dialog.title')}
        message={t('broadcast.composer.schedule_dialog.message')}
        inputLabel={t('broadcast.composer.schedule_dialog.input')}
        inputPlaceholder="2026-05-10T09:00"
        inputType="text"
        inputDefaultValue={state.scheduled_at}
        confirmLabel={t('broadcast.composer.schedule')}
        loading={schedule.isPending}
        onCancel={() => setScheduleOpen(false)}
        onConfirm={(v) => {
          if (!v || v.trim().length === 0) {
            setError('scheduled_at required');
            return;
          }
          setScheduleOpen(false);
          schedule.mutate(v);
        }}
      />
    </Layout>
  );
}
