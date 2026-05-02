/**
 * VaultLink Bot — admin gate.
 *
 * Drops the update with a localized denial when the sender is not an admin
 * (neither `super_admin` role nor a member of `config.ADMIN_IDS`). Used as
 * the first middleware on every admin router so per-handler checks do not
 * have to repeat the policy.
 */

import type { MiddlewareFn } from 'grammy';
import type { AppContext } from '../context.js';

export function adminOnlyMiddleware(): MiddlewareFn<AppContext> {
  return async (ctx, next) => {
    if (!ctx.services.permission.isAdmin(ctx.user)) {
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
