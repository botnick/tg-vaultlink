/**
 * VaultLink Bot — rate-limit middleware factory.
 *
 * Wraps the {@link RateLimitService} into a per-scope grammY middleware. When
 * a user exceeds the quota, the chain short-circuits with a single localized
 * reply; otherwise the call continues. Admins still get rate-limited so a
 * runaway script run by an admin account cannot DoS Telegram on our behalf.
 */

import type { MiddlewareFn } from 'grammy';
import type { AppContext } from '../context.js';
import type { RateLimitScope } from '../../services/rateLimit.service.js';

export function rateLimitMiddleware(scope: RateLimitScope): MiddlewareFn<AppContext> {
  return async (ctx, next) => {
    const decision = ctx.services.rateLimit.check(scope, ctx.user.telegram_user_id);
    if (!decision.allowed) {
      try {
        await ctx.reply(ctx.t('common.error.rate_limited'));
      } catch {
        // Reply may fail (user blocked the bot, etc.); the limiter still
        // recorded the hit so the next attempt remains throttled.
      }
      return;
    }
    await next();
  };
}
