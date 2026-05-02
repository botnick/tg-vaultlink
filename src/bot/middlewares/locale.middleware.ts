/**
 * VaultLink Bot — locale middleware.
 *
 * Re-derives the effective locale from the (possibly-just-updated) user row
 * and rebinds `ctx.t` so router code calling `ctx.t('...')` always reflects
 * the current preference. The {@link attachUserMiddleware} also sets these
 * fields but it captures the locale at the start of the update; this layer
 * exists so a `/lang` flow that just rewrote `users.locale` reflects in the
 * very next handler call without an extra round-trip.
 */

import type { MiddlewareFn } from 'grammy';
import type { AppContext } from '../context.js';
import { resolveUserLocale } from '../context.js';
import { t as translate } from '../../utils/i18n.js';

export function localeMiddleware(): MiddlewareFn<AppContext> {
  return async (ctx, next) => {
    if (ctx.user) {
      const locale = resolveUserLocale(ctx.user, ctx.config.DEFAULT_LOCALE);
      ctx.locale = locale;
      ctx.t = (key, params) => translate(locale, key, params);
    }
    await next();
  };
}
