/**
 * VaultLink Bot — grammY bot factory.
 *
 * Builds a fully wired {@link Bot} for a given managed-bot record: installs
 * the global error boundary, plugs in attach-user + locale middlewares, and
 * registers every router. The returned instance is ready to be `bot.start()`d
 * by the caller (the main bot in {@link bootstrapMainBot}, child bots in the
 * {@link ChildBotManager}).
 */

import { Bot, Composer, type BotConfig } from 'grammy';
import { autoRetry } from '@grammyjs/auto-retry';
import { apiThrottler } from '@grammyjs/transformer-throttler';
import type { AppContext, AppRepos, AppServices } from './context.js';
import type { Config } from '../config/env.js';
import type { ManagedBotRow } from '../types/index.js';
import { attachUserMiddleware } from './middlewares/attachUser.middleware.js';
import { localeMiddleware } from './middlewares/locale.middleware.js';
import { installErrorHandler } from './middlewares/error.middleware.js';
import { registerStartRouter } from './routers/start.router.js';
import { registerHelpRouter } from './routers/help.router.js';
import { registerUploadRouter } from './routers/upload.router.js';
import { registerDecodeRouter } from './routers/decode.router.js';
import { registerFilesRouter } from './routers/files.router.js';
import { registerBotManagementRouter } from './routers/botManagement.router.js';
import { registerPermissionsRouter } from './routers/permissions.router.js';
import { registerReportsRouter } from './routers/reports.router.js';
import { registerAdminRouter } from './routers/admin.router.js';
import { registerSettingsRouter } from './routers/settings.router.js';
import { registerNewRouter } from './routers/new.router.js';
import { registerCancelRouter } from './routers/cancel.router.js';
import { registerCollectionRouter } from './routers/collection.router.js';
import { registerMainMenuRouter } from './routers/main_menu.router.js';
import type { ChildBotManager } from './childBotManager.js';

export interface CreateBotOptions {
  /** Plaintext Telegram bot token. */
  token: string;
  /** The managed-bot record this dispatcher is bound to. */
  bot: ManagedBotRow;
  services: AppServices;
  repos: AppRepos;
  config: Config;
  /**
   * Optional child manager. When supplied, `/add_bot*` and `/remove_bot`
   * actually start/stop the running child instance. Pass `undefined` from
   * inside child bots so they cannot mutate sibling instances.
   */
  childManager?: ChildBotManager;
}

/** Build a fully-wired grammY bot for a given managed-bot record. */
export function createBot(opts: CreateBotOptions): Bot<AppContext> {
  const botConfig: BotConfig<AppContext> = {
    client: { apiRoot: opts.config.TELEGRAM_API_BASE_URL },
  };
  const bot = new Bot<AppContext>(opts.token, botConfig);

  // Telegram-compliance hardening: outbound API calls are queued through the
  // throttler (so we never exceed the documented rate ceiling) and any 429
  // response is honored with an automatic retry that respects retry_after.
  // All knobs come from the validated config so operators can re-tune via
  // env without code changes.
  bot.api.config.use(
    apiThrottler({
      global: {
        maxConcurrent: 1,
        minTime: Math.ceil(1000 / opts.config.TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC),
        reservoir: opts.config.TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC,
        reservoirRefreshAmount: opts.config.TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC,
        reservoirRefreshInterval: 1000,
      },
      group: {
        maxConcurrent: 1,
        minTime: Math.ceil(60_000 / opts.config.TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN),
        reservoir: opts.config.TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN,
        reservoirRefreshAmount: opts.config.TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN,
        reservoirRefreshInterval: 60_000,
      },
      out: {
        maxConcurrent: 1,
        minTime: Math.ceil(1000 / opts.config.TELEGRAM_PER_CHAT_RATE_LIMIT_PER_SEC),
      },
    }),
  );
  bot.api.config.use(
    autoRetry({
      maxRetryAttempts: opts.config.TELEGRAM_AUTORETRY_MAX_ATTEMPTS,
      maxDelaySeconds: opts.config.TELEGRAM_AUTORETRY_MAX_DELAY_SECONDS,
    }),
  );

  installErrorHandler(bot, opts.config);

  // 1) Attach the local user row, services, repos, config, and bound `t`.
  bot.use(
    attachUserMiddleware({
      bot: opts.bot,
      userService: opts.services.user,
      services: opts.services,
      repos: opts.repos,
      config: opts.config,
    }),
  );

  // 2) Re-derive locale from the (possibly just-updated) row each turn.
  bot.use(localeMiddleware());

  // 3) Routers. Order matters: upload runs before decode so attachments are
  // not interpreted as text, settings runs before permissions (so /lang
  // wins over the permissions /lang fall-through), admin runs last so its
  // adminOnly guard doesn't block earlier non-admin commands.
  //
  // Wave 7: the new routers (main_menu, new, collection, cancel) are
  // registered AFTER the existing ones so the legacy commands still
  // function as hidden aliases.
  const composer = new Composer<AppContext>();
  registerStartRouter(composer);
  registerHelpRouter(composer);
  registerSettingsRouter(composer);
  registerUploadRouter(composer);
  registerFilesRouter(composer);
  registerBotManagementRouter(
    composer,
    opts.childManager !== undefined ? { childManager: opts.childManager } : {},
  );
  registerPermissionsRouter(composer);
  registerReportsRouter(composer);
  registerAdminRouter(composer);
  // Wave 7 routers — minimal command UX + collection callbacks.
  registerNewRouter(composer);
  registerCancelRouter(composer);
  registerCollectionRouter(composer);
  registerMainMenuRouter(composer);
  // Decode is last among text-handling routers so commands always win.
  registerDecodeRouter(composer);
  bot.use(composer);

  return bot;
}
