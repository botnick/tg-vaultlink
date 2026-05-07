/**
 * Credit repository — atomic balance + ledger writes.
 *
 * The `users.credits` column is the cached current balance; the
 * `credit_transactions` table is the immutable source of truth (history
 * view, refund correctness, audit). Every state change goes through
 * {@link applyDelta} which:
 *
 *   1. Re-reads `users.credits` inside a transaction.
 *   2. Computes `newBalance = oldBalance + delta`.
 *   3. Refuses negatives (throws `INSUFFICIENT_CREDITS`).
 *   4. Updates the row + appends one ledger entry in a single
 *      `db.transaction()` call so a crash mid-write cannot leave the
 *      cached balance out of sync with the ledger.
 *
 * better-sqlite3 transactions are synchronous and serialize through the
 * writer lock; combined with the per-user `sequentialize()` middleware on
 * the runner, concurrent debits for the same user are race-free.
 */

import type { Db } from '../db/database.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type { CreditReason, CreditTransactionRow } from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

/** Input for {@link CreditRepository.applyDelta}. */
export interface ApplyDeltaInput {
  userId: number;
  /** Signed delta — positive for grants/refunds, negative for spends. */
  delta: number;
  reason: CreditReason;
  /** Optional loose foreign key (entity type — e.g. `'file'`, `'collection'`). */
  referenceType?: string | null;
  /** Optional loose foreign key (entity id, stored as text). */
  referenceId?: string | null;
  /** Optional structured metadata, JSON-stringified before insert. */
  metadata?: Record<string, unknown> | null;
}

export interface ApplyDeltaResult {
  /** Balance AFTER the delta was applied. */
  balanceAfter: number;
  /** Inserted ledger row (handy for tests / audit logging). */
  transaction: CreditTransactionRow;
}

export class CreditRepository {
  private readonly readBalanceStmt;
  private readonly updateBalanceStmt;
  private readonly insertTxStmt;
  private readonly listByUserStmt;
  private readonly countByUserStmt;
  private readonly listByUserBeforeStmt;
  private readonly sumByUserAndReasonStmt;
  private readonly sumByReasonSinceStmt;
  private readonly totalsStmt;
  private readonly findTopupByChargeStmt;
  private readonly existsRefundForChargeStmt;
  private readonly aggregateByReasonStmt;
  private readonly aggregateByReasonSinceStmt;
  private readonly topupTimeseriesStmt;

  constructor(private readonly db: Db) {
    this.readBalanceStmt = db.prepare('SELECT credits FROM users WHERE id = ?');

    this.updateBalanceStmt = db.prepare(
      `UPDATE users SET credits = @credits, updated_at = @now WHERE id = @id`,
    );

    this.insertTxStmt = db.prepare(
      `INSERT INTO credit_transactions (
         user_id, delta, reason, balance_after,
         reference_type, reference_id, metadata_json, created_at
       ) VALUES (
         @user_id, @delta, @reason, @balance_after,
         @reference_type, @reference_id, @metadata_json, @now
       )
       RETURNING *`,
    );

    this.listByUserStmt = db.prepare(
      `SELECT * FROM credit_transactions
         WHERE user_id = ?
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
    );

    this.listByUserBeforeStmt = db.prepare(
      `SELECT * FROM credit_transactions
         WHERE user_id = ? AND id < ?
         ORDER BY id DESC
         LIMIT ?`,
    );

    this.countByUserStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM credit_transactions WHERE user_id = ?`,
    );

    this.sumByUserAndReasonStmt = db.prepare(
      `SELECT COALESCE(SUM(delta), 0) AS s
         FROM credit_transactions
        WHERE user_id = ? AND reason = ? AND created_at >= ?`,
    );

    this.sumByReasonSinceStmt = db.prepare(
      `SELECT COALESCE(SUM(delta), 0) AS s
         FROM credit_transactions
        WHERE reason = ? AND created_at >= ?`,
    );

    this.totalsStmt = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN delta > 0 THEN delta ELSE 0 END), 0) AS gained,
         COALESCE(SUM(CASE WHEN delta < 0 THEN -delta ELSE 0 END), 0) AS spent
         FROM credit_transactions
         WHERE user_id = ?`,
    );

    // Wave 9.2 — find the original `topup` ledger row by Telegram payment
    // charge id (the value lives in `reference_id`). Used by the refund
    // pathway to decide what credits to claw back.
    this.findTopupByChargeStmt = db.prepare(
      `SELECT * FROM credit_transactions
         WHERE reason = 'topup' AND reference_id = ?
         ORDER BY id DESC LIMIT 1`,
    );

    // Wave 9.2 — has this charge already been refunded? Defends against
    // duplicate refund events (Telegram could conceivably retry; admin
    // could trigger refundStarPayment on an already-refunded charge).
    this.existsRefundForChargeStmt = db.prepare(
      `SELECT 1 AS hit FROM credit_transactions
         WHERE reason = 'topup_refund' AND reference_id = ?
         LIMIT 1`,
    );

    // Wave 9.2 — admin dashboard aggregates. Lifetime total per reason
    // (signed sum so 'spend_*' rows are negative, 'topup' positive — the
    // dashboard splits those visually).
    this.aggregateByReasonStmt = db.prepare(
      `SELECT
         COALESCE(SUM(delta), 0)        AS total,
         COALESCE(COUNT(*), 0)          AS count
         FROM credit_transactions
         WHERE reason = ?`,
    );

    // Same as above but bounded to a since-timestamp (24h, 7d windows).
    this.aggregateByReasonSinceStmt = db.prepare(
      `SELECT
         COALESCE(SUM(delta), 0)        AS total,
         COALESCE(COUNT(*), 0)          AS count
         FROM credit_transactions
         WHERE reason = ?
           AND created_at >= ?`,
    );

    // 7-day topup timeseries — buckets by UTC date. Returns at most 7 rows
    // (rows with zero topups simply don't appear; the API layer fills
    // gaps so the chart shape is stable).
    this.topupTimeseriesStmt = db.prepare(
      `SELECT
         substr(created_at, 1, 10) AS day,
         COALESCE(SUM(delta), 0)   AS credits,
         COALESCE(COUNT(*), 0)     AS count
         FROM credit_transactions
         WHERE reason = ? AND created_at >= ?
         GROUP BY day
         ORDER BY day ASC`,
    );
  }

  /** Read the cached balance straight from `users.credits`. */
  getBalance(userId: number): number {
    const row = this.readBalanceStmt.get(userId) as { credits: number } | undefined;
    return row?.credits ?? 0;
  }

  /**
   * Apply a signed delta atomically. Throws `INSUFFICIENT_CREDITS` if the
   * delta would drive the balance below zero — the caller is expected to
   * surface that as a friendly error to the user (and offer a topup
   * button when topup is enabled).
   */
  applyDelta(input: ApplyDeltaInput): ApplyDeltaResult {
    if (!Number.isFinite(input.delta) || !Number.isInteger(input.delta)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'credit delta must be an integer', {
        meta: { delta: input.delta },
      });
    }

    const apply = this.db.transaction((): ApplyDeltaResult => {
      const oldRow = this.readBalanceStmt.get(input.userId) as { credits: number } | undefined;
      if (!oldRow) {
        throw new AppError(ErrorCode.USER_NOT_FOUND, `User ${input.userId} not found`, {
          meta: { userId: input.userId },
        });
      }
      const balanceAfter = oldRow.credits + input.delta;
      if (balanceAfter < 0) {
        throw new AppError(
          ErrorCode.INSUFFICIENT_CREDITS,
          `User ${input.userId} has insufficient credits (have ${oldRow.credits}, need ${-input.delta})`,
          { meta: { userId: input.userId, balance: oldRow.credits, delta: input.delta } },
        );
      }

      const now = nowIso();
      this.updateBalanceStmt.run({ id: input.userId, credits: balanceAfter, now });

      const tx = this.insertTxStmt.get({
        user_id: input.userId,
        delta: input.delta,
        reason: input.reason,
        balance_after: balanceAfter,
        reference_type: input.referenceType ?? null,
        reference_id: input.referenceId ?? null,
        metadata_json:
          input.metadata === null || input.metadata === undefined
            ? null
            : JSON.stringify(input.metadata),
        now,
      }) as unknown as CreditTransactionRow;

      return { balanceAfter, transaction: tx };
    });

    return apply();
  }

  /**
   * Direct ledger insert WITHOUT touching `users.credits`. Used only by
   * service-level paths that have already done their own balance
   * accounting (e.g. an admin "set absolute balance" flow that needs
   * an audit trail entry alongside a discrete UPDATE). Most callers
   * should use {@link applyDelta}.
   */
  insertTransactionRaw(input: {
    userId: number;
    delta: number;
    reason: CreditReason;
    balanceAfter: number;
    referenceType?: string | null;
    referenceId?: string | null;
    metadata?: Record<string, unknown> | null;
  }): CreditTransactionRow {
    return this.insertTxStmt.get({
      user_id: input.userId,
      delta: input.delta,
      reason: input.reason,
      balance_after: input.balanceAfter,
      reference_type: input.referenceType ?? null,
      reference_id: input.referenceId ?? null,
      metadata_json:
        input.metadata === null || input.metadata === undefined
          ? null
          : JSON.stringify(input.metadata),
      now: nowIso(),
    }) as unknown as CreditTransactionRow;
  }

  /**
   * Set the user's balance to an absolute value (admin "set" flow). Runs in
   * a single transaction with an `admin_set` ledger row so the absolute
   * change is visible in history and audit. Returns the delta that was
   * applied.
   */
  setAbsoluteBalance(input: {
    userId: number;
    targetBalance: number;
    actorUserId: number;
    note?: string;
  }): { delta: number; transaction: CreditTransactionRow } {
    if (!Number.isFinite(input.targetBalance) || !Number.isInteger(input.targetBalance)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'target balance must be an integer', {
        meta: { target: input.targetBalance },
      });
    }
    if (input.targetBalance < 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'target balance must be >= 0', {
        meta: { target: input.targetBalance },
      });
    }

    const apply = this.db.transaction(() => {
      const oldRow = this.readBalanceStmt.get(input.userId) as { credits: number } | undefined;
      if (!oldRow) {
        throw new AppError(ErrorCode.USER_NOT_FOUND, `User ${input.userId} not found`, {
          meta: { userId: input.userId },
        });
      }
      const delta = input.targetBalance - oldRow.credits;
      const now = nowIso();
      this.updateBalanceStmt.run({ id: input.userId, credits: input.targetBalance, now });

      const tx = this.insertTxStmt.get({
        user_id: input.userId,
        delta,
        reason: 'admin_set' as CreditReason,
        balance_after: input.targetBalance,
        reference_type: 'user',
        reference_id: String(input.actorUserId),
        metadata_json: JSON.stringify({
          actorUserId: input.actorUserId,
          oldBalance: oldRow.credits,
          newBalance: input.targetBalance,
          note: input.note ?? null,
        }),
        now,
      }) as unknown as CreditTransactionRow;

      return { delta, transaction: tx };
    });

    return apply();
  }

  /** Recent ledger entries for a user, newest first. */
  listByUser(userId: number, limit: number, offset: number): CreditTransactionRow[] {
    return this.listByUserStmt.all(userId, limit, offset) as unknown as CreditTransactionRow[];
  }

  /** Cursor-style pagination — entries older than `beforeId`. */
  listByUserBefore(userId: number, beforeId: number, limit: number): CreditTransactionRow[] {
    return this.listByUserBeforeStmt.all(
      userId,
      beforeId,
      limit,
    ) as unknown as CreditTransactionRow[];
  }

  countByUser(userId: number): number {
    const row = this.countByUserStmt.get(userId) as { n: number };
    return row.n;
  }

  /**
   * Sum the deltas for a single (user, reason) combination since
   * `sinceIso`. Used by the daily referral-reward cap: pass today's
   * UTC midnight to count today's earnings.
   */
  sumByUserAndReasonSince(userId: number, reason: CreditReason, sinceIso: string): number {
    const row = this.sumByUserAndReasonStmt.get(userId, reason, sinceIso) as { s: number };
    return row.s;
  }

  /**
   * Count `referral_reward` ledger rows where the (creator, redeemer)
   * pair matches and the entry was written on or after `sinceIso`.
   *
   * Uses SQLite's built-in JSON1 to inspect `metadata_json`, which we
   * stamp with `redeemerUserId` inside `CreditService.rewardReferral`.
   * Pass `'1970-01-01T00:00:00.000Z'` as `sinceIso` for a lifetime count.
   *
   * Powering the anti-farming defense: a single (A, B) pair can only
   * earn so many rewards within a window, regardless of how many codes
   * A creates.
   */
  countReferralRewardsForPair(creatorUserId: number, redeemerUserId: number, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM credit_transactions
           WHERE user_id = ?
             AND reason = 'referral_reward'
             AND created_at >= ?
             AND CAST(json_extract(metadata_json, '$.redeemerUserId') AS INTEGER) = ?`,
      )
      .get(creatorUserId, sinceIso, redeemerUserId) as { n: number };
    return row.n;
  }

  /** Aggregate spent / gained per user (for the Mini App "lifetime" stats). */
  totals(userId: number): { gained: number; spent: number } {
    const row = this.totalsStmt.get(userId) as { gained: number; spent: number };
    return row;
  }

  /** Ops summary — aggregate across the whole bot. */
  globalTotalsByReason(reason: CreditReason, sinceIso: string): number {
    const row = this.sumByReasonSinceStmt.get(reason, sinceIso) as { s: number };
    return row.s;
  }

  /* ------------------------------------------------- Wave 9.2 helpers --- */

  /**
   * Apply a signed delta atomically WITHOUT the overdraft check. Used only
   * by the Stars refund clawback pathway (`CreditService.refundTopup`)
   * where allowing the cached balance to go negative is the intended
   * defense — abusers who already spent their credits end up locked out
   * via `applyDelta`'s overdraft rejection on subsequent spends. NEVER
   * use this for ordinary spends.
   */
  applyDeltaUnchecked(input: ApplyDeltaInput): ApplyDeltaResult {
    if (!Number.isFinite(input.delta) || !Number.isInteger(input.delta)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'credit delta must be an integer', {
        meta: { delta: input.delta },
      });
    }

    const apply = this.db.transaction((): ApplyDeltaResult => {
      const oldRow = this.readBalanceStmt.get(input.userId) as { credits: number } | undefined;
      if (!oldRow) {
        throw new AppError(ErrorCode.USER_NOT_FOUND, `User ${input.userId} not found`, {
          meta: { userId: input.userId },
        });
      }
      const balanceAfter = oldRow.credits + input.delta;
      // No overdraft check on purpose — see method docstring.

      const now = nowIso();
      this.updateBalanceStmt.run({ id: input.userId, credits: balanceAfter, now });

      const tx = this.insertTxStmt.get({
        user_id: input.userId,
        delta: input.delta,
        reason: input.reason,
        balance_after: balanceAfter,
        reference_type: input.referenceType ?? null,
        reference_id: input.referenceId ?? null,
        metadata_json:
          input.metadata === null || input.metadata === undefined
            ? null
            : JSON.stringify(input.metadata),
        now,
      }) as unknown as CreditTransactionRow;

      return { balanceAfter, transaction: tx };
    });

    return apply();
  }

  /** Find the original `topup` ledger row whose `reference_id` is the given Telegram payment charge id. */
  findTopupByPaymentChargeId(paymentChargeId: string): CreditTransactionRow | undefined {
    return this.findTopupByChargeStmt.get(paymentChargeId) as unknown as
      | CreditTransactionRow
      | undefined;
  }

  /** Has this Telegram payment charge id already produced a `topup_refund` ledger row? */
  existsRefundForPaymentCharge(paymentChargeId: string): boolean {
    const row = this.existsRefundForChargeStmt.get(paymentChargeId) as { hit?: number } | undefined;
    return row?.hit === 1;
  }

  /**
   * Count ledger rows for a (user, reason) pair created on/after `sinceIso`.
   * Powers the repeat-offender check: `count('topup_refund', last 30 days)`.
   */
  countByUserAndReasonSince(userId: number, reason: CreditReason, sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM credit_transactions
           WHERE user_id = ? AND reason = ? AND created_at >= ?`,
      )
      .get(userId, reason, sinceIso) as { n: number };
    return row.n;
  }

  /**
   * Lifetime aggregate for one reason. Handy for the admin dashboard.
   * Total is signed (positive for grants, negative for spends).
   */
  aggregateByReason(reason: CreditReason): { total: number; count: number } {
    const row = this.aggregateByReasonStmt.get(reason) as { total: number; count: number };
    return { total: row.total, count: row.count };
  }

  /** Same as {@link aggregateByReason} but only counting rows on/after `sinceIso`. */
  aggregateByReasonSince(
    reason: CreditReason,
    sinceIso: string,
  ): { total: number; count: number } {
    const row = this.aggregateByReasonSinceStmt.get(reason, sinceIso) as {
      total: number;
      count: number;
    };
    return { total: row.total, count: row.count };
  }

  /**
   * Last-7-days topup activity bucketed by UTC date. Buckets are returned
   * sparsely; the API layer fills missing days with `{ credits: 0, count: 0 }`
   * so the chart always shows a stable 7-bar shape.
   */
  topupTimeseriesSince(
    reason: CreditReason,
    sinceIso: string,
  ): ReadonlyArray<{ day: string; credits: number; count: number }> {
    return this.topupTimeseriesStmt.all(reason, sinceIso) as unknown as ReadonlyArray<{
      day: string;
      credits: number;
      count: number;
    }>;
  }
}
