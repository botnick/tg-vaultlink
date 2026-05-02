/**
 * `/help`, `/terms`, `/privacy` — static informational commands.
 *
 * `/help` is a paginated tab UI (overview / files / bots / settings /
 * admin) that swaps content in place via `editMessageText`. Pages are
 * defined in `help_handlers.ts` and shared with the main-menu callback.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';
import {
  buildHelpKeyboard,
  clampPageIndex,
  getHelpPages,
  handleHelpCommand,
} from './help_handlers.js';

export function registerHelpRouter(composer: Composer<AppContext>): void {
  composer.command('help', async (ctx) => {
    await handleHelpCommand(ctx);
  });

  composer.command('terms', async (ctx) => {
    await ctx.reply(ctx.t('terms.body'), { parse_mode: 'HTML' });
  });

  composer.command('privacy', async (ctx) => {
    await ctx.reply(ctx.t('privacy.body'), { parse_mode: 'HTML' });
  });

  // Tab-switch callbacks: edit the existing help message in place.
  composer.callbackQuery(/^help:page:(\d+)$/, async (ctx) => {
    const m = ctx.match;
    const requested = Number.parseInt(m?.[1] ?? '0', 10);
    const pages = getHelpPages(ctx);
    const idx = clampPageIndex(requested, pages);
    const page = pages[idx]!;
    try {
      await ctx.editMessageText(ctx.t(page.bodyKey), {
        parse_mode: 'HTML',
        reply_markup: buildHelpKeyboard(ctx, idx, pages),
      });
    } catch {
      // Editing fails when the message is too old or content is identical;
      // the answerCallbackQuery still dismisses the spinner.
    }
    await ctx.answerCallbackQuery();
  });

  // Current-tab no-op: clicking the active tab dismisses the spinner.
  composer.callbackQuery('help:noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });
}
