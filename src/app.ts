/**
 * VaultLink Bot — application bootstrap orchestrator.
 *
 * `startApp()` opens the database, runs the migration check, constructs the
 * full repository + service graph, builds the main bot, optionally starts
 * the child-bot manager and the Mini App backend, then wires SIGINT/SIGTERM
 * + uncaught-exception/unhandled-rejection handlers to a single shutdown
 * routine. Returns an {@link AppHandle} so the caller (typically `index.ts`
 * or a test harness) can request a graceful stop on demand.
 */

import type { Update } from 'grammy/types';
import { run, sequentialize } from '@grammyjs/runner';
import { getConfig } from './config/env.js';
import { getLogger } from './logger/logger.js';
import { getDatabase, closeDatabase } from './db/database.js';
import { ensureMigrationsApplied } from './db/migrate.js';

import { UserRepository } from './repositories/user.repository.js';
import { FileRepository } from './repositories/file.repository.js';
import { BotRepository } from './repositories/bot.repository.js';
import { PermissionRepository } from './repositories/permission.repository.js';
import { ReportRepository } from './repositories/report.repository.js';
import { AuditRepository } from './repositories/audit.repository.js';
import { SettingsRepository } from './repositories/settings.repository.js';
import { RateLimitRepository } from './repositories/rateLimit.repository.js';
import { CollectionRepository } from './repositories/collection.repository.js';
import { CollectionDraftRepository } from './repositories/collectionDraft.repository.js';

import { AuditService } from './services/audit.service.js';
import { SettingsService } from './services/settings.service.js';
import { UserService } from './services/user.service.js';
import { RateLimitService } from './services/rateLimit.service.js';
import { PermissionService } from './services/permission.service.js';
import { FileService } from './services/file.service.js';
import { BotService } from './services/bot.service.js';
import { ReportService } from './services/report.service.js';
import { ShareService } from './services/share.service.js';

import { bootstrapMainBot, defaultGetMeFn } from './bot/mainBot.js';
import { ChildBotManager } from './bot/childBotManager.js';
import type { AppRepos, AppServices } from './bot/context.js';

export interface AppHandle {
  /** Best-effort graceful shutdown. Idempotent. */
  shutdown(reason: string): Promise<void>;
}

/** Entry point used by `index.ts`. */
export async function startApp(): Promise<AppHandle> {
  const config = getConfig();
  const log = getLogger();
  log.info({ env: config.NODE_ENV, app: config.APP_NAME }, 'starting');

  // 1) Database.
  const db = getDatabase();
  ensureMigrationsApplied();

  // 2) Repositories.
  const repos: AppRepos = {
    users: new UserRepository(db),
    files: new FileRepository(db),
    bots: new BotRepository(db),
    permissions: new PermissionRepository(db),
    reports: new ReportRepository(db),
    audit: new AuditRepository(db),
    settings: new SettingsRepository(db),
    rateLimit: new RateLimitRepository(db),
    collections: new CollectionRepository(db),
    collectionDrafts: new CollectionDraftRepository(db),
  };

  // 3) Services (in dependency order).
  const audit = new AuditService(repos.audit);
  const settings = new SettingsService(repos.settings);
  const user = new UserService(repos.users, config);
  const rateLimit = new RateLimitService(repos.rateLimit, config);
  const permission = new PermissionService(repos.permissions, user, config);
  const file = new FileService(repos.files, repos.bots, audit, config);
  const bot = new BotService(repos.bots, audit, config, defaultGetMeFn);
  const report = new ReportService(repos.reports, repos.files, audit, config);
  const share = new ShareService({
    files: repos.files,
    bots: repos.bots,
    collections: repos.collections,
    drafts: repos.collectionDrafts,
    audit,
    config,
  });

  const services: AppServices = {
    file,
    bot,
    report,
    permission,
    user,
    rateLimit,
    settings,
    audit,
    share,
  };

  // 4) Child-bot manager (constructed up-front so the main bot can reference it).
  const childManager = new ChildBotManager({
    config,
    services,
    repos,
    getMeFn: defaultGetMeFn,
  });

  // 5) Main bot.
  const main = await bootstrapMainBot({
    config,
    services,
    repos,
    childManager,
  });

  // 6) Start polling via @grammyjs/runner — concurrent update processing
  // with per-user serialization (so two updates from the same Telegram user
  // never race), all knobs config-driven so future Telegram limit changes
  // are an env edit instead of a code change.
  type AllowedUpdate = Exclude<keyof Update, 'update_id'>;
  const allowedUpdates = [...config.BOT_POLLING_ALLOWED_UPDATES] as AllowedUpdate[];
  main.bot.use(sequentialize((ctx) => ctx.from?.id?.toString()));
  const mainRunner = run(main.bot, {
    runner: {
      fetch: {
        allowed_updates: allowedUpdates,
        timeout: config.TELEGRAM_LONG_POLL_TIMEOUT_SECONDS,
      },
    },
    sink: { concurrency: config.RUNNER_CONCURRENCY },
  });
  log.info(
    { username: main.record.username, concurrency: config.RUNNER_CONCURRENCY },
    'main bot started',
  );

  // 7) Optionally start child bots.
  if (config.ENABLE_CHILD_BOTS) {
    try {
      const result = await childManager.startAll();
      log.info(result, 'child bots started');
    } catch (err) {
      log.error({ err }, 'failed to start child bots');
    }
  }

  // 8) Optionally start the Mini App backend (Wave 4b). The module is loaded
  // dynamically so a misconfigured Mini App build cannot block the bot's
  // hot-path bootstrap.
  let miniAppHandle: { stop(): Promise<void> } | null = null;
  if (config.ENABLE_MINI_APP) {
    try {
      const mod = await import('./miniapp/server.js');
      const server = mod.createMiniAppServer({ config, services, repos });
      await server.start();
      miniAppHandle = server;
      log.info('mini-app server started');
    } catch (err) {
      log.error({ err }, 'mini-app server failed to start');
    }
  }

  // 9) Periodic cleanup: collection drafts past their TTL pile up otherwise
  // (the schema ON DELETE CASCADE removes their items in the same statement).
  // We hold the timer handle so the shutdown path can clear it; without that
  // the process would not exit on a clean stop.
  const draftCleanupIntervalMs = 15 * 60 * 1000; // 15 minutes
  let draftCleanupTimer: NodeJS.Timeout | undefined;
  if (config.ENABLE_COLLECTIONS) {
    draftCleanupTimer = setInterval(() => {
      try {
        const removed = repos.collectionDrafts.cleanupExpired(new Date());
        if (removed > 0) {
          log.debug({ removed }, 'collection drafts cleaned up');
        }
      } catch (err) {
        log.warn({ err }, 'collection draft cleanup failed');
      }
    }, draftCleanupIntervalMs);
    // Don't keep the event loop alive just for this timer.
    if (typeof draftCleanupTimer.unref === 'function') draftCleanupTimer.unref();
  }

  // 10) Signal wiring.
  let shuttingDown = false;
  const shutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.warn({ reason }, 'shutting down');

    if (draftCleanupTimer !== undefined) {
      clearInterval(draftCleanupTimer);
      draftCleanupTimer = undefined;
    }

    try {
      await mainRunner.stop();
    } catch (err) {
      log.warn({ err }, 'failed to stop main bot');
    }

    try {
      await childManager.stopAll();
    } catch (err) {
      log.warn({ err }, 'failed to stop child bots');
    }

    if (miniAppHandle) {
      try {
        await miniAppHandle.stop();
      } catch (err) {
        log.warn({ err }, 'failed to stop mini-app server');
      }
    }

    try {
      closeDatabase();
    } catch (err) {
      log.warn({ err }, 'failed to close database');
    }

    log.info('shutdown complete');
    // Exit code: 0 for signal-driven, 1 for exception-driven shutdowns.
    const code = reason === 'uncaughtException' || reason === 'unhandledRejection' ? 1 : 0;
    // Give the logger a chance to flush before the process exits.
    setImmediate(() => process.exit(code));
  };

  // Watch the main runner's `task()` promise. It resolves on a clean stop
  // and rejects on a fatal polling error (auth revoked, exhausted retries,
  // etc.). Without this, a dead runner would silently leave the process
  // alive; the `shuttingDown` guard ensures we still only run shutdown once.
  // The handle returns `undefined` when the runner isn't currently running,
  // which it is at this point — but we guard for type-safety.
  const mainTask = mainRunner.task();
  if (mainTask) {
    void mainTask.catch((err: unknown) => {
      log.error({ err }, 'main bot runner died');
      void shutdown('mainRunner.died');
    });
  }

  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaughtException');
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'unhandledRejection');
    void shutdown('unhandledRejection');
  });

  return { shutdown };
}
