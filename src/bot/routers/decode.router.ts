/**
 * Decode router — plain-text share-code lookups.
 *
 * Picks up text messages that aren't bot commands and tries to interpret them
 * as a share code. Three forms are supported:
 *   1. `<code>`                 (bare code in the bot's namespace)
 *   2. `<bot>:<code>`           (cross-bot reference)
 *   3. `<bot>:<code>:<password>` or `<code>:<password>`
 *      (single-message form for password-protected files)
 *
 * The first text-form branch we cannot interpret as a code falls through to a
 * help nudge so users do not get silence for typos.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware.js';
import { parseShareCode } from '../../utils/codeParser.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { deliverFile } from './_delivery.js';
import { escapeHtml } from '../../utils/safeText.js';

interface PreparedDecode {
  rawCode: string;
  password: string | null;
  /** What we should display back if a password prompt is needed. */
  shareCodeForPrompt: string;
}

/**
 * Pull a `(code, password?)` pair out of the user's text. Returns `null` when
 * the input does not parse as any supported share-code form.
 */
function prepareDecode(text: string, currentBotUsername: string): PreparedDecode | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  // Try parsing whole input first — covers deep links and `<bot>:<code>`.
  const direct = parseShareCode(trimmed);
  if (direct) {
    const shareCode = direct.botUsername
      ? `${direct.botUsername}:${direct.code}`
      : `${currentBotUsername}:${direct.code}`;
    return { rawCode: trimmed, password: null, shareCodeForPrompt: shareCode };
  }

  // Try splitting on the LAST colon so passwords containing `:` survive
  // accidentally — the prefix must still parse as a share-code reference.
  const lastColon = trimmed.lastIndexOf(':');
  if (lastColon > 0 && lastColon < trimmed.length - 1) {
    const prefix = trimmed.slice(0, lastColon);
    const password = trimmed.slice(lastColon + 1);
    const parsed = parseShareCode(prefix);
    if (parsed) {
      const shareCode = parsed.botUsername
        ? `${parsed.botUsername}:${parsed.code}`
        : `${currentBotUsername}:${parsed.code}`;
      return { rawCode: prefix, password, shareCodeForPrompt: shareCode };
    }
  }

  return null;
}

export function registerDecodeRouter(composer: Composer<AppContext>): void {
  composer.on('message:text', rateLimitMiddleware('download'), async (ctx, next) => {
    const text = ctx.message.text;
    // Commands are handled by their respective routers.
    if (text.startsWith('/')) {
      return next();
    }

    const prepared = prepareDecode(text, ctx.bot.username);
    if (!prepared) {
      // Not a recognizable share-code shape: nudge the user toward help.
      await ctx.reply(ctx.t('decode.prompt'));
      return;
    }

    // First try the unified resolver; collections take a different code
    // path than single files. Falling back to the FileService.decode keeps
    // the single-file flow's bookkeeping intact.
    const resolved = await ctx.services.share.resolveShareCode({
      rawCode: prepared.rawCode,
      contextBot: ctx.bot,
    });

    if (resolved && resolved.type === 'collection') {
      try {
        await ctx.services.share.ensureAccessible({
          collection: resolved.collection,
          password: prepared.password,
        });
      } catch (err) {
        if (err instanceof AppError) {
          if (err.code === ErrorCode.PASSWORD_REQUIRED) {
            await ctx.reply(
              ctx.t('decode.password_required', {
                shareCode: escapeHtml(prepared.shareCodeForPrompt),
              }),
              { parse_mode: 'HTML' },
            );
            return;
          }
          if (err.code === ErrorCode.PASSWORD_INCORRECT) {
            await ctx.reply(ctx.t('decode.password_incorrect'));
            return;
          }
          if (err.code === ErrorCode.FILE_LOCKED) {
            await ctx.reply(ctx.t('decode.locked'));
            return;
          }
          if (err.code === ErrorCode.FILE_EXPIRED) {
            await ctx.reply(ctx.t('decode.expired'));
            return;
          }
        }
        throw err;
      }
      const { sendCollectionPreview } = await import('./collection.router.js');
      await sendCollectionPreview(ctx, resolved.collection);
      return;
    }

    try {
      const decoded = await ctx.services.file.decode({
        user: ctx.user,
        rawCode: prepared.rawCode,
        contextBot: ctx.bot,
        password: prepared.password,
      });

      // Permission check at the bot-mode level (download policy).
      const decision = ctx.services.permission.canDownload(ctx.user, decoded.bot, decoded.file);
      if (!decision.allowed) {
        await ctx.reply(ctx.t('decode.permission_denied'));
        return;
      }

      await deliverFile(ctx, decoded.file);
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.PASSWORD_REQUIRED) {
        await ctx.reply(
          ctx.t('decode.password_required', {
            shareCode: escapeHtml(prepared.shareCodeForPrompt),
          }),
          { parse_mode: 'HTML' },
        );
        return;
      }
      throw err;
    }
  });
}
