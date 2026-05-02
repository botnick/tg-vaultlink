/**
 * VaultLink Bot — bot-moderator gate.
 *
 * Coarse-grained gate for content-moderation commands (`/lock_file`,
 * `/unlock_file`, `/delete_file`, `/admin_reports`, the `/admin` menu).
 * Passes when the caller is either a system admin (super_admin role OR
 * `ADMIN_IDS`) OR the registered owner of at least one managed bot.
 *
 * Per-action authorization happens INSIDE each handler via
 * `permission.canModerateFile()` / `canModerateCollection()` — those
 * methods enforce that the bot owner can only touch content on bots
 * they actually own. This middleware exists purely to filter out the
 * vast majority of users who have no moderation surface at all.
 */

import type { MiddlewareFn } from 'grammy';
import type { AppContext } from '../context.js';

export function botModeratorMiddleware(): MiddlewareFn<AppContext> {
  return async (ctx, next) => {
    if (!ctx.services.permission.isModerator(ctx.user)) {
      try {
        await ctx.reply(ctx.t('common.error.permission_denied'));
      } catch {
        // ignore reply errors
      }
      return;
    }
    await next();
  };
}
