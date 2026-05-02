/**
 * `/start` router (Wave 7).
 *
 * Two responsibilities:
 *   1. Bare `/start` → greeting + the canonical main-menu inline keyboard
 *      (build via `buildMainMenuKeyboard`). When the Mini App is enabled we
 *      add a WebApp button at the bottom.
 *   2. `/start <code>` (Telegram deep link) → resolve through
 *      {@link ShareService.resolveShareCode}. Single-file shares deliver the
 *      file inline; collection shares render page 1 of the preview.
 *
 * Password-protected shares deflect with a localized prompt that tells the
 * user to resend in the `<botname>_<code>:<password>` form supported by the
 * decode router.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { isValidCode } from '../../utils/codeGenerator.js';
import { deliverFile } from './_delivery.js';
import { sendCollectionPreview } from './collection.router.js';
import { escapeHtml } from '../../utils/safeText.js';
import { buildMainMenuKeyboard } from './main_menu.router.js';

export function registerStartRouter(composer: Composer<AppContext>): void {
  composer.command('start', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();

    if (arg.length === 0) {
      const greeting = ctx.t('start.greeting', { appName: ctx.config.APP_NAME });
      await ctx.reply(greeting, {
        parse_mode: 'HTML',
        reply_markup: buildMainMenuKeyboard(ctx),
      });
      return;
    }

    // Deep-link argument: treat a bare code as `<thisBotUsername>_<code>` so
    // the resolver knows which bot to consult.
    const rawCode = isValidCode(arg) ? `${ctx.bot.username}_${arg}` : arg;

    let resolved;
    try {
      resolved = await ctx.services.share.resolveShareCode({
        rawCode,
        contextBot: ctx.bot,
      });
    } catch (err) {
      throw err;
    }

    if (!resolved) {
      await ctx.reply(ctx.t('decode.not_found'));
      return;
    }

    if (resolved.type === 'collection') {
      try {
        await ctx.services.share.ensureAccessible({ collection: resolved.collection });
      } catch (err) {
        if (err instanceof AppError) {
          if (err.code === ErrorCode.PASSWORD_REQUIRED) {
            const shareCode = `${ctx.bot.username}_${resolved.collection.code}`;
            await ctx.reply(
              ctx.t('decode.password_required', { shareCode: escapeHtml(shareCode) }),
              { parse_mode: 'HTML' },
            );
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
      await sendCollectionPreview(ctx, resolved.collection);
      return;
    }

    // Single-file: route through FileService.decode for download bookkeeping
    // and password gating.
    try {
      const result = await ctx.services.file.decode({
        user: ctx.user,
        rawCode,
        contextBot: ctx.bot,
      });
      await deliverFile(ctx, result.file);
    } catch (err) {
      if (err instanceof AppError && err.code === ErrorCode.PASSWORD_REQUIRED) {
        const shareCode = `${ctx.bot.username}_${isValidCode(arg) ? arg : arg}`;
        await ctx.reply(ctx.t('decode.password_required', { shareCode: escapeHtml(shareCode) }), {
          parse_mode: 'HTML',
        });
        return;
      }
      throw err;
    }
  });
}
