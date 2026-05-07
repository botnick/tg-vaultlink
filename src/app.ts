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
import { run, sequentialize, type RunnerHandle } from '@grammyjs/runner';
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
import { BroadcastRepository } from './repositories/broadcast.repository.js';
import { CreditRepository } from './repositories/credit.repository.js';
import { CryptoInvoiceRepository } from './repositories/cryptoInvoice.repository.js';

import { AuditService } from './services/audit.service.js';
import { SettingsService } from './services/settings.service.js';
import { UserService } from './services/user.service.js';
import { RateLimitService } from './services/rateLimit.service.js';
import { PermissionService } from './services/permission.service.js';
import { FileService } from './services/file.service.js';
import { BotService } from './services/bot.service.js';
import { ReportService } from './services/report.service.js';
import { ShareService } from './services/share.service.js';
import { BroadcastService } from './services/broadcast.service.js';
import { BroadcastWorker } from './services/broadcast.worker.js';
import { CreditService } from './services/credit.service.js';
import { CryptoTopupService } from './services/crypto/cryptoTopup.service.js';
import { PaymentsService } from './services/payments.service.js';
import { CryptoTopupWorker } from './services/crypto/cryptoTopup.worker.js';
import { buildAdapterMap } from './services/crypto/chain.registry.js';
import { CRYPTO_SETTING_KEYS } from './services/crypto/cryptoTopup.service.js';

import { bootstrapMainBot, defaultGetMeFn } from './bot/mainBot.js';
import { ChildBotManager } from './bot/childBotManager.js';
import { createWebhookServer, type WebhookServer } from './bot/webhookServer.js';
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
    broadcasts: new BroadcastRepository(db),
    credits: new CreditRepository(db),
    cryptoInvoices: new CryptoInvoiceRepository(db),
  };

  // 3) Services (in dependency order).
  const audit = new AuditService(repos.audit);
  const settings = new SettingsService(repos.settings);
  const user = new UserService(repos.users, config);
  const rateLimit = new RateLimitService(repos.rateLimit, config);
  const permission = new PermissionService(repos.permissions, user, config, repos.bots);
  const file = new FileService(repos.files, repos.bots, audit, config);
  const bot = new BotService(repos.bots, audit, config, defaultGetMeFn);
  const report = new ReportService(repos.reports, repos.files, repos.collections, audit, config);
  const share = new ShareService({
    files: repos.files,
    bots: repos.bots,
    collections: repos.collections,
    drafts: repos.collectionDrafts,
    audit,
    config,
  });
  const broadcast = new BroadcastService(repos.broadcasts, repos.bots, permission, audit, config);
  const credits = new CreditService({
    credits: repos.credits,
    users: repos.users,
    settings,
    audit,
    config,
  });

  // Wave 9.3 — every chain×token combo is declared in
  // `src/services/crypto/chain.registry.ts`. Adding or removing a chain is
  // a one-line edit there; the wiring here just iterates. Adapters that
  // depend on env-supplied RPC URLs (BSC, ETH) silently no-op when the
  // operator hasn't configured their endpoint, keeping the matrix
  // pluggable without ceremony.
  const cryptoAdapters = buildAdapterMap({ config, settings });

  const crypto = new CryptoTopupService({
    invoices: repos.cryptoInvoices,
    settings,
    audit,
    credits,
    config,
    adapters: cryptoAdapters,
    rateLimit,
  });

  // payments is wired AFTER the main bot is bootstrapped — it needs the
  // live `bot.api` for createInvoiceLink + refundStarPayment. We attach
  // it lazily by mutating `services` once the bot is ready.
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
    broadcast,
    credits,
    crypto,
    // Sealed in below once `main` is built. Cast keeps the type honest at
    // the property level while we defer construction.
    payments: undefined as unknown as PaymentsService,
  };

  // Touch CRYPTO_SETTING_KEYS so the import is preserved against tree-shake.
  void CRYPTO_SETTING_KEYS;

  // 4) Optional webhook listener — built once when TELEGRAM_UPDATE_MODE=webhook
  // so both the main bot and every child bot can share one HTTP port. In
  // long_poll mode this stays `null` and no HTTP listener is opened.
  let webhookServer: WebhookServer | null = null;
  if (config.TELEGRAM_UPDATE_MODE === 'webhook') {
    webhookServer = createWebhookServer({ port: config.WEBHOOK_PORT });
  }

  // 5) Child-bot manager (constructed up-front so the main bot can reference it).
  const childManager = new ChildBotManager({
    config,
    services,
    repos,
    getMeFn: defaultGetMeFn,
    ...(webhookServer ? { webhookServer } : {}),
  });

  // 6) Main bot.
  const main = await bootstrapMainBot({
    config,
    services,
    repos,
    childManager,
  });

  // Wave 9.2 — payments service can now be constructed against the live
  // bot.api and folded into the services bundle so subsequent consumers
  // (Mini App routes, admin refund flow) see a fully-populated AppServices.
  const payments = new PaymentsService({
    botApi: main.bot.api,
    config,
    credits,
    audit,
    rateLimitRepo: repos.rateLimit,
  });
  (services as { payments: PaymentsService }).payments = payments;

  type AllowedUpdate = Exclude<keyof Update, 'update_id'>;
  const allowedUpdates = [...config.BOT_POLLING_ALLOWED_UPDATES] as AllowedUpdate[];
  main.bot.use(sequentialize((ctx) => ctx.from?.id?.toString()));

  // Track the highest update_id we've acknowledged so the long-poll shutdown
  // path can confirm it back to Telegram. Without this, our half of the
  // long-poll stays "open" on Telegram's side until TELEGRAM_LONG_POLL_TIMEOUT
  // expires (up to 50s) — the cause of every "I just restarted and got 409".
  // Reaching this middleware also means an update flowed end-to-end, so it's
  // the natural place to reset the consecutive-409 counter that drives the
  // long-poll restart-with-backoff loop further down.
  let lastAckedUpdateId = 0;
  let consecutive409s = 0;
  main.bot.use((ctx, next) => {
    if (ctx.update.update_id > lastAckedUpdateId) lastAckedUpdateId = ctx.update.update_id;
    consecutive409s = 0;
    return next();
  });

  // 7) Start the main bot via the chosen update channel.
  let mainRunner: RunnerHandle | null = null;
  let stopMain: () => Promise<void>;
  if (webhookServer && config.TELEGRAM_UPDATE_MODE === 'webhook') {
    const secret = config.WEBHOOK_SECRET_TOKEN || null;
    webhookServer.register(main.record.telegram_bot_id, main.bot, secret);
    await webhookServer.start();
    const url = `${config.WEBHOOK_BASE_URL.replace(/\/+$/, '')}/webhook/${main.record.telegram_bot_id}`;
    await main.bot.api.setWebhook(url, {
      ...(secret ? { secret_token: secret } : {}),
      allowed_updates: allowedUpdates,
      drop_pending_updates: false,
    });
    log.info({ username: main.record.username, url }, 'main bot webhook registered');
    stopMain = async () => {
      try {
        await main.bot.api.deleteWebhook({ drop_pending_updates: false });
      } catch (err) {
        log.warn({ err }, 'failed to deleteWebhook on shutdown');
      }
    };
  } else {
    // Long polling via @grammyjs/runner — per-user sequentialize keeps two
    // updates from the same Telegram user from racing on shared state.
    //
    // Preflight: a previous run that died with SIGINT or a hard crash may
    // have left a long-poll request hanging on Telegram's side. Until that
    // request expires (up to TELEGRAM_LONG_POLL_TIMEOUT_SECONDS), every new
    // getUpdates returns 409. Probe with a non-blocking getUpdates and
    // retry until Telegram releases the lock. Also nukes any leftover
    // webhook so the bot definitely starts in pure-polling mode.
    try {
      await main.bot.api.deleteWebhook({ drop_pending_updates: false });
    } catch (err) {
      log.warn({ err }, 'preflight deleteWebhook failed (probably no webhook set)');
    }
    // The probe deliberately uses a non-zero timeout. timeout=0 short polling
    // does NOT compete for the long-poll lock — Telegram accepts it alongside
    // a pending long-poll, so we'd see "OK" here and then 409 the moment the
    // runner asks for timeout=50. A 2s probe actually contends for the lock,
    // so 409 surfaces during preflight and we can retry until it clears.
    const probeTimeoutSec = 2;
    const maxWaitMs = (config.TELEGRAM_LONG_POLL_TIMEOUT_SECONDS + 10) * 1000;
    const start = Date.now();
    let attempts = 0;
    let cleared = false;
    while (!cleared) {
      attempts++;
      try {
        await main.bot.api.getUpdates({
          timeout: probeTimeoutSec,
          offset: -1,
          limit: 1,
        });
        if (attempts > 1) {
          log.info({ attempts }, 'poll lock cleared');
        }
        cleared = true;
      } catch (err) {
        const code = (err as { error_code?: number }).error_code;
        if (code === 409 && Date.now() - start < maxWaitMs) {
          log.info({ attempts }, 'waiting for stale getUpdates lock to expire');
          continue; // probe itself already burned `probeTimeoutSec` seconds
        }
        if (code === 409) {
          log.error(
            { attempts, waitedMs: Date.now() - start },
            'poll lock still held after full timeout window - another deployment of this bot token is polling Telegram. Either kill it or switch to TELEGRAM_UPDATE_MODE=webhook.',
          );
        } else {
          log.warn({ err, attempts }, 'poll lock preflight failed; starting anyway');
        }
        break;
      }
    }
    // Self-healing wrapper around the grammY runner. grammY treats 409 as a
    // fatal `task()` rejection, but operationally a 409 just means a stale
    // long-poll on Telegram's side hasn't expired yet, or a zombie second
    // instance briefly held the lock. Pattern aligned with Anthropic's
    // claude-plugins-official PR #825 fix for the same issue: linear
    // backoff (1 s → 15 s cap) and retry indefinitely. The counter resets
    // the moment any update flows through the bot, so a single transient
    // race never escalates and a rogue deploy that eventually dies is
    // recovered from automatically.
    const buildRunner = (): RunnerHandle =>
      run(main.bot, {
        runner: {
          fetch: {
            allowed_updates: allowedUpdates,
            timeout: config.TELEGRAM_LONG_POLL_TIMEOUT_SECONDS,
          },
        },
        sink: { concurrency: config.RUNNER_CONCURRENCY },
      });

    const RESTART_BASE_MS = 1_000;
    const RESTART_MAX_MS = 15_000;
    let stopRequested = false;
    let restartTimer: NodeJS.Timeout | null = null;

    const watchRunner = (handle: RunnerHandle): void => {
      const task = handle.task();
      if (!task) return;
      void task.catch((err: unknown) => {
        if (stopRequested) return;
        const code = (err as { error_code?: number }).error_code;
        if (code === 409) {
          consecutive409s++;
          const delayMs = Math.min(consecutive409s * RESTART_BASE_MS, RESTART_MAX_MS);
          const detail =
            consecutive409s === 1
              ? ' (another instance is polling - zombie from a previous run, or a second deployment?)'
              : '';
          log.warn(
            { attempt: consecutive409s, delayMs },
            `runner died with 409${detail}. Retrying in ${delayMs}ms.`,
          );
          restartTimer = setTimeout(() => {
            restartTimer = null;
            if (stopRequested) return;
            mainRunner = buildRunner();
            watchRunner(mainRunner);
          }, delayMs);
          if (typeof restartTimer.unref === 'function') restartTimer.unref();
          return;
        }
        log.error({ err }, 'main bot runner died');
        void shutdown('mainRunner.died');
      });
    };

    mainRunner = buildRunner();
    watchRunner(mainRunner);
    log.info(
      { username: main.record.username, concurrency: config.RUNNER_CONCURRENCY },
      'main bot started',
    );

    stopMain = async () => {
      stopRequested = true;
      if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = null;
      }
      // Order matters: graceful release MUST run BEFORE runner.stop().
      // The runner's .stop() awaits the in-flight getUpdates to return,
      // which by default takes up to TELEGRAM_LONG_POLL_TIMEOUT_SECONDS
      // (50 s). During that window the bot is still polling Telegram, so
      // any restart attempt collides with us and gets 409. Sending a
      // fresh getUpdates with offset=-1 (Telegram contract: "All previous
      // updates will be forgotten") forces the in-flight request to
      // return immediately, which makes runner.stop() return in
      // milliseconds and frees the bot_id slot before we exit.
      try {
        await main.bot.api.getUpdates({
          offset: lastAckedUpdateId > 0 ? lastAckedUpdateId + 1 : -1,
          timeout: 0,
          limit: 1,
        });
      } catch {
        // Best-effort. If this fails the next-boot preflight still recovers
        // within TELEGRAM_LONG_POLL_TIMEOUT_SECONDS.
      }
      if (mainRunner) {
        try {
          await mainRunner.stop();
        } catch (err) {
          log.warn({ err }, 'failed to stop runner');
        }
      }
    };
  }

  // 8) Optionally start child bots.
  if (config.ENABLE_CHILD_BOTS) {
    try {
      const result = await childManager.startAll();
      log.info(result, 'child bots started');
    } catch (err) {
      log.error({ err }, 'failed to start child bots');
    }
  }

  // 8.5) Broadcast worker — picks up scheduled + sending broadcasts and
  // fans them out via the appropriate bot. Resumable across restarts: any
  // broadcast left in 'sending' on boot resumes from its remaining pending
  // recipients on the next tick. Single-process by design (the recipient
  // claim is atomic within SQLite's writer lock, but two workers would
  // race across processes).
  const broadcastWorker = new BroadcastWorker({
    repo: repos.broadcasts,
    users: repos.users,
    resolveBot: (botId: number) => {
      if (botId === main.record.id) return main.bot;
      return childManager.getByBotId(botId);
    },
  });
  broadcastWorker.start();

  // Wave 9.1 — crypto top-up poller. Stays idle while ENABLE_CRYPTO_TOPUP
  // is false (every tick short-circuits at `service.isEnabled()`).
  const cryptoWorker = new CryptoTopupWorker({
    service: crypto,
    invoices: repos.cryptoInvoices,
    audit,
  });
  cryptoWorker.start();

  // 9) Optionally start the Mini App backend. The module is loaded
  // dynamically so a misconfigured Mini App build cannot block the bot's
  // hot-path bootstrap.
  let miniAppHandle: { stop(): Promise<void> } | null = null;
  if (config.ENABLE_MINI_APP) {
    try {
      const mod = await import('./miniapp/server.js');
      const server = mod.createMiniAppServer({
        config,
        services,
        repos,
        // Same resolver shape the broadcast worker uses — main bot is
        // looked up by reference, child bots by id. Wiring it here means
        // the Reports admin queue can forward reported content from the
        // owning bot to the moderator's chat.
        resolveBot: (botId: number) => {
          if (botId === main.record.id) return main.bot;
          return childManager.getByBotId(botId);
        },
      });
      await server.start();
      miniAppHandle = server;
      log.info('mini-app server started');
    } catch (err) {
      log.error({ err }, 'mini-app server failed to start');
    }
  }

  // 10) Periodic cleanup: collection drafts past their TTL pile up otherwise
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

  // 11) Signal wiring.
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
      broadcastWorker.stop();
    } catch (err) {
      log.warn({ err }, 'failed to stop broadcast worker');
    }

    try {
      cryptoWorker.stop();
    } catch (err) {
      log.warn({ err }, 'failed to stop crypto worker');
    }

    try {
      await stopMain();
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

    if (webhookServer) {
      try {
        await webhookServer.stop();
      } catch (err) {
        log.warn({ err }, 'failed to stop webhook server');
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

  // The long-poll branch already wires its own runner watcher (with the
  // 409 restart-with-backoff logic). Webhook mode has no runner — Telegram
  // POSTs in and the Hono server's lifecycle is what matters there.

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
