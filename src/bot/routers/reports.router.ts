/**
 * Reports router — `/report <code> <reason>`.
 *
 * Looks up the file across all bots so a user can flag content reachable
 * through any deep link, not just the bot they're currently chatting with.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware.js';
import { parseShareCode } from '../../utils/codeParser.js';

export function registerReportsRouter(composer: Composer<AppContext>): void {
  composer.command('report', rateLimitMiddleware('report'), async (ctx) => {
    if (!ctx.config.ENABLE_REPORTS) {
      await ctx.reply(ctx.t('common.error.feature_disabled'));
      return;
    }

    const arg = (ctx.match ?? '').toString().trim();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('report.usage'), { parse_mode: 'HTML' });
      return;
    }

    // First whitespace-separated token is the code/share-ref; the rest is
    // the free-form reason.
    const firstSpace = arg.search(/\s+/);
    const codeArg = firstSpace === -1 ? arg : arg.slice(0, firstSpace);
    const reason = firstSpace === -1 ? '' : arg.slice(firstSpace).trim();

    if (reason.length === 0) {
      await ctx.reply(ctx.t('report.usage'), { parse_mode: 'HTML' });
      return;
    }

    const parsed = parseShareCode(codeArg);
    if (!parsed) {
      await ctx.reply(ctx.t('decode.not_found'));
      return;
    }

    let file = parsed.botUsername
      ? (() => {
          const namedBot = ctx.repos.bots.findByUsername(parsed.botUsername!);
          if (!namedBot) return undefined;
          return ctx.repos.files.findByCode(namedBot.id, parsed.code);
        })()
      : ctx.repos.files.findByCodeAcrossBots(parsed.code);

    if (!file && !parsed.botUsername) {
      file = ctx.repos.files.findByCode(ctx.bot.id, parsed.code);
    }

    if (!file || file.is_deleted === 1) {
      await ctx.reply(ctx.t('decode.not_found'));
      return;
    }

    ctx.services.report.submit({ reporter: ctx.user, file, reason });
    await ctx.reply(ctx.t('report.success'), { parse_mode: 'HTML' });
  });
}
