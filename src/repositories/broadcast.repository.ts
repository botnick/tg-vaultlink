/**
 * Broadcast repository — announcements and their per-user delivery rows.
 *
 * Two tables: `broadcasts` (one row per announcement) and
 * `broadcast_recipients` (one row per user × broadcast, with delivery
 * status). The repo is intentionally low-level: status transitions, batch
 * claims, and counter bookkeeping live here so the service layer can stay
 * focused on permissions and content validation, and the worker can stay
 * focused on Telegram-side concerns.
 *
 * Concurrency model: every write that races with another write
 * (`claimPending`, `tryStartScheduled`, status flips) goes through a
 * `db.transaction()` and uses a SELECT-then-UPDATE-WHERE-status pattern so
 * SQLite's writer lock + the WHERE re-check together prevent double-claim.
 * Callers must assume one BroadcastWorker per process.
 */

import type { Db } from '../db/database.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type {
  BroadcastAudience,
  BroadcastButton,
  BroadcastParseMode,
  BroadcastRecipientRow,
  BroadcastRecipientStatus,
  BroadcastRow,
  BroadcastStatus,
} from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

/** Shape passed to {@link BroadcastRepository.insert}. */
export interface InsertBroadcastInput {
  bot_id: number;
  created_by: number;
  text: string;
  parse_mode: BroadcastParseMode | null;
  media_type: string | null;
  media_file_id: string | null;
  buttons: BroadcastButton[][] | null;
  disable_web_page_preview: boolean;
  protect_content: boolean;
  silent: boolean;
  audience: BroadcastAudience;
}

/** Patch applied via {@link BroadcastRepository.updateDraft}. */
export interface UpdateBroadcastDraftInput {
  text?: string;
  parse_mode?: BroadcastParseMode | null;
  media_type?: string | null;
  media_file_id?: string | null;
  buttons?: BroadcastButton[][] | null;
  disable_web_page_preview?: boolean;
  protect_content?: boolean;
  silent?: boolean;
  audience?: BroadcastAudience;
}

/** Audience JSON parser shared by the service + worker. Returns the
 * canonical default-filled object so missing fields don't crash callers. */
export function parseAudience(raw: string): BroadcastAudience {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }
  const obj = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const localeRaw = obj.locale;
  const locale: BroadcastAudience['locale'] =
    localeRaw === 'en' || localeRaw === 'th' ? localeRaw : 'all';
  const roleRaw = obj.role;
  const role: BroadcastAudience['role'] =
    roleRaw === 'super_admin' || roleRaw === 'user' ? roleRaw : 'all';
  const userIdsRaw = obj.user_ids;
  const user_ids = Array.isArray(userIdsRaw)
    ? userIdsRaw.filter((v): v is string => typeof v === 'string')
    : [];
  const regRaw = obj.registered_within_days;
  const registered_within_days =
    typeof regRaw === 'number' && Number.isFinite(regRaw) && regRaw > 0
      ? Math.floor(regRaw)
      : null;
  return {
    locale,
    role,
    exclude_banned: obj.exclude_banned !== false,
    exclude_unsubscribed: obj.exclude_unsubscribed !== false,
    registered_within_days,
    user_ids,
  };
}

/** Inverse of {@link parseAudience}. Canonicalizes before storing. */
export function stringifyAudience(a: BroadcastAudience): string {
  return JSON.stringify({
    locale: a.locale,
    role: a.role,
    exclude_banned: a.exclude_banned,
    exclude_unsubscribed: a.exclude_unsubscribed,
    registered_within_days: a.registered_within_days,
    user_ids: a.user_ids,
  });
}

/** Build the WHERE clause + bound args matching an audience filter. */
function audienceWhere(a: BroadcastAudience): { sql: string; args: unknown[] } {
  // Explicit allowlist short-circuits every other filter — useful for test
  // sends and for "ping these specific users" workflows.
  if (a.user_ids.length > 0) {
    const placeholders = a.user_ids.map(() => '?').join(',');
    return {
      sql: `telegram_user_id IN (${placeholders})`,
      args: [...a.user_ids],
    };
  }
  const clauses: string[] = ['1=1'];
  const args: unknown[] = [];
  if (a.locale !== 'all') {
    clauses.push('locale = ?');
    args.push(a.locale);
  }
  if (a.role !== 'all') {
    clauses.push('role = ?');
    args.push(a.role);
  }
  if (a.exclude_banned) clauses.push('is_banned = 0');
  if (a.exclude_unsubscribed) clauses.push('broadcast_unsubscribed = 0');
  if (a.registered_within_days !== null) {
    clauses.push("created_at >= datetime('now', ?)");
    args.push(`-${a.registered_within_days} days`);
  }
  return { sql: clauses.join(' AND '), args };
}

export class BroadcastRepository {
  constructor(private readonly db: Db) {}

  /* ---------------------------------------------------------------------- *
   * Broadcast CRUD
   * ---------------------------------------------------------------------- */

  insert(input: InsertBroadcastInput): BroadcastRow {
    const stmt = this.db.prepare(
      `INSERT INTO broadcasts (
         bot_id, created_by, status,
         text, parse_mode, media_type, media_file_id, buttons_json,
         disable_web_page_preview, protect_content, silent,
         audience_json, audience_count,
         count_pending, count_sent, count_failed, count_blocked,
         created_at, updated_at
       ) VALUES (
         @bot_id, @created_by, 'draft',
         @text, @parse_mode, @media_type, @media_file_id, @buttons_json,
         @dwpp, @protect, @silent,
         @audience_json, 0,
         0, 0, 0, 0,
         @now, @now
       )
       RETURNING *`,
    );
    const row = stmt.get({
      bot_id: input.bot_id,
      created_by: input.created_by,
      text: input.text,
      parse_mode: input.parse_mode,
      media_type: input.media_type,
      media_file_id: input.media_file_id,
      buttons_json: input.buttons === null ? null : JSON.stringify(input.buttons),
      dwpp: input.disable_web_page_preview ? 1 : 0,
      protect: input.protect_content ? 1 : 0,
      silent: input.silent ? 1 : 0,
      audience_json: stringifyAudience(input.audience),
      now: nowIso(),
    }) as unknown as BroadcastRow | undefined;
    if (!row) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'broadcast insert returned no row');
    }
    return row;
  }

  /** Apply a patch — only allowed while status='draft'. The service enforces. */
  updateDraft(id: number, patch: UpdateBroadcastDraftInput): BroadcastRow {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id, now: nowIso() };
    if (patch.text !== undefined) {
      sets.push('text = @text');
      params.text = patch.text;
    }
    if (patch.parse_mode !== undefined) {
      sets.push('parse_mode = @parse_mode');
      params.parse_mode = patch.parse_mode;
    }
    if (patch.media_type !== undefined) {
      sets.push('media_type = @media_type');
      params.media_type = patch.media_type;
    }
    if (patch.media_file_id !== undefined) {
      sets.push('media_file_id = @media_file_id');
      params.media_file_id = patch.media_file_id;
    }
    if (patch.buttons !== undefined) {
      sets.push('buttons_json = @buttons_json');
      params.buttons_json = patch.buttons === null ? null : JSON.stringify(patch.buttons);
    }
    if (patch.disable_web_page_preview !== undefined) {
      sets.push('disable_web_page_preview = @dwpp');
      params.dwpp = patch.disable_web_page_preview ? 1 : 0;
    }
    if (patch.protect_content !== undefined) {
      sets.push('protect_content = @protect');
      params.protect = patch.protect_content ? 1 : 0;
    }
    if (patch.silent !== undefined) {
      sets.push('silent = @silent');
      params.silent = patch.silent ? 1 : 0;
    }
    if (patch.audience !== undefined) {
      sets.push('audience_json = @audience_json');
      params.audience_json = stringifyAudience(patch.audience);
    }
    sets.push('updated_at = @now');

    const sql = `UPDATE broadcasts SET ${sets.join(', ')}
                   WHERE id = @id AND status = 'draft' RETURNING *`;
    const row = this.db.prepare(sql).get(params) as unknown as BroadcastRow | undefined;
    if (!row) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `broadcast ${id} is not a draft (or does not exist)`,
        { meta: { id } },
      );
    }
    return row;
  }

  findById(id: number): BroadcastRow | undefined {
    return this.db.prepare('SELECT * FROM broadcasts WHERE id = ?').get(id) as unknown as
      | BroadcastRow
      | undefined;
  }

  /** Listing for the admin Mini App. `bot_id` filter is optional (founder
   * sees every broadcast across every bot when null). */
  list(opts: {
    bot_id?: number | null;
    status?: BroadcastStatus | null;
    limit: number;
    offset: number;
  }): BroadcastRow[] {
    const clauses: string[] = ['1=1'];
    const args: unknown[] = [];
    if (opts.bot_id !== null && opts.bot_id !== undefined) {
      clauses.push('bot_id = ?');
      args.push(opts.bot_id);
    }
    if (opts.status !== null && opts.status !== undefined) {
      clauses.push('status = ?');
      args.push(opts.status);
    }
    const sql = `SELECT * FROM broadcasts WHERE ${clauses.join(' AND ')}
                  ORDER BY id DESC LIMIT ? OFFSET ?`;
    return this.db
      .prepare(sql)
      .all(...args, opts.limit, opts.offset) as unknown as BroadcastRow[];
  }

  count(opts: { bot_id?: number | null; status?: BroadcastStatus | null }): number {
    const clauses: string[] = ['1=1'];
    const args: unknown[] = [];
    if (opts.bot_id !== null && opts.bot_id !== undefined) {
      clauses.push('bot_id = ?');
      args.push(opts.bot_id);
    }
    if (opts.status !== null && opts.status !== undefined) {
      clauses.push('status = ?');
      args.push(opts.status);
    }
    const sql = `SELECT COUNT(*) AS n FROM broadcasts WHERE ${clauses.join(' AND ')}`;
    const row = this.db.prepare(sql).get(...args) as { n: number };
    return row.n;
  }

  /** Permanent deletion — only allowed for drafts. */
  deleteDraft(id: number): boolean {
    const info = this.db
      .prepare("DELETE FROM broadcasts WHERE id = ? AND status = 'draft'")
      .run(id);
    return info.changes > 0;
  }

  /* ---------------------------------------------------------------------- *
   * Audience preview
   * ---------------------------------------------------------------------- */

  audienceCount(audience: BroadcastAudience): number {
    const where = audienceWhere(audience);
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE ${where.sql}`)
      .get(...where.args) as { n: number };
    return row.n;
  }

  audienceSample(
    audience: BroadcastAudience,
    limit: number,
  ): Array<{ id: number; telegram_user_id: string; username: string | null; first_name: string | null }> {
    const where = audienceWhere(audience);
    const sql = `SELECT id, telegram_user_id, username, first_name
                   FROM users
                   WHERE ${where.sql}
                   ORDER BY id ASC LIMIT ?`;
    return this.db.prepare(sql).all(...where.args, limit) as Array<{
      id: number;
      telegram_user_id: string;
      username: string | null;
      first_name: string | null;
    }>;
  }

  /* ---------------------------------------------------------------------- *
   * Status transitions
   * ---------------------------------------------------------------------- */

  /** Try to flip `id` from any of `from` to `to`. Returns the row on success,
   * `null` when the row was not in the expected status (concurrent flip,
   * already cancelled, etc). Used for every state transition that races. */
  tryTransition(id: number, from: BroadcastStatus[], to: BroadcastStatus): BroadcastRow | null {
    const placeholders = from.map(() => '?').join(',');
    const stamp = this.timestampColumnFor(to);
    const sets: string[] = ['status = ?', 'updated_at = ?'];
    const args: unknown[] = [to, nowIso()];
    if (stamp !== null) {
      sets.push(`${stamp} = ?`);
      args.push(nowIso());
    }
    const sql = `UPDATE broadcasts SET ${sets.join(', ')}
                   WHERE id = ? AND status IN (${placeholders}) RETURNING *`;
    const row = this.db
      .prepare(sql)
      .get(...args, id, ...from) as unknown as BroadcastRow | undefined;
    return row ?? null;
  }

  /** Pick a status-specific timestamp column to update during a transition. */
  private timestampColumnFor(status: BroadcastStatus): string | null {
    switch (status) {
      case 'sending':
        return 'started_at';
      case 'completed':
      case 'failed':
        return 'completed_at';
      case 'cancelled':
        return 'cancelled_at';
      default:
        return null;
    }
  }

  setScheduledAt(id: number, scheduledAt: string | null): BroadcastRow | null {
    const row = this.db
      .prepare(
        `UPDATE broadcasts SET scheduled_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('draft','scheduled') RETURNING *`,
      )
      .get(scheduledAt, nowIso(), id) as unknown as BroadcastRow | undefined;
    return row ?? null;
  }

  setAudienceCount(id: number, count: number): void {
    this.db
      .prepare(`UPDATE broadcasts SET audience_count = ?, count_pending = ? WHERE id = ?`)
      .run(count, count, id);
  }

  /* ---------------------------------------------------------------------- *
   * Recipient materialization
   * ---------------------------------------------------------------------- */

  /**
   * Snapshot the current audience into `broadcast_recipients`. Wrapped in a
   * single transaction so a crash mid-fan-out leaves no half-state. Idempotent
   * thanks to the UNIQUE(broadcast_id, user_id) — re-running is a no-op.
   *
   * Returns the number of recipient rows present after the call (whether
   * they were already there or freshly inserted). The service uses this to
   * set `audience_count` / `count_pending`.
   */
  materializeRecipients(broadcastId: number, audience: BroadcastAudience): number {
    const where = audienceWhere(audience);
    const insertSql = `
      INSERT OR IGNORE INTO broadcast_recipients
        (broadcast_id, user_id, telegram_user_id, status)
      SELECT ?, id, telegram_user_id, 'pending'
        FROM users WHERE ${where.sql}`;
    const countSql = `SELECT COUNT(*) AS n FROM broadcast_recipients WHERE broadcast_id = ?`;
    const tx = this.db.transaction((id: number, args: unknown[]) => {
      this.db.prepare(insertSql).run(id, ...args);
      const row = this.db.prepare(countSql).get(id) as { n: number };
      return row.n;
    });
    return tx(broadcastId, where.args);
  }

  /* ---------------------------------------------------------------------- *
   * Recipient claim + status updates
   * ---------------------------------------------------------------------- */

  /**
   * Atomically claim up to `n` pending recipients (whose `next_attempt_at`
   * is null or has passed) by flipping them to `sending`. Returns the
   * claimed rows. Single-process safe; multi-process safe within SQLite's
   * writer-lock guarantees.
   */
  claimPending(broadcastId: number, n: number): BroadcastRecipientRow[] {
    const tx = this.db.transaction((): BroadcastRecipientRow[] => {
      const rows = this.db
        .prepare(
          `SELECT * FROM broadcast_recipients
             WHERE broadcast_id = ? AND status = 'pending'
               AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
             ORDER BY id ASC LIMIT ?`,
        )
        .all(broadcastId, nowIso(), n) as unknown as BroadcastRecipientRow[];
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');
      this.db
        .prepare(
          `UPDATE broadcast_recipients SET status = 'sending'
             WHERE id IN (${placeholders}) AND status = 'pending'`,
        )
        .run(...ids);
      // Return the rows reflecting the new status — caller dispatches off them.
      return rows.map((r) => ({ ...r, status: 'sending' as const }));
    });
    return tx();
  }

  /** Mark a recipient as successfully delivered. */
  markSent(id: number, messageId: number | null): void {
    this.db
      .prepare(
        `UPDATE broadcast_recipients
           SET status='sent', sent_at=?, message_id=?, error_code=NULL, error_message=NULL
           WHERE id=?`,
      )
      .run(nowIso(), messageId, id);
  }

  /** Mark a recipient as terminally blocked (403/400 unreachable). */
  markBlocked(id: number, errorMessage: string): void {
    this.db
      .prepare(
        `UPDATE broadcast_recipients
           SET status='blocked', failed_at=?, error_code='blocked', error_message=?
           WHERE id=?`,
      )
      .run(nowIso(), errorMessage, id);
  }

  /** Mark a recipient as terminally failed after retries are exhausted. */
  markFailed(id: number, errorCode: string, errorMessage: string): void {
    this.db
      .prepare(
        `UPDATE broadcast_recipients
           SET status='failed', failed_at=?, error_code=?, error_message=?
           WHERE id=?`,
      )
      .run(nowIso(), errorCode, errorMessage, id);
  }

  /**
   * Bounce back to `pending` for a future tick. `next_attempt_at` is the
   * wall-clock time after which the worker may try again (used for 429
   * retry_after + 5xx exponential backoff).
   */
  rescheduleForRetry(id: number, nextAttemptAt: string, errorMessage: string): void {
    this.db
      .prepare(
        `UPDATE broadcast_recipients
           SET status='pending',
               next_attempt_at=?,
               retry_count=retry_count+1,
               error_message=?
           WHERE id=?`,
      )
      .run(nextAttemptAt, errorMessage, id);
  }

  /** Cancel every still-pending recipient (used by the cancel route). */
  cancelPending(broadcastId: number): number {
    const info = this.db
      .prepare(
        `UPDATE broadcast_recipients SET status='cancelled', failed_at=?
           WHERE broadcast_id=? AND status IN ('pending','sending')`,
      )
      .run(nowIso(), broadcastId);
    return info.changes;
  }

  /* ---------------------------------------------------------------------- *
   * Counts + recipient listing
   * ---------------------------------------------------------------------- */

  /** Recompute and write the four denormalized counters from authority rows. */
  recomputeCounts(broadcastId: number): {
    sent: number;
    failed: number;
    blocked: number;
    pending: number;
  } {
    const rows = this.db
      .prepare(
        `SELECT status, COUNT(*) AS n FROM broadcast_recipients
           WHERE broadcast_id = ? GROUP BY status`,
      )
      .all(broadcastId) as Array<{ status: BroadcastRecipientStatus; n: number }>;
    const totals = { sent: 0, failed: 0, blocked: 0, pending: 0, sending: 0, cancelled: 0 };
    for (const r of rows) {
      totals[r.status] = r.n;
    }
    // While the worker is mid-batch some rows are momentarily 'sending' — fold
    // those into pending so the UI doesn't flicker between counts.
    const pending = totals.pending + totals.sending;
    this.db
      .prepare(
        `UPDATE broadcasts
           SET count_sent=?, count_failed=?, count_blocked=?, count_pending=?, updated_at=?
           WHERE id=?`,
      )
      .run(totals.sent, totals.failed, totals.blocked, pending, nowIso(), broadcastId);
    return { sent: totals.sent, failed: totals.failed, blocked: totals.blocked, pending };
  }

  /** True when no recipients remain in a non-terminal state. */
  isCompleted(broadcastId: number): boolean {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM broadcast_recipients
           WHERE broadcast_id = ? AND status IN ('pending','sending')`,
      )
      .get(broadcastId) as { n: number };
    return row.n === 0;
  }

  listRecipients(opts: {
    broadcast_id: number;
    status?: BroadcastRecipientStatus | null;
    limit: number;
    offset: number;
  }): BroadcastRecipientRow[] {
    const clauses: string[] = ['broadcast_id = ?'];
    const args: unknown[] = [opts.broadcast_id];
    if (opts.status !== null && opts.status !== undefined) {
      clauses.push('status = ?');
      args.push(opts.status);
    }
    const sql = `SELECT * FROM broadcast_recipients WHERE ${clauses.join(' AND ')}
                   ORDER BY id ASC LIMIT ? OFFSET ?`;
    return this.db
      .prepare(sql)
      .all(...args, opts.limit, opts.offset) as unknown as BroadcastRecipientRow[];
  }

  countRecipients(opts: {
    broadcast_id: number;
    status?: BroadcastRecipientStatus | null;
  }): number {
    const clauses: string[] = ['broadcast_id = ?'];
    const args: unknown[] = [opts.broadcast_id];
    if (opts.status !== null && opts.status !== undefined) {
      clauses.push('status = ?');
      args.push(opts.status);
    }
    const sql = `SELECT COUNT(*) AS n FROM broadcast_recipients WHERE ${clauses.join(' AND ')}`;
    const row = this.db.prepare(sql).get(...args) as { n: number };
    return row.n;
  }

  /* ---------------------------------------------------------------------- *
   * Worker queries
   * ---------------------------------------------------------------------- */

  /** Broadcasts the worker should pick up on this tick. */
  listSending(): BroadcastRow[] {
    return this.db
      .prepare("SELECT * FROM broadcasts WHERE status = 'sending' ORDER BY id ASC")
      .all() as unknown as BroadcastRow[];
  }

  /** Scheduled broadcasts whose time has come. */
  listDueScheduled(now: string): BroadcastRow[] {
    return this.db
      .prepare(
        `SELECT * FROM broadcasts WHERE status = 'scheduled'
           AND scheduled_at IS NOT NULL AND scheduled_at <= ?
           ORDER BY scheduled_at ASC, id ASC`,
      )
      .all(now) as unknown as BroadcastRow[];
  }
}
