/**
 * VaultLink Bot — context-attachment middleware.
 *
 * Runs first in every bot's middleware chain. For every update that has a
 * sender we resolve (or create) the local users row, attach it together with
 * the parent managed-bot record, services, repositories, and config, then
 * hand off to the rest of the pipeline. Banned users are dropped here with a
 * single localized reply so no router has to repeat the check; updates with
 * no `from` (anonymous channel posts, etc.) are silently ignored.
 */

import type { MiddlewareFn } from 'grammy';
import type { AppContext, AppRepos, AppServices } from '../context.js';
import { resolveUserLocale } from '../context.js';
import type { Config } from '../../config/env.js';
import type { ManagedBotRow } from '../../types/index.js';
import type { UserService } from '../../services/user.service.js';
import { t as translate, isSupportedLocale } from '../../utils/i18n.js';

export interface AttachUserDeps {
  /** The managed bot record this dispatcher is bound to. */
  bot: ManagedBotRow;
  userService: UserService;
  services: AppServices;
  repos: AppRepos;
  config: Config;
}

/**
 * Build the attach-user middleware. Each managed-bot's grammY instance gets
 * its own bound copy because `bot` is captured in the closure.
 */
export function attachUserMiddleware(deps: AttachUserDeps): MiddlewareFn<AppContext> {
  const { bot, userService, services, repos, config } = deps;

  return async (ctx, next) => {
    // Updates with no sender (channel posts, service updates) are not user
    // actions; we never bind them to a `users` row and they fall through.
    const from = ctx.from;
    if (!from) {
      return;
    }

    const user = userService.ensureUser({
      telegram_user_id: String(from.id),
      username: from.username ?? null,
      first_name: from.first_name ?? null,
      last_name: from.last_name ?? null,
      language_code: from.language_code ?? null,
    });

    // Banned users get one localized notice and the chain stops here.
    if (user.is_banned === 1) {
      const locale = resolveUserLocale(user, config.DEFAULT_LOCALE);
      try {
        await ctx.reply(translate(locale, 'common.error.banned'));
      } catch {
        // Reply may fail if the user blocked the bot; nothing to do here.
      }
      return;
    }

    // Resolve effective locale (used by the locale middleware too, but doing
    // it here means downstream code can rely on the field being present even
    // if the locale middleware is skipped in tests).
    const userLocale = user.locale ?? '';
    const locale = isSupportedLocale(userLocale) ? userLocale : config.DEFAULT_LOCALE;

    ctx.user = user;
    ctx.bot = bot;
    ctx.locale = locale;
    ctx.t = (key, params) => translate(locale, key, params);
    ctx.services = services;
    ctx.repos = repos;
    ctx.config = config;

    await next();
  };
}
