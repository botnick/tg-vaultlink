/**
 * `/help`, `/terms`, `/privacy` routers — static content commands.
 *
 * Wave 7: `/help` is intentionally short — the wizard-driven UX (`/new`,
 * `/files`, `/bots`, etc.) is the canonical surface so the help body just
 * lists the minimal command set and the four-step share flow.
 */

import type { Composer } from 'grammy';
import type { AppContext } from '../context.js';

export function registerHelpRouter(composer: Composer<AppContext>): void {
  composer.command('help', async (ctx) => {
    const body = [
      ctx.t('help.intro'),
      ctx.t('help.commands_list'),
    ].join('\n\n');
    await ctx.reply(body, { parse_mode: 'HTML' });
  });

  composer.command('terms', async (ctx) => {
    await ctx.reply(ctx.t('terms.body'), { parse_mode: 'HTML' });
  });

  composer.command('privacy', async (ctx) => {
    await ctx.reply(ctx.t('privacy.body'), { parse_mode: 'HTML' });
  });
}
