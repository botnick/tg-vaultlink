/**
 * `/uid` — show the caller their own Telegram user id.
 *
 * Useful for support flows ("send your /uid to admin") and for the ADMIN_IDS
 * env-var bootstrap. The handler reads `ctx.from.id` directly so it works
 * regardless of whether the user has ever interacted with the bot before
 * (the attachUser middleware still runs first and gives us `ctx.user`,
 * but we surface the raw Telegram id since that's the value operators
 * paste into config).
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';

export function registerUidRouter(composer: Composer<AppContext>): void {
  composer.command('uid', async (ctx) => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      // Defensive: every Telegram message carries a `from`, but the type
      // is technically optional. Refuse politely rather than crash.
      await ctx.reply(ctx.t('uid.unavailable'));
      return;
    }
    await ctx.reply(ctx.t('uid.body', { id: tgId }), { parse_mode: 'HTML' });
  });
}
