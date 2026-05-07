/**
 * CryptoInvoice repository.
 *
 * Persistence layer for self-custodial crypto top-ups. The load-bearing
 * guarantee here is the `(chain, tx_hash) UNIQUE` index on the table:
 * `attachTxHash` will throw on duplicate, so the same on-chain transaction
 * can never credit two different invoices — even under a worker race.
 *
 * `markApplied` runs inside a `db.transaction()` together with the
 * confirmation-count update so the row's `status='confirmed'` and
 * `ledger_tx_id` land atomically with the credit grant in
 * `CreditService.applyTopup`.
 */

import type { Db } from '../db/database.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type {
  CryptoChainId,
  CryptoInvoiceRow,
  CryptoInvoiceStatus,
} from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

export interface CreateInvoiceInput {
  userId: number;
  chain: CryptoChainId;
  amountUnit: string;
  amountDecimals: number;
  amountLabel: string;
  creditsToGrant: number;
  payToAddress: string;
  memo: string | null;
  /** Wave 9.2 — server-built BIP-21 / ton:// URI; null when chain has no scheme. */
  paymentUri?: string | null;
  requiredConfirmations: number;
  expiresAt: string;
  metadata?: Record<string, unknown> | null;
}

export class CryptoInvoiceRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly findByMemoStmt;
  private readonly findByChainTxStmt;
  private readonly findActiveByAmountStmt;
  private readonly findRecentByUserStmt;
  private readonly listPendingForPollStmt;
  private readonly attachTxHashStmt;
  private readonly updateConfirmationsStmt;
  private readonly setStatusStmt;
  private readonly setExpiredStmt;
  private readonly markAppliedStmt;
  private readonly setFailureStmt;

  constructor(private readonly db: Db) {
    this.insertStmt = db.prepare(
      `INSERT INTO crypto_invoices (
         user_id, chain, status, amount_unit, amount_decimals, amount_label,
         credits_to_grant, pay_to_address, memo, payment_uri,
         required_confirmations, expires_at, metadata_json, created_at, updated_at
       ) VALUES (
         @user_id, @chain, 'pending', @amount_unit, @amount_decimals, @amount_label,
         @credits_to_grant, @pay_to_address, @memo, @payment_uri,
         @required_confirmations, @expires_at, @metadata_json, @now, @now
       )
       RETURNING *`,
    );

    this.findByIdStmt = db.prepare('SELECT * FROM crypto_invoices WHERE id = ?');

    this.findByMemoStmt = db.prepare(
      'SELECT * FROM crypto_invoices WHERE chain = ? AND memo = ? AND status IN (\'pending\',\'submitted\',\'confirming\') ORDER BY id DESC LIMIT 1',
    );

    this.findByChainTxStmt = db.prepare(
      'SELECT * FROM crypto_invoices WHERE chain = ? AND tx_hash = ?',
    );

    // Auto-detect support: when a chain has no memo (TRON-USDT), the
    // service generates a unique micro-suffix on the amount so two users
    // paying the same nominal amount can still be told apart by the
    // worker's address scanner. This lookup lets createInvoice retry on
    // the rare collision with another active invoice in the same window.
    this.findActiveByAmountStmt = db.prepare(
      `SELECT * FROM crypto_invoices
        WHERE chain = ?
          AND amount_unit = ?
          AND status IN ('pending','submitted','confirming')
        ORDER BY id DESC
        LIMIT 1`,
    );

    this.findRecentByUserStmt = db.prepare(
      'SELECT * FROM crypto_invoices WHERE user_id = ? ORDER BY id DESC LIMIT ?',
    );

    this.listPendingForPollStmt = db.prepare(
      `SELECT * FROM crypto_invoices
         WHERE status IN ('pending', 'submitted', 'confirming')
           AND (last_polled_at IS NULL OR last_polled_at < @cutoff)
         ORDER BY last_polled_at ASC NULLS FIRST, id ASC
         LIMIT @limit`,
    );

    this.attachTxHashStmt = db.prepare(
      `UPDATE crypto_invoices
          SET tx_hash = @tx_hash,
              from_address = @from_address,
              status = 'submitted',
              paid_at = @now,
              updated_at = @now
        WHERE id = @id
          AND tx_hash IS NULL
          AND status = 'pending'
        RETURNING *`,
    );

    // Wave 9.3 — status flip: ONLY 'submitted' → 'confirming'. The previous
    // version dragged 'pending' → 'confirming' on every poll, which made
    // legitimate-pending invoices show "Payment detected, confirming" in
    // the UI even when no transfer had been seen. Now pending stays
    // pending until a tx is actually attached. Money safety: this is what
    // the user-visible status reads off.
    this.updateConfirmationsStmt = db.prepare(
      `UPDATE crypto_invoices
          SET confirmations = @confirmations,
              status = CASE
                WHEN status = 'submitted' THEN 'confirming'
                ELSE status
              END,
              last_polled_at = @now,
              poll_count = poll_count + 1,
              updated_at = @now
        WHERE id = @id
        RETURNING *`,
    );

    this.setStatusStmt = db.prepare(
      `UPDATE crypto_invoices
          SET status = @status,
              last_polled_at = @now,
              poll_count = poll_count + 1,
              updated_at = @now
        WHERE id = @id
        RETURNING *`,
    );

    this.setExpiredStmt = db.prepare(
      `UPDATE crypto_invoices
          SET status = 'expired',
              updated_at = @now
        WHERE id = @id
          AND status = 'pending'
          AND tx_hash IS NULL
        RETURNING *`,
    );

    this.markAppliedStmt = db.prepare(
      `UPDATE crypto_invoices
          SET status = 'confirmed',
              applied_at = @now,
              ledger_tx_id = @ledger_tx_id,
              confirmations = @confirmations,
              updated_at = @now
        WHERE id = @id
          AND status IN ('submitted', 'confirming')
          AND applied_at IS NULL
        RETURNING *`,
    );

    this.setFailureStmt = db.prepare(
      `UPDATE crypto_invoices
          SET status = 'failed',
              failure_reason = @reason,
              updated_at = @now
        WHERE id = @id
        RETURNING *`,
    );
  }

  insert(input: CreateInvoiceInput): CryptoInvoiceRow {
    const row = this.insertStmt.get({
      user_id: input.userId,
      chain: input.chain,
      amount_unit: input.amountUnit,
      amount_decimals: input.amountDecimals,
      amount_label: input.amountLabel,
      credits_to_grant: input.creditsToGrant,
      pay_to_address: input.payToAddress,
      memo: input.memo,
      payment_uri: input.paymentUri ?? null,
      required_confirmations: input.requiredConfirmations,
      expires_at: input.expiresAt,
      metadata_json:
        input.metadata === undefined || input.metadata === null
          ? null
          : JSON.stringify(input.metadata),
      now: nowIso(),
    }) as unknown as CryptoInvoiceRow | undefined;
    if (!row) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'crypto invoice insert returned no row');
    }
    return row;
  }

  /* ----------------------------------------- admin-dashboard aggregates --- */

  /** Counts grouped by `(chain, status)` for the operator dashboard. */
  groupedCounts(): ReadonlyArray<{ chain: string; status: string; n: number }> {
    return this.db
      .prepare(
        `SELECT chain, status, COUNT(*) AS n
           FROM crypto_invoices
          GROUP BY chain, status
          ORDER BY chain ASC, status ASC`,
      )
      .all() as unknown as ReadonlyArray<{ chain: string; status: string; n: number }>;
  }

  /** Sum of `credits_to_grant` across `confirmed` rows since `sinceIso`. */
  sumConfirmedCreditsSince(sinceIso: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(credits_to_grant), 0) AS s
           FROM crypto_invoices
          WHERE status = 'confirmed' AND applied_at IS NOT NULL AND applied_at >= ?`,
      )
      .get(sinceIso) as { s: number };
    return row.s;
  }

  /** Counts the rows currently waiting for the worker to action them. */
  countPending(): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM crypto_invoices
           WHERE status IN ('pending','submitted','confirming')`,
      )
      .get() as { n: number };
    return row.n;
  }

  /** Counts rows whose status is one of the given values. */
  countByStatuses(statuses: readonly string[]): number {
    if (statuses.length === 0) return 0;
    const placeholders = statuses.map(() => '?').join(',');
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM crypto_invoices WHERE status IN (${placeholders})`)
      .get(...statuses) as { n: number };
    return row.n;
  }

  /**
   * Wave 9.3 — count active invoices owned by `userId`. The service uses
   * this to enforce a per-user concurrent-invoice cap, mitigating
   * enumeration / DoS where a malicious client opens hundreds of pending
   * invoices to exhaust unique-amount space or RPC quota.
   */
  countActiveByUser(userId: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM crypto_invoices
           WHERE user_id = ?
             AND status IN ('pending','submitted','confirming')`,
      )
      .get(userId) as { n: number };
    return row.n;
  }

  findById(id: number): CryptoInvoiceRow | undefined {
    return this.findByIdStmt.get(id) as unknown as CryptoInvoiceRow | undefined;
  }

  findActiveByMemo(chain: CryptoChainId, memo: string): CryptoInvoiceRow | undefined {
    return this.findByMemoStmt.get(chain, memo) as unknown as CryptoInvoiceRow | undefined;
  }

  findByChainAndTxHash(chain: CryptoChainId, txHash: string): CryptoInvoiceRow | undefined {
    return this.findByChainTxStmt.get(chain, txHash) as unknown as CryptoInvoiceRow | undefined;
  }

  /**
   * Find any pending/submitted/confirming invoice on `chain` whose
   * `amount_unit` exactly equals `amountUnit`. Used by the unique-amount
   * generator to detect collisions before insert.
   */
  findActiveByChainAndAmount(
    chain: CryptoChainId,
    amountUnit: string,
  ): CryptoInvoiceRow | undefined {
    return this.findActiveByAmountStmt.get(chain, amountUnit) as unknown as
      | CryptoInvoiceRow
      | undefined;
  }

  listRecentByUser(userId: number, limit: number): CryptoInvoiceRow[] {
    return this.findRecentByUserStmt.all(userId, limit) as unknown as CryptoInvoiceRow[];
  }

  /**
   * Returns invoices that the worker should examine on this tick.
   * `cutoffIso` should be `now - poll_interval` so a row poked moments
   * ago is skipped until the next interval.
   */
  listPendingForPoll(cutoffIso: string, limit: number): CryptoInvoiceRow[] {
    return this.listPendingForPollStmt.all({
      cutoff: cutoffIso,
      limit,
    }) as unknown as CryptoInvoiceRow[];
  }

  /**
   * Atomically claim a tx_hash for a pending invoice. Throws
   * `CRYPTO_TX_DUPLICATE` if another invoice on the same chain already
   * holds this hash (the UNIQUE index guarantees this), or
   * `CRYPTO_INVOICE_NOT_FOUND` if the invoice is no longer pending.
   */
  attachTxHash(input: {
    id: number;
    txHash: string;
    fromAddress: string | null;
  }): CryptoInvoiceRow {
    let row: CryptoInvoiceRow | undefined;
    try {
      row = this.attachTxHashStmt.get({
        id: input.id,
        tx_hash: input.txHash,
        from_address: input.fromAddress,
        now: nowIso(),
      }) as unknown as CryptoInvoiceRow | undefined;
    } catch (err) {
      const message = (err as { message?: string }).message ?? '';
      if (message.includes('UNIQUE') || message.includes('constraint')) {
        throw new AppError(
          ErrorCode.CRYPTO_TX_DUPLICATE,
          `tx ${input.txHash} is already attached to another invoice`,
          { meta: { txHash: input.txHash } },
        );
      }
      throw err;
    }
    if (!row) {
      throw new AppError(
        ErrorCode.CRYPTO_INVOICE_NOT_FOUND,
        `invoice ${input.id} is not in pending state`,
        { meta: { id: input.id } },
      );
    }
    return row;
  }

  updateConfirmations(id: number, confirmations: number): CryptoInvoiceRow | undefined {
    return this.updateConfirmationsStmt.get({
      id,
      confirmations,
      now: nowIso(),
    }) as unknown as CryptoInvoiceRow | undefined;
  }

  setStatus(id: number, status: CryptoInvoiceStatus): CryptoInvoiceRow | undefined {
    return this.setStatusStmt.get({
      id,
      status,
      now: nowIso(),
    }) as unknown as CryptoInvoiceRow | undefined;
  }

  /** Mark a pending-no-payment invoice as expired. No-op if it has a tx. */
  expireIfStale(id: number): CryptoInvoiceRow | undefined {
    return this.setExpiredStmt.get({
      id,
      now: nowIso(),
    }) as unknown as CryptoInvoiceRow | undefined;
  }

  /**
   * Wave 9.3 — let the user cancel their own non-terminal invoice. Allowed
   * states are pending / submitted / confirming. The pre-9.3 worker could
   * mis-attribute a stranger's transfer to a legacy invoice that had a plain
   * (non-unique) amount, leaving it stuck in 'submitted'/'confirming'
   * forever; users need a way to clear those out.
   *
   * Idempotency is preserved by keeping the `tx_hash` sticky after cancel —
   * the (chain, tx_hash) UNIQUE index will still reject any future
   * re-discovery, so the on-chain transfer is "burned" rather than
   * re-attributed elsewhere. If the user genuinely paid an invoice they
   * later cancelled, admin recovery (`adminAttachHash` / `forceApplyInvoice`)
   * is required — better than silently re-crediting a stranger.
   */
  cancelByUser(input: { id: number; userId: number }): CryptoInvoiceRow | undefined {
    return this.db
      .prepare(
        `UPDATE crypto_invoices
            SET status = 'expired',
                failure_reason = 'user_cancelled',
                updated_at = @now
          WHERE id = @id
            AND user_id = @user_id
            AND status IN ('pending', 'submitted', 'confirming')
            AND applied_at IS NULL
          RETURNING *`,
      )
      .get({
        id: input.id,
        user_id: input.userId,
        now: nowIso(),
      }) as unknown as CryptoInvoiceRow | undefined;
  }

  /**
   * Record that the credit grant succeeded. Caller has already inserted the
   * `credit_transactions` row via `CreditService.applyTopup` and passes
   * its id here. The CASE in the UPDATE means re-running this is a no-op.
   */
  markApplied(input: {
    id: number;
    ledgerTxId: number;
    confirmations: number;
  }): CryptoInvoiceRow | undefined {
    return this.markAppliedStmt.get({
      id: input.id,
      ledger_tx_id: input.ledgerTxId,
      confirmations: input.confirmations,
      now: nowIso(),
    }) as unknown as CryptoInvoiceRow | undefined;
  }

  setFailure(id: number, reason: string): CryptoInvoiceRow | undefined {
    return this.setFailureStmt.get({
      id,
      reason,
      now: nowIso(),
    }) as unknown as CryptoInvoiceRow | undefined;
  }

  /**
   * Push the expires_at deadline forward and (optionally) revive an
   * already-expired invoice back to 'pending'. Used by the admin "extend"
   * flow when a user paid past the original deadline.
   */
  extendExpiry(input: { id: number; expiresAt: string; revive?: boolean }): CryptoInvoiceRow | undefined {
    const sql = input.revive
      ? `UPDATE crypto_invoices
            SET expires_at = @expires_at,
                status = CASE WHEN status = 'expired' THEN 'pending' ELSE status END,
                failure_reason = NULL,
                updated_at = @now
          WHERE id = @id
          RETURNING *`
      : `UPDATE crypto_invoices
            SET expires_at = @expires_at,
                updated_at = @now
          WHERE id = @id
          RETURNING *`;
    return this.db.prepare(sql).get({
      id: input.id,
      expires_at: input.expiresAt,
      now: nowIso(),
    }) as unknown as CryptoInvoiceRow | undefined;
  }

  /**
   * Admin-only: attach a tx hash to ANY status (including expired/failed),
   * resetting the failure reason and forcing status to 'submitted' so the
   * normal verify+apply pipeline can re-run. Throws on UNIQUE collision.
   */
  attachTxHashAdmin(input: {
    id: number;
    txHash: string;
    fromAddress: string | null;
  }): CryptoInvoiceRow {
    let row: CryptoInvoiceRow | undefined;
    try {
      row = this.db
        .prepare(
          `UPDATE crypto_invoices
              SET tx_hash = @tx_hash,
                  from_address = @from_address,
                  status = 'submitted',
                  failure_reason = NULL,
                  paid_at = COALESCE(paid_at, @now),
                  updated_at = @now
            WHERE id = @id
            RETURNING *`,
        )
        .get({
          id: input.id,
          tx_hash: input.txHash,
          from_address: input.fromAddress,
          now: nowIso(),
        }) as unknown as CryptoInvoiceRow | undefined;
    } catch (err) {
      const message = (err as { message?: string }).message ?? '';
      if (message.includes('UNIQUE') || message.includes('constraint')) {
        throw new AppError(
          ErrorCode.CRYPTO_TX_DUPLICATE,
          `tx ${input.txHash} is already attached to another invoice`,
          { meta: { txHash: input.txHash } },
        );
      }
      throw err;
    }
    if (!row) {
      throw new AppError(
        ErrorCode.CRYPTO_INVOICE_NOT_FOUND,
        `invoice ${input.id} not found`,
        { meta: { id: input.id } },
      );
    }
    return row;
  }

  /** Latest N invoices across all users — for the admin invoice queue. */
  listRecentForAdmin(limit: number, offset: number): CryptoInvoiceRow[] {
    return this.db
      .prepare(
        'SELECT * FROM crypto_invoices ORDER BY id DESC LIMIT ? OFFSET ?',
      )
      .all(limit, offset) as unknown as CryptoInvoiceRow[];
  }

  listByStatusForAdmin(status: string, limit: number, offset: number): CryptoInvoiceRow[] {
    return this.db
      .prepare(
        'SELECT * FROM crypto_invoices WHERE status = ? ORDER BY id DESC LIMIT ? OFFSET ?',
      )
      .all(status, limit, offset) as unknown as CryptoInvoiceRow[];
  }
}
