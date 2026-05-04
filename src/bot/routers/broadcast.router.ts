/**
 * Broadcast router — user-facing opt-out commands.
 *
 * Only one command for v0.3: `/stop_broadcasts` flips the global
 * `users.broadcast_unsubscribed` flag, opting the user out of every future
 * announcement across every bot. `/start_broadcasts` re-subscribes — the
 * round-trip is symmetric so a user who tapped the button reflexively can
 * undo it without help.
 *
 * Composing + sending broadcasts lives entirely in the Mini App; there are
 * no operator-facing commands here. Founders / bot owners use the
 * `/admin → Broadcasts` path.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';

export function registerBroadcastRouter(composer: Composer<AppContext>): void {
  composer.command('stop_broadcasts', async (ctx) => {
    if (ctx.user.broadcast_unsubscribed === 1) {
      await ctx.reply(ctx.t('broadcast.opt_out.already'));
      return;
    }
    ctx.repos.users.setBroadcastUnsubscribed(ctx.user.id, true);
    ctx.services.audit.log('broadcast.user_unsubscribed', {
      actorUserId: ctx.user.id,
    });
    await ctx.reply(ctx.t('broadcast.opt_out.confirmed'));
  });

  composer.command('start_broadcasts', async (ctx) => {
    if (ctx.user.broadcast_unsubscribed === 0) {
      await ctx.reply(ctx.t('broadcast.opt_in.already'));
      return;
    }
    ctx.repos.users.setBroadcastUnsubscribed(ctx.user.id, false);
    ctx.services.audit.log('broadcast.user_resubscribed', {
      actorUserId: ctx.user.id,
    });
    await ctx.reply(ctx.t('broadcast.opt_in.confirmed'));
  });
}
