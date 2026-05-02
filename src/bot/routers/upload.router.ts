/**
 * Upload router — every supported attachment kind funnels into one handler.
 *
 * Wave 7 routing: when the sender has an OPEN collection draft for the
 * current bot, inbound media is appended to that draft; otherwise the
 * existing single-file flow fires unchanged. The decision is local — no
 * separate command toggles "collection mode".
 *
 * The single-file path enforces upload permission via {@link PermissionService},
 * extracts canonical metadata via {@link extractFileMeta}, and defers to
 * {@link FileService.upload} for code allocation, audit, and persistence.
 * The draft path enforces the same per-collection cap via
 * {@link ShareService.addItemToDraft}.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware.js';
import { extractFileMeta } from '../../utils/fileMeta.js';
import { escapeHtml } from '../../utils/safeText.js';
import { AppError } from '../../utils/errors.js';

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

export function registerUploadRouter(composer: Composer<AppContext>): void {
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

    // Draft path: when an OPEN draft exists for (bot, user), append.
    if (ctx.config.ENABLE_COLLECTIONS) {
      const draft = ctx.services.share.getOpenDraft(ctx.user, ctx.bot);
      if (draft) {
        try {
          ctx.services.share.addItemToDraft(draft, meta);
        } catch (err) {
          if (err instanceof AppError && err.expose) {
            await ctx.reply(err.message);
            return;
          }
          throw err;
        }
        const total = ctx.repos.collectionDrafts.countItems(draft.id);
        const counts = ctx.repos.collectionDrafts.countItemsByType(draft.id);
        await ctx.reply(
          ctx.t('collection.draft.item_added', {
            total,
            photo: counts.photo,
            video: counts.video,
            doc: counts.document,
            audio: counts.audio,
            voice: counts.voice,
            animation: counts.animation,
            sticker: counts.sticker,
          }),
          { parse_mode: 'HTML' },
        );
        return;
      }
    }

    // Single-file path.
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
