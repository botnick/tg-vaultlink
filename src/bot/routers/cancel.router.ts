/**
 * `/cancel` router — drops the user's open collection draft (if any).
 *
 * No-op (with a polite reply) when there is nothing to cancel. Future wizard
 * flows can add their own cancel branches here as the bot UX grows.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';

export function registerCancelRouter(composer: Composer<AppContext>): void {
  composer.command('cancel', async (ctx) => {
    if (ctx.config.ENABLE_COLLECTIONS) {
      const draft = ctx.services.share.getOpenDraft(ctx.user, ctx.bot);
      if (draft) {
        ctx.services.share.cancelDraft(draft, ctx.user);
        await ctx.reply(ctx.t('collection.draft.cancelled'));
        return;
      }
    }
    await ctx.reply(ctx.t('common.nothing_to_cancel'));
  });
}
