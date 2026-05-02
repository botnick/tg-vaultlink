/**
 * Upload router — every supported attachment kind funnels into one handler.
 *
 * Two routing modes, in priority order:
 *
 *  1. Album auto-bundle path. The Telegram client sent multiple media as one
 *     ALBUM (every message in the group carries the same `media_group_id`).
 *     We open a draft on the first item, append every subsequent item from
 *     the same group, and debounce-finalize ~1.5 s after the last arrival —
 *     replying ONCE with a single share code instead of N "Upload successful"
 *     messages. Zero commands, zero buttons; sending multiple files at once
 *     just becomes a Collection automatically.
 *
 *  2. Single-file path. One message, one share code. Unchanged.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware.js';
import { extractFileMeta } from '../../utils/fileMeta.js';
import { escapeHtml } from '../../utils/safeText.js';
import { AppError } from '../../utils/errors.js';
import { getLogger } from '../../logger/logger.js';
import { t } from '../../utils/i18n.js';
import type { Locale } from '../../types/index.js';

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

/**
 * Window after the last album item before we finalize. Telegram clients
 * deliver album messages within ~50–300 ms of each other; 1500 ms gives ample
 * slack without making the user wait.
 */
const ALBUM_DEBOUNCE_MS = 1500;

interface AlbumBufferEntry {
  draftId: number;
  chatId: number;
  /** Reset on every new item; on fire we finalize. */
  timer: ReturnType<typeof setTimeout>;
}

export function registerUploadRouter(composer: Composer<AppContext>): void {
  // Per-bot in-memory accumulator. Key = `${botId}:${ownerId}:${mediaGroupId}`.
  // Telegram only reuses a media_group_id within one upload session, so the
  // map stays bounded and entries are removed the moment the group finalizes.
  const albumBuffers = new Map<string, AlbumBufferEntry>();

  composer.on(ATTACHMENT_QUERIES, rateLimitMiddleware('upload'), async (ctx) => {
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

    // 1) Album auto-bundle path: multiple media sent at once → one Collection.
    const mediaGroupId = message.media_group_id;
    if (ctx.config.ENABLE_COLLECTIONS && mediaGroupId && message.chat) {
      const key = `${ctx.bot.id}:${ctx.user.id}:${mediaGroupId}`;
      let entry = albumBuffers.get(key);

      if (!entry) {
        // First item in this album — mint a draft and seed the buffer.
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
        entry = {
          draftId: draft.id,
          chatId: message.chat.id,
          // Replaced below before this object is reachable from elsewhere.
          timer: setTimeout(() => undefined, 0),
        };
        clearTimeout(entry.timer);
        albumBuffers.set(key, entry);
      }

      try {
        const draft = ctx.repos.collectionDrafts.findById(entry.draftId);
        if (!draft) {
          albumBuffers.delete(key);
          getLogger().warn(
            { key, draftId: entry.draftId },
            'album draft disappeared mid-bundle',
          );
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

      // Debounce: clear and re-arm the finalize timer. The latest item wins.
      clearTimeout(entry.timer);
      const capturedKey = key;
      const capturedEntry = entry;
      const userLocale: Locale =
        ctx.user.locale === 'th' || ctx.user.locale === 'en'
          ? ctx.user.locale
          : ctx.config.DEFAULT_LOCALE;
      const finalizerCtx: FinalizerCtx = {
        api: ctx.api,
        services: ctx.services,
        repos: ctx.repos,
        config: ctx.config,
        user: ctx.user,
        locale: userLocale,
        chatId: capturedEntry.chatId,
      };
      entry.timer = setTimeout(() => {
        void finalizeAlbum(capturedKey, capturedEntry, finalizerCtx, albumBuffers);
      }, ALBUM_DEBOUNCE_MS);

      return;
    }

    // 2) Single-file path.
    const result = await ctx.services.file.upload({
      user: ctx.user,
      bot: ctx.bot,
      meta,
    });

    const reply = ctx.t('upload.success', {
      shareCode: escapeHtml(result.shareCode),
      deepLink: escapeHtml(result.deepLink),
    });
    await ctx.reply(reply, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });
}

interface FinalizerCtx {
  api: AppContext['api'];
  services: AppContext['services'];
  repos: AppContext['repos'];
  config: AppContext['config'];
  user: AppContext['user'];
  locale: Locale;
  chatId: number;
}

/**
 * Finalize an album draft after the debounce window expires. Sends ONE reply
 * with the new collection's share code. If finalize fails, the draft stays in
 * the DB so the user can recover via /files; we surface a short error reply
 * for expose-able errors and stay silent otherwise.
 */
async function finalizeAlbum(
  key: string,
  entry: AlbumBufferEntry,
  fctx: FinalizerCtx,
  buffers: Map<string, AlbumBufferEntry>,
): Promise<void> {
  // Pop the buffer entry first so a slow finalize doesn't block a brand-new
  // album from the same user.
  buffers.delete(key);

  const log = getLogger();
  const draft = fctx.repos.collectionDrafts.findById(entry.draftId);
  if (!draft) {
    log.warn({ key, draftId: entry.draftId }, 'album draft disappeared before finalize');
    return;
  }

  try {
    const result = await fctx.services.share.finishCollection(draft, fctx.user);
    const text = t(fctx.locale, 'collection.auto.finished', {
      total: result.collection.total_items,
      shareCode: escapeHtml(result.shareCode),
      deepLink: escapeHtml(result.deepLink),
    });
    await fctx.api.sendMessage(fctx.chatId, text, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  } catch (err) {
    log.error({ err, draftId: entry.draftId }, 'failed to finalize album collection');
    if (err instanceof AppError && err.expose) {
      try {
        await fctx.api.sendMessage(fctx.chatId, err.message);
      } catch {
        // ignore — best-effort
      }
    }
  }
}
