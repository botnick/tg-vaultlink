/**
 * VaultLink Bot — founder-only gate.
 *
 * The strictest authorization layer in the bot. Passes ONLY when the
 * caller's Telegram id is in `ADMIN_IDS` (env-driven). Used by the
 * `/promote`, `/demote`, and `/super_admins` commands so that a promoted
 * super admin (`role='super_admin'` but NOT in ADMIN_IDS) cannot grow the
 * trust graph further. The env file is the single point of authority.
 *
 * Per-action authorization in `user.service.setRole` re-checks the same
 * predicate (defense in depth) — this middleware is the cheap first
 * filter so non-founder traffic doesn't even reach the handler body.
 */

import type { MiddlewareFn } from 'grammy';
import type { AppContext } from '../context.js';

export function founderOnlyMiddleware(): MiddlewareFn<AppContext> {
  return async (ctx, next) => {
    if (!ctx.services.permission.isFounder(ctx.user)) {
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
