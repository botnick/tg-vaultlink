/**
 * VaultLink Bot — broadcast dispatch worker.
 *
 * The fan-out half of the broadcast system. The {@link BroadcastService}
 * flips a row to `status='sending'`; this worker (one tick per second)
 * picks it up, claims a batch of pending recipients, dispatches each
 * message via the owning bot's grammY `api`, and writes back the result.
 *
 * Single-process by design — the recipient claim is atomic within SQLite's
 * writer lock, but two workers across two processes would race on the same
 * batch. Production deployments run a single Node process per database
 * (the rest of the app already assumes this), so this is fine.
 *
 * Rate limiting is delegated to the throttler attached to every bot's
 * `api` (see `createBot.ts`). The worker dispatches a whole batch via
 * `Promise.all` and lets the throttler do the pacing — adding a second
 * token bucket here would just stall the throttler's queue.
 *
 * Telegram error classification lives in `utils/telegramErrors.ts` so the
 * global error boundary and this worker agree on what counts as
 * "permanently unreachable" vs. "transient retry".
 */

import type { Bot } from 'grammy';
import { GrammyError, InlineKeyboard } from 'grammy';
import type { AppContext } from '../bot/context.js';
import type {
  BroadcastButton,
  BroadcastRecipientRow,
  BroadcastRow,
  UserRow,
} from '../types/index.js';
import type { BroadcastRepository } from '../repositories/broadcast.repository.js';
import type { UserRepository } from '../repositories/user.repository.js';
import { getLogger } from '../logger/logger.js';

/** Defensive logger getter — falls back to console if the env-driven logger
 * isn't initialized (e.g. inside Vitest with no env file). Keeps the worker
 * testable without importing the whole config validation surface. */
function safeLog(): { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void; debug: (...a: unknown[]) => void } {
  try {
    return getLogger() as never;
  } catch {
    return {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    };
  }
}
import {
  getRetryAfterSeconds,
  isTelegramServerError,
  isUnreachableChatError,
} from '../utils/telegramErrors.js';

/** Resolves a bot id to its running grammY instance, or null when the bot
 * is not currently up (offline, errored, or removed). The worker calls
 * this every tick so child bots that come online mid-broadcast get
 * picked up automatically. */
export type BotResolver = (botId: number) => Bot<AppContext> | null;

export interface BroadcastWorkerDeps {
  repo: BroadcastRepository;
  users: UserRepository;
  resolveBot: BotResolver;
  /** Tick interval in ms. Default 1000. */
  intervalMs?: number;
  /** Max recipients per broadcast per tick. Default 50. */
  batchSize?: number;
  /** Max retry attempts for transient errors before giving up. Default 3. */
  maxRetries?: number;
}

export class BroadcastWorker {
  private readonly repo: BroadcastRepository;
  private readonly users: UserRepository;
  private readonly resolveBot: BotResolver;
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly maxRetries: number;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(deps: BroadcastWorkerDeps) {
    this.repo = deps.repo;
    this.users = deps.users;
    this.resolveBot = deps.resolveBot;
    this.intervalMs = deps.intervalMs ?? 1000;
    this.batchSize = deps.batchSize ?? 50;
    this.maxRetries = deps.maxRetries ?? 3;
  }

  /** Begin the tick loop. Idempotent. */
  start(): void {
    if (this.timer) return;
    const log = safeLog();
    log.info({ intervalMs: this.intervalMs, batchSize: this.batchSize }, 'broadcast worker start');
    this.timer = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop the tick loop. Pending in-flight work continues to completion;
   * the next tick simply doesn't fire. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One tick — exposed so tests can drive the worker deterministically. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.runTick();
    } catch (err) {
      safeLog().error({ err }, 'broadcast worker tick crashed');
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    // 1) Promote any due scheduled broadcasts to sending. Materialization
    //    happens lazily on first dispatch — keeps the tick under control
    //    when several broadcasts come due at once.
    const dueScheduled = this.repo.listDueScheduled(new Date().toISOString());
    for (const row of dueScheduled) {
      const flipped = this.repo.tryTransition(row.id, ['scheduled'], 'sending');
      if (flipped) {
        // Materialize lazily — listSending() picks it up on the next tick.
        // We bump count_pending so the UI doesn't briefly show "0 / 0" while
        // the materializer runs.
        safeLog().info({ id: row.id }, 'broadcast scheduled → sending');
      }
    }

    // 2) Drive every in-flight broadcast forward.
    const sending = this.repo.listSending();
    for (const row of sending) {
      try {
        await this.dispatchOne(row);
      } catch (err) {
        safeLog().error({ err, id: row.id }, 'broadcast dispatch failed');
      }
    }
  }

  /** Dispatch one batch for one broadcast. */
  private async dispatchOne(row: BroadcastRow): Promise<void> {
    const log = safeLog();
    const bot = this.resolveBot(row.bot_id);
    if (!bot) {
      // Bot offline — leave the broadcast in 'sending' and try again next tick.
      // Operators see the lack of progress in the UI; we don't fail the row
      // because a transient outage shouldn't drop the announcement.
      log.warn({ id: row.id, bot_id: row.bot_id }, 'broadcast bot not running, skipping tick');
      return;
    }

    // Lazy materialization — if we never created recipients (e.g. scheduled
    // path) do it now. Idempotent thanks to the unique constraint.
    if (row.audience_count === 0) {
      let audience;
      try {
        audience = JSON.parse(row.audience_json) as Parameters<
          BroadcastRepository['materializeRecipients']
        >[1];
      } catch {
        log.error({ id: row.id }, 'broadcast audience_json invalid; failing broadcast');
        this.repo.tryTransition(row.id, ['sending'], 'failed');
        return;
      }
      const count = this.repo.materializeRecipients(row.id, audience);
      this.repo.setAudienceCount(row.id, count);
      if (count === 0) {
        log.warn({ id: row.id }, 'broadcast materialized empty audience; marking completed');
        this.repo.tryTransition(row.id, ['sending'], 'completed');
        return;
      }
    }

    const claimed = this.repo.claimPending(row.id, this.batchSize);
    if (claimed.length === 0) {
      // Nothing left to send — finalize.
      if (this.repo.isCompleted(row.id)) {
        this.repo.recomputeCounts(row.id);
        this.repo.tryTransition(row.id, ['sending'], 'completed');
        log.info({ id: row.id }, 'broadcast completed');
      }
      return;
    }

    // Batch-fetch the user rows so we can substitute template variables
    // (`{{first_name}}`, `{{username}}`, `{{user_id}}`). Done in a single
    // SELECT for the whole batch.
    const userMap = this.fetchUsers(claimed.map((r) => r.user_id));

    // Buttons are identical across recipients — build the markup once.
    const buttons = parseButtons(row.buttons_json);
    const markup = buildInlineKeyboard(buttons);

    await Promise.all(
      claimed.map(async (recipient) => {
        const user = userMap.get(recipient.user_id);
        if (!user) {
          // User was deleted between materialize and dispatch — skip.
          this.repo.markFailed(recipient.id, 'user_missing', 'user row not found');
          return;
        }
        await this.sendOne(bot, row, recipient, user, markup);
      }),
    );

    // Refresh the broadcast's counters from authority rows so the UI's
    // 2-second poll has fresh numbers without aggregating per render.
    const counts = this.repo.recomputeCounts(row.id);
    if (counts.pending === 0) {
      this.repo.tryTransition(row.id, ['sending'], 'completed');
      log.info({ id: row.id, ...counts }, 'broadcast completed');
    }
  }

  private fetchUsers(ids: number[]): Map<number, UserRow> {
    const out = new Map<number, UserRow>();
    if (ids.length === 0) return out;
    // No batched-IN method on UserRepository today; fall back to per-row
    // findById. Better-sqlite3 is sync and prepared, so 50 lookups round-trip
    // in well under 1 ms — not worth the new repo method.
    for (const id of ids) {
      const u = this.users.findById(id);
      if (u) out.set(id, u);
    }
    return out;
  }

  /** Dispatch a single recipient. All Telegram error paths are classified
   * here so the rest of the worker can stay branchless. */
  private async sendOne(
    bot: Bot<AppContext>,
    row: BroadcastRow,
    recipient: BroadcastRecipientRow,
    user: UserRow,
    markup: InlineKeyboard | undefined,
  ): Promise<void> {
    const log = safeLog();
    const chatId = Number(recipient.telegram_user_id);
    if (!Number.isFinite(chatId)) {
      this.repo.markFailed(recipient.id, 'invalid_chat_id', recipient.telegram_user_id);
      return;
    }
    const rendered = renderText(row.text, user, row.parse_mode);

    try {
      const messageId = await dispatchMessage(bot, chatId, row, rendered, markup);
      this.repo.markSent(recipient.id, messageId);
    } catch (err) {
      this.classifyAndRecord(recipient, err);
      // Only log an info-level on terminal blocks; everything else is
      // already covered by classify's debug.
      if (isUnreachableChatError(err)) {
        log.debug({ id: recipient.id }, 'broadcast recipient blocked');
      }
    }
  }

  private classifyAndRecord(recipient: BroadcastRecipientRow, err: unknown): void {
    if (isUnreachableChatError(err)) {
      this.repo.markBlocked(recipient.id, briefError(err));
      return;
    }
    const retryAfter = getRetryAfterSeconds(err);
    if (retryAfter !== null && recipient.retry_count < this.maxRetries) {
      const next = new Date(Date.now() + Math.max(retryAfter, 1) * 1000).toISOString();
      this.repo.rescheduleForRetry(recipient.id, next, briefError(err));
      return;
    }
    if (isTelegramServerError(err) && recipient.retry_count < this.maxRetries) {
      // Exponential backoff on 5xx — 2s, 4s, 8s.
      const delayMs = 2_000 * 2 ** recipient.retry_count;
      const next = new Date(Date.now() + delayMs).toISOString();
      this.repo.rescheduleForRetry(recipient.id, next, briefError(err));
      return;
    }
    this.repo.markFailed(recipient.id, errorCode(err), briefError(err));
  }
}

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

/** Parse `broadcasts.buttons_json` defensively. */
function parseButtons(json: string | null): BroadcastButton[][] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return null;
    const out: BroadcastButton[][] = [];
    for (const row of v) {
      if (!Array.isArray(row)) continue;
      const r: BroadcastButton[] = [];
      for (const btn of row) {
        if (
          btn &&
          typeof btn === 'object' &&
          typeof btn.text === 'string' &&
          typeof btn.url === 'string'
        ) {
          r.push({ text: btn.text, url: btn.url });
        }
      }
      if (r.length > 0) out.push(r);
    }
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** Build an InlineKeyboard from a buttons matrix, or undefined for none. */
function buildInlineKeyboard(buttons: BroadcastButton[][] | null): InlineKeyboard | undefined {
  if (!buttons) return undefined;
  const kb = new InlineKeyboard();
  for (let i = 0; i < buttons.length; i++) {
    const row = buttons[i];
    if (!row) continue;
    for (const btn of row) {
      kb.url(btn.text, btn.url);
    }
    if (i < buttons.length - 1) kb.row();
  }
  return kb;
}

/**
 * Substitute {{first_name}} / {{username}} / {{user_id}} / {{full_name}}
 * placeholders. Values are escaped according to `parse_mode` so a name with
 * `<` or `_` doesn't break the markup.
 */
function renderText(
  text: string,
  user: UserRow,
  parseMode: BroadcastRow['parse_mode'],
): string {
  const first = user.first_name ?? '';
  const last = user.last_name ?? '';
  const full = [first, last].filter((s) => s.trim().length > 0).join(' ');
  const handle = user.username ?? '';
  const tgId = user.telegram_user_id;
  const escape = parseMode === 'HTML' ? escapeHtml : parseMode === 'MarkdownV2' ? escapeMd2 : id;
  return text
    .replace(/\{\{\s*first_name\s*\}\}/g, escape(first))
    .replace(/\{\{\s*last_name\s*\}\}/g, escape(last))
    .replace(/\{\{\s*full_name\s*\}\}/g, escape(full))
    .replace(/\{\{\s*username\s*\}\}/g, escape(handle))
    .replace(/\{\{\s*user_id\s*\}\}/g, escape(tgId));
}

const id = (s: string): string => s;

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return c;
    }
  });
}

function escapeMd2(s: string): string {
  // MarkdownV2 reserves these — escape with leading backslash.
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, (c) => `\\${c}`);
}

/** One Telegram dispatch — sendMessage/sendPhoto/sendVideo/sendDocument
 * depending on the broadcast's media. Returns the resulting `message_id`. */
async function dispatchMessage(
  bot: Bot<AppContext>,
  chatId: number,
  row: BroadcastRow,
  renderedText: string,
  markup: InlineKeyboard | undefined,
): Promise<number> {
  const common: Record<string, unknown> = {
    disable_notification: row.silent === 1,
    protect_content: row.protect_content === 1,
  };
  if (markup) common.reply_markup = markup;
  if (row.parse_mode) common.parse_mode = row.parse_mode;

  if (row.media_type && row.media_file_id) {
    switch (row.media_type) {
      case 'photo': {
        const m = await bot.api.sendPhoto(chatId, row.media_file_id, {
          ...common,
          caption: renderedText,
        });
        return m.message_id;
      }
      case 'video': {
        const m = await bot.api.sendVideo(chatId, row.media_file_id, {
          ...common,
          caption: renderedText,
        });
        return m.message_id;
      }
      case 'document': {
        const m = await bot.api.sendDocument(chatId, row.media_file_id, {
          ...common,
          caption: renderedText,
        });
        return m.message_id;
      }
      case 'animation': {
        const m = await bot.api.sendAnimation(chatId, row.media_file_id, {
          ...common,
          caption: renderedText,
        });
        return m.message_id;
      }
      default:
      // Unknown media type — fall through to text.
    }
  }
  const m = await bot.api.sendMessage(chatId, renderedText, {
    ...common,
    ...(row.disable_web_page_preview === 1
      ? { link_preview_options: { is_disabled: true } }
      : {}),
  });
  return m.message_id;
}

function briefError(err: unknown): string {
  if (err instanceof GrammyError) {
    const code = (err as { error_code?: number }).error_code;
    return `${code ?? '?'}: ${err.description ?? err.message ?? 'GrammyError'}`.slice(0, 240);
  }
  if (err instanceof Error) return err.message.slice(0, 240);
  return String(err).slice(0, 240);
}

function errorCode(err: unknown): string {
  if (err instanceof GrammyError) {
    const code = (err as { error_code?: number }).error_code;
    return `tg_${code ?? 'unknown'}`;
  }
  return 'internal';
}
