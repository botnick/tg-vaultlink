/**
 * VaultLink Bot — child-bot lifecycle manager.
 *
 * Owns the `Map<username, Bot>` of running grammY instances built from the
 * managed-bot rows. The manager fire-and-forgets `bot.start()` (which is
 * long-running) so callers don't block waiting for the polling loop. When a
 * start fails the corresponding row is flipped to `status='error'` with a
 * sanitized message so operators can spot the dead bots without having to
 * grep the logs.
 *
 * The manager intentionally does NOT pass itself into child instances'
 * `createBot(...)` call — only the main bot dispatches `/add_bot` so child
 * bots cannot recursively spawn siblings.
 */

import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { run, sequentialize, type RunnerHandle } from '@grammyjs/runner';
import type { AppContext, AppRepos, AppServices } from './context.js';
import type { Config } from '../config/env.js';
import type { ManagedBotRow } from '../types/index.js';
import { createBot } from './createBot.js';
import { getLogger } from '../logger/logger.js';
import { AppError } from '../utils/errors.js';
import type { GetMeFn } from '../services/bot.service.js';

type AllowedUpdate = Exclude<keyof Update, 'update_id'>;

export interface ChildBotManagerDeps {
  config: Config;
  services: AppServices;
  repos: AppRepos;
  /** `getMe` callback, used only when an add operation needs to resolve the bot identity. */
  getMeFn: GetMeFn;
}

interface RunningChild {
  bot: Bot<AppContext>;
  handle: RunnerHandle;
}

export class ChildBotManager {
  private readonly running = new Map<string, RunningChild>();
  private readonly deps: ChildBotManagerDeps;

  constructor(deps: ChildBotManagerDeps) {
    this.deps = deps;
  }

  /**
   * Start a grammY instance for `record`. The bot is added to the running
   * map immediately; failures during `bot.start()` mark the row as errored
   * and remove it from the map.
   */
  async start(record: ManagedBotRow): Promise<void> {
    const log = getLogger();
    const username = record.username;

    if (this.running.has(username)) {
      // Already running; nothing to do.
      return;
    }

    let token: string;
    try {
      token = this.deps.services.bot.decryptToken(record);
    } catch (err) {
      const msg = sanitizeError(err);
      log.error({ username, err: msg }, 'failed to decrypt child bot token');
      this.deps.services.bot.markErrored(record, msg);
      return;
    }

    const grammyBot = createBot({
      token,
      bot: record,
      services: this.deps.services,
      repos: this.deps.repos,
      config: this.deps.config,
      // Child bots never receive the manager — they cannot spawn siblings.
    });

    // Per-user serialization keeps two updates from the same Telegram user
    // from racing on shared state, while updates from different users run
    // in parallel. This is the documented grammY production posture and is
    // what lets a single process safely service thousands of concurrent users.
    grammyBot.use(sequentialize((ctx) => ctx.from?.id?.toString()));

    const allowedUpdates = [...this.deps.config.BOT_POLLING_ALLOWED_UPDATES] as AllowedUpdate[];

    let handle: RunnerHandle;
    try {
      handle = run(grammyBot, {
        runner: {
          fetch: {
            allowed_updates: allowedUpdates,
            timeout: this.deps.config.TELEGRAM_LONG_POLL_TIMEOUT_SECONDS,
          },
        },
        sink: { concurrency: this.deps.config.RUNNER_CONCURRENCY },
      });
    } catch (err) {
      const msg = sanitizeError(err);
      log.error({ username, err: msg }, 'failed to start child bot runner');
      this.deps.services.bot.markErrored(record, msg);
      return;
    }

    this.running.set(username, { bot: grammyBot, handle });
    log.info({ username }, 'child bot started');

    // The runner exposes a `task()` promise that resolves when the polling
    // loop ends (clean stop) and rejects when it dies (auth revoked, network
    // partition, etc). Without watching it, a dead runner stays in the
    // `running` map forever — so we self-prune on either outcome and flip
    // the row to `error` on rejection so operators see the dead bot. The
    // promise is `undefined` only when the runner isn't currently running,
    // which it is here — the type guard satisfies strict-null TypeScript.
    const task = handle.task();
    if (task) {
      void task
        .then(
          () => {
            this.running.delete(username);
          },
          (err: unknown) => {
            this.running.delete(username);
            const msg = sanitizeError(err);
            log.error({ username, err: msg }, 'child bot runner died');
            try {
              this.deps.services.bot.markErrored(record, msg);
            } catch {
              // Marking may fail if the row was just removed; nothing to do.
            }
          },
        )
        .catch(() => undefined);
    }
  }

  /** Stop a single child bot by username. No-op if not currently running. */
  async stop(username: string): Promise<void> {
    const child = this.running.get(username);
    if (!child) return;
    this.running.delete(username);
    try {
      await child.handle.stop();
    } catch (err) {
      getLogger().warn({ username, err }, 'error while stopping child bot');
    }
  }

  /** Stop every running child bot (best-effort). */
  async stopAll(): Promise<void> {
    const log = getLogger();
    const usernames = [...this.running.keys()];
    await Promise.all(
      usernames.map(async (username) => {
        const child = this.running.get(username);
        this.running.delete(username);
        if (!child) return;
        try {
          await child.handle.stop();
        } catch (err) {
          log.warn({ username, err }, 'error while stopping child bot');
        }
      }),
    );
  }

  /**
   * Spin up every active managed bot. Starts are fan-out batched at
   * `CHILD_BOT_MAX_PARALLEL_STARTS` so cold boot doesn't spike the
   * Telegram API past its rate ceiling.
   */
  async startAll(): Promise<{ started: number; failed: number }> {
    const records = this.deps.services.bot.listActive();
    const log = getLogger();
    const fanOut = Math.max(1, this.deps.config.CHILD_BOT_MAX_PARALLEL_STARTS);

    let started = 0;
    let failed = 0;

    for (let i = 0; i < records.length; i += fanOut) {
      const batch = records.slice(i, i + fanOut);
      const results = await Promise.allSettled(
        batch.map((record) =>
          this.start(record).then(
            () => ({ ok: true as const, record }),
            (err: unknown) => ({ ok: false as const, record, err }),
          ),
        ),
      );
      for (const r of results) {
        if (r.status === 'rejected') {
          failed++;
          continue;
        }
        if (r.value.ok) {
          started++;
        } else {
          failed++;
          const msg = sanitizeError(r.value.err);
          log.error({ username: r.value.record.username, err: msg }, 'failed to start child bot');
          this.deps.services.bot.markErrored(r.value.record, msg);
        }
      }
    }
    return { started, failed };
  }

  /** Snapshot of currently running usernames. */
  list(): string[] {
    return [...this.running.keys()];
  }
}

/** Reduce an unknown error to a short, log-safe string. */
function sanitizeError(err: unknown): string {
  if (err instanceof AppError) return `${err.code}: ${err.message}`;
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'unknown error';
}
