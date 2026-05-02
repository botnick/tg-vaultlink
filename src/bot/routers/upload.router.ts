/**
 * Upload router — every supported attachment kind funnels into one handler.
 *
 * Session-based bundling with explicit confirmation. One session per
 * `(bot, user)` accumulates inbound media into a Collection draft. After
 * a short idle window (1.5 s since the last upload) the bot posts (or
 * edits) a "🛑 End adding?" prompt with live counts and a single button
 * to finalise. Sending more files extends the session and refreshes the
 * prompt; sending plain text sets the collection description; clicking
 * the button finalises and ships the share code.
 *
 * Final shape on close:
 *   - 0 items                        → silent drop (defensive).
 *   - 1 item, no description         → single-file share (less chrome).
 *   - 1 item with description, or 2+ → real Collection.
 *
 * The displayed share code carries a type-count suffix
 * (`mybot:CODE_<n>P_<m>V_<k>D`) so the recipient sees what's behind it
 * at a glance. Deep links use the bare base code only.
 *
 * Safety nets: if the user never clicks the button, a hard timer
 * auto-finalises the session 5 min after the last upload so drafts
 * cannot get stuck. Rate-limit is consumed once per session
 * (a rejected first item drops a sentinel so the rest of an in-flight
 * album stays silent).
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { extractFileMeta, type ExtractedFileMeta } from '../../utils/fileMeta.js';
import { escapeHtml } from '../../utils/safeText.js';
import { AppError } from '../../utils/errors.js';
import { getLogger } from '../../logger/logger.js';
import { t } from '../../utils/i18n.js';
import type { Locale, FileType, CollectionDraftRow } from '../../types/index.js';

const ATTACHMENT_QUERIES: Array<
  | 'message:document'
  | 'message:photo'
  | 'message:video'
  | 'message:audio'
  | 'message:voice'
  | 'message:animation'
  | 'message:sticker'
> = [
  'message:document',
  'message:photo',
  'message:video',
  'message:audio',
  'message:voice',
  'message:animation',
  'message:sticker',
];

/** Idle window after the last upload before the prompt is posted/edited. */
const PROMPT_DEBOUNCE_MS = 1500;

/** Hard timeout — auto-finalise after this much idle so drafts never stick. */
const HARD_TIMEOUT_MS = 5 * 60 * 1000;

/** Lifetime of a 'rejected' sentinel. Long enough to swallow the rest of an
 * in-flight album, short enough that the next legitimate upload isn't held. */
const SESSION_REJECT_TTL_MS = 30_000;

/** Callback data for the "End adding" button. No args — session lookup uses
 * `(bot.id, user.id)` from ctx. */
const FINISH_CALLBACK = 'session:finish';

type Session =
  | {
      kind: 'active';
      draftId: number;
      chatId: number;
      /** message_id of the currently-posted prompt (so we can edit/delete it). */
      promptMessageId: number | null;
      /** Debounce: schedules the next prompt update. */
      promptTimer: ReturnType<typeof setTimeout>;
      /** Safety net: auto-finalise the session if the user goes away. */
      hardTimer: ReturnType<typeof setTimeout>;
    }
  | {
      kind: 'rejected';
      timer: ReturnType<typeof setTimeout>;
    };

function sessionKey(botId: number, userId: number): string {
  return `${botId}:${userId}`;
}

function pickLocale(ctx: AppContext): Locale {
  return ctx.user.locale === 'th' || ctx.user.locale === 'en'
    ? ctx.user.locale
    : ctx.config.DEFAULT_LOCALE;
}

export function registerUploadRouter(composer: Composer<AppContext>): void {
  // Per-bot, per-user session map. Lives only in memory — drafts are
  // persisted in SQLite, so a hard restart loses at most an in-flight
  // session (no data loss).
  const sessions = new Map<string, Session>();

  composer.on(ATTACHMENT_QUERIES, async (ctx) => {
    const decision = ctx.services.permission.canUpload(ctx.user, ctx.bot);
    if (!decision.allowed) {
      await ctx.reply(ctx.t('upload.permission_denied'));
      return;
    }

    const message = ctx.message;
    if (!message) return;

    const meta = extractFileMeta(message);
    if (!meta) {
      await ctx.reply(ctx.t('upload.no_file'));
      return;
    }

    const key = sessionKey(ctx.bot.id, ctx.user.id);
    const existing = sessions.get(key);

    // Continuation of a previously-rejected session: silently swallow.
    if (existing?.kind === 'rejected') {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => sessions.delete(key), SESSION_REJECT_TTL_MS);
      return;
    }

    // First upload in a new session pays the rate slot; subsequent uploads
    // skip the check.
    if (!existing) {
      const rl = ctx.services.rateLimit.check('upload', ctx.user.telegram_user_id);
      if (!rl.allowed) {
        try {
          await ctx.reply(ctx.t('common.error.rate_limited'));
        } catch {
          // best-effort
        }
        const evictTimer = setTimeout(() => sessions.delete(key), SESSION_REJECT_TTL_MS);
        sessions.set(key, { kind: 'rejected', timer: evictTimer });
        return;
      }
    }

    // Resolve the active session (creating one if needed).
    let session: Extract<Session, { kind: 'active' }>;
    if (!existing) {
      let draft;
      try {
        draft = ctx.services.share.createCollectionDraft(ctx.user, ctx.bot);
      } catch (err) {
        if (err instanceof AppError && err.expose) {
          await ctx.reply(err.message);
          return;
        }
        throw err;
      }
      session = {
        kind: 'active',
        draftId: draft.id,
        chatId: message.chat?.id ?? ctx.chat?.id ?? 0,
        promptMessageId: null,
        // Replaced before reachable.
        promptTimer: setTimeout(() => undefined, 0),
        hardTimer: setTimeout(() => undefined, 0),
      };
      clearTimeout(session.promptTimer);
      clearTimeout(session.hardTimer);
      sessions.set(key, session);
    } else {
      session = existing;
    }

    // Append item to the draft.
    try {
      const draft = ctx.repos.collectionDrafts.findById(session.draftId);
      if (!draft) {
        sessions.delete(key);
        getLogger().warn({ key, draftId: session.draftId }, 'session draft disappeared mid-upload');
        return;
      }
      ctx.services.share.addItemToDraft(draft, meta);
    } catch (err) {
      if (err instanceof AppError && err.expose) {
        await ctx.reply(err.message);
        return;
      }
      throw err;
    }

    armSessionTimers(session, key, sessions, ctx);
  });

  // Description capture: a plain-text message during an active session is
  // taken as the collection description. Registered EARLIER than the decode
  // router via composer ordering in createBot.ts so this handler wins when
  // a session is open.
  composer.on('message:text', async (ctx, next) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return next();

    const key = sessionKey(ctx.bot.id, ctx.user.id);
    const session = sessions.get(key);
    if (!session || session.kind !== 'active') {
      return next();
    }

    const draft = ctx.repos.collectionDrafts.findById(session.draftId);
    if (!draft) {
      sessions.delete(key);
      return next();
    }

    // Treat each text as the description; the most recent one wins.
    try {
      ctx.services.share.setDraftMetadata(draft, { description: text });
    } catch {
      // setDraftMetadata only throws on internal errors; ignore for UX.
    }
    armSessionTimers(session, key, sessions, ctx);
  });

  // "End adding" callback. Looks up the session for `(this bot, this user)`,
  // finalises the draft, and ships the share code.
  composer.callbackQuery(FINISH_CALLBACK, async (ctx) => {
    const key = sessionKey(ctx.bot.id, ctx.user.id);
    const session = sessions.get(key);
    if (!session || session.kind !== 'active') {
      await ctx.answerCallbackQuery({ text: ctx.t('session.nothing_to_finish') });
      return;
    }
    await ctx.answerCallbackQuery();
    await finalizeSession(session, key, sessions, buildFinalizerCtx(ctx, session.chatId));
  });
}

/**
 * (Re-)arm both timers for a session. Each new event (upload OR text)
 * pushes them out, so the prompt only fires after the user actually pauses.
 */
function armSessionTimers(
  session: Extract<Session, { kind: 'active' }>,
  key: string,
  sessions: Map<string, Session>,
  ctx: AppContext,
): void {
  clearTimeout(session.promptTimer);
  clearTimeout(session.hardTimer);

  const fctx = buildFinalizerCtx(ctx, session.chatId);

  session.promptTimer = setTimeout(() => {
    void renderPrompt(session, fctx).catch((err: unknown) => {
      getLogger().warn({ err, key }, 'failed to render session prompt');
    });
  }, PROMPT_DEBOUNCE_MS);

  session.hardTimer = setTimeout(() => {
    void finalizeSession(session, key, sessions, fctx);
  }, HARD_TIMEOUT_MS);
}

interface FinalizerCtx {
  api: AppContext['api'];
  services: AppContext['services'];
  repos: AppContext['repos'];
  config: AppContext['config'];
  user: AppContext['user'];
  bot: AppContext['bot'];
  locale: Locale;
  chatId: number;
}

function buildFinalizerCtx(ctx: AppContext, chatId: number): FinalizerCtx {
  return {
    api: ctx.api,
    services: ctx.services,
    repos: ctx.repos,
    config: ctx.config,
    user: ctx.user,
    bot: ctx.bot,
    locale: pickLocale(ctx),
    chatId,
  };
}

/**
 * Compose the prompt body from the current draft + counts + description,
 * and either send a fresh message or edit the existing one.
 */
async function renderPrompt(
  session: Extract<Session, { kind: 'active' }>,
  fctx: FinalizerCtx,
): Promise<void> {
  const draft = fctx.repos.collectionDrafts.findById(session.draftId);
  if (!draft) return;

  const total = fctx.repos.collectionDrafts.countItems(draft.id);
  if (total === 0) return;

  const counts = fctx.repos.collectionDrafts.countItemsByType(draft.id);

  const descriptionLine = draft.description
    ? t(fctx.locale, 'session.description_line', {
        description: escapeHtml(draft.description),
      })
    : '';

  const text = t(fctx.locale, 'session.prompt', {
    total,
    photo: counts.photo,
    video: counts.video,
    doc: counts.document,
    audio: counts.audio,
    descriptionLine,
  });

  const kb = new InlineKeyboard().text(t(fctx.locale, 'session.button_finish'), FINISH_CALLBACK);

  if (session.promptMessageId !== null) {
    try {
      await fctx.api.editMessageText(fctx.chatId, session.promptMessageId, text, {
        parse_mode: 'HTML',
        reply_markup: kb,
      });
      return;
    } catch {
      // Editing can fail (message too old / deleted / unchanged); fall through
      // to a fresh post below.
      session.promptMessageId = null;
    }
  }

  const sent = await fctx.api.sendMessage(fctx.chatId, text, {
    parse_mode: 'HTML',
    reply_markup: kb,
  });
  session.promptMessageId = sent.message_id;
}

/**
 * Finalise the session: deliver a single-file share or wrap the items into
 * a Collection. Pops the session entry first so a slow finalise does not
 * block the next session from the same user.
 */
async function finalizeSession(
  session: Extract<Session, { kind: 'active' }>,
  key: string,
  sessions: Map<string, Session>,
  fctx: FinalizerCtx,
): Promise<void> {
  // Take the entry off the map first; clear timers so a stale tick can't
  // fire after we've shipped.
  sessions.delete(key);
  clearTimeout(session.promptTimer);
  clearTimeout(session.hardTimer);

  // Best-effort prompt cleanup so the chat doesn't keep a stale "End adding?"
  // bubble after the share is shipped.
  if (session.promptMessageId !== null) {
    try {
      await fctx.api.deleteMessage(fctx.chatId, session.promptMessageId);
    } catch {
      // ignore — already gone, too old, or never sent.
    }
  }

  const log = getLogger();
  const draft = fctx.repos.collectionDrafts.findById(session.draftId);
  if (!draft) {
    log.warn({ key, draftId: session.draftId }, 'session draft disappeared before finalize');
    return;
  }

  const items = fctx.repos.collectionDrafts.listItems(draft.id);
  if (items.length === 0) {
    fctx.repos.collectionDrafts.delete(draft.id);
    return;
  }

  // 1-item with no description → single-file share (less chrome).
  if (items.length === 1 && !draft.description) {
    const item = items[0];
    if (!item) {
      fctx.repos.collectionDrafts.delete(draft.id);
      return;
    }
    try {
      const meta: ExtractedFileMeta = {
        file_type: item.file_type as FileType,
        telegram_file_id: item.telegram_file_id,
        telegram_file_unique_id: item.telegram_file_unique_id,
        file_name: item.file_name,
        mime_type: item.mime_type,
        size_bytes: item.size_bytes,
        caption: item.caption,
      };
      const result = await fctx.services.file.upload({
        user: fctx.user,
        bot: fctx.bot,
        meta,
      });
      fctx.repos.collectionDrafts.delete(draft.id);
      const text = t(fctx.locale, 'upload.success', {
        shareCode: escapeHtml(result.shareCode),
        deepLink: escapeHtml(result.deepLink),
      });
      await fctx.api.sendMessage(fctx.chatId, text, {
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
    } catch (err) {
      log.error({ err, draftId: session.draftId }, 'failed to finalize 1-item session');
      if (err instanceof AppError && err.expose) {
        try {
          await fctx.api.sendMessage(fctx.chatId, err.message);
        } catch {
          // best-effort
        }
      }
    }
    return;
  }

  // Multiple items (or 1 with a description) → Collection.
  await finalizeAsCollection(draft, fctx, log);
}

async function finalizeAsCollection(
  draft: CollectionDraftRow,
  fctx: FinalizerCtx,
  log: ReturnType<typeof getLogger>,
): Promise<void> {
  try {
    const result = await fctx.services.share.finishCollection(draft, fctx.user);
    const lines: string[] = [
      t(fctx.locale, 'collection.auto.finished', {
        total: result.collection.total_items,
        shareCode: escapeHtml(result.shareCode),
        deepLink: escapeHtml(result.deepLink),
      }),
    ];
    if (result.collection.description) {
      lines.push(`📝 ${escapeHtml(result.collection.description)}`);
    }
    await fctx.api.sendMessage(fctx.chatId, lines.join('\n'), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    log.error({ err, draftId: draft.id }, 'failed to finalize collection session');
    if (err instanceof AppError && err.expose) {
      try {
        await fctx.api.sendMessage(fctx.chatId, err.message);
      } catch {
        // best-effort
      }
    }
  }
}
