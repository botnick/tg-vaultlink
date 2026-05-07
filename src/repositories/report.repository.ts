/**
 * Report repository — abuse / takedown queue.
 *
 * Reports are polymorphic: each row points at either a file or a collection
 * via the `(target_type, target_id)` pair. `reporter_user_id` is nullable so
 * reports survive even when the reporter gets purged. `countRecentByReporter`
 * powers the spam-budget check in the report service: a single window-based
 * count is cheaper than threading window math into a more general listing
 * call.
 */

import type { Db } from '../db/database.js';
import type {
  ReportRow,
  ReportStatus,
  ReportTargetType,
  ReportReasonCategory,
} from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

export class ReportRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly countPendingForTargetStmt;
  private readonly listPendingStmt;
  private readonly listByStatusStmt;
  private readonly setStatusStmt;
  private readonly deleteStmt;
  private readonly countByStatusStmt;
  private readonly countRecentByReporterStmt;
  private readonly listByReporterStmt;
  private readonly listByReporterAndStatusStmt;
  private readonly countByReporterStmt;
  private readonly countByReporterAndStatusStmt;
  private readonly countOtherForTargetStmt;

  constructor(private readonly db: Db) {
    this.insertStmt = db.prepare(
      `INSERT INTO reports (
         target_type, target_id, reporter_user_id, reason, reason_category,
         status, created_at, updated_at
       ) VALUES (
         @target_type, @target_id, @reporter_user_id, @reason, @reason_category,
         'pending', @now, @now
       )
       RETURNING *`,
    );

    this.findByIdStmt = db.prepare('SELECT * FROM reports WHERE id = ?');

    this.countPendingForTargetStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM reports
       WHERE target_type = ? AND target_id = ? AND status = 'pending'`,
    );
    this.listPendingStmt = db.prepare(
      "SELECT * FROM reports WHERE status = 'pending' ORDER BY created_at ASC LIMIT ? OFFSET ?",
    );
    this.listByStatusStmt = db.prepare(
      'SELECT * FROM reports WHERE status = ? ORDER BY created_at ASC LIMIT ? OFFSET ?',
    );
    this.setStatusStmt = db.prepare(
      `UPDATE reports SET status = @status, updated_at = @now
       WHERE id = @id
       RETURNING *`,
    );
    this.deleteStmt = db.prepare('DELETE FROM reports WHERE id = ?');
    this.countByStatusStmt = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE status = ?');
    this.countRecentByReporterStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM reports WHERE reporter_user_id = ? AND created_at >= ?',
    );

    // Reporter-side listings (`/reports/mine`, `/my_reports`).
    this.listByReporterStmt = db.prepare(
      `SELECT * FROM reports WHERE reporter_user_id = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );
    this.listByReporterAndStatusStmt = db.prepare(
      `SELECT * FROM reports WHERE reporter_user_id = ? AND status = ?
       ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    );
    this.countByReporterStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM reports WHERE reporter_user_id = ?',
    );
    this.countByReporterAndStatusStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM reports WHERE reporter_user_id = ? AND status = ?',
    );

    // "N other reports against this target", excluding the one currently
    // being viewed.
    this.countOtherForTargetStmt = db.prepare(
      `SELECT COUNT(*) AS n FROM reports
       WHERE target_type = ? AND target_id = ? AND id <> ?`,
    );
  }

  insert(input: {
    target_type: ReportTargetType;
    target_id: number;
    reporter_user_id: number | null;
    reason: string;
    reason_category: ReportReasonCategory;
  }): ReportRow {
    return this.insertStmt.get({ ...input, now: nowIso() }) as unknown as ReportRow;
  }

  findById(id: number): ReportRow | undefined {
    return this.findByIdStmt.get(id) as unknown as ReportRow | undefined;
  }

  /** Pending-report count for one polymorphic target. */
  countPendingForTarget(targetType: ReportTargetType, targetId: number): number {
    const row = this.countPendingForTargetStmt.get(targetType, targetId) as { n: number };
    return row.n;
  }

  listPending(limit: number, offset: number): ReportRow[] {
    return this.listPendingStmt.all(limit, offset) as unknown as ReportRow[];
  }

  /**
   * Pending reports filtered to ONLY include reports against files OR
   * collections whose `bot_id` is one of the supplied ids. Returns `[]` for
   * an empty bot list — the SQL placeholders would otherwise be invalid.
   * Used by the per-bot moderator view (`/admin_reports` for non-super-admin
   * bot owners).
   *
   * The query joins through both target tables with `LEFT JOIN`s qualified by
   * `target_type` so each report row binds to exactly one side; the WHERE
   * filters per target type then restrict by `bot_id`. The SQL is rebuilt
   * per call because better-sqlite3 prepared statements cannot expand IN-list
   * parameters; the cost is negligible for an admin-paged query.
   */
  listPendingForBots(botIds: number[], limit: number, offset: number): ReportRow[] {
    if (botIds.length === 0) return [];
    const placeholders = botIds.map(() => '?').join(',');
    const sql = `SELECT r.* FROM reports r
                 LEFT JOIN files f
                   ON r.target_type = 'file' AND r.target_id = f.id
                 LEFT JOIN collections c
                   ON r.target_type = 'collection' AND r.target_id = c.id
                 WHERE r.status = 'pending'
                   AND (
                     (r.target_type = 'file' AND f.bot_id IN (${placeholders}))
                     OR
                     (r.target_type = 'collection' AND c.bot_id IN (${placeholders}))
                   )
                 ORDER BY r.created_at ASC
                 LIMIT ? OFFSET ?`;
    return this.db
      .prepare(sql)
      .all(...botIds, ...botIds, limit, offset) as unknown as ReportRow[];
  }

  /** Count pending reports against files or collections on the supplied bot ids. */
  countPendingForBots(botIds: number[]): number {
    if (botIds.length === 0) return 0;
    const placeholders = botIds.map(() => '?').join(',');
    const sql = `SELECT COUNT(*) AS n FROM reports r
                 LEFT JOIN files f
                   ON r.target_type = 'file' AND r.target_id = f.id
                 LEFT JOIN collections c
                   ON r.target_type = 'collection' AND r.target_id = c.id
                 WHERE r.status = 'pending'
                   AND (
                     (r.target_type = 'file' AND f.bot_id IN (${placeholders}))
                     OR
                     (r.target_type = 'collection' AND c.bot_id IN (${placeholders}))
                   )`;
    const row = this.db.prepare(sql).get(...botIds, ...botIds) as { n: number };
    return row.n;
  }

  listByStatus(status: ReportStatus, limit: number, offset: number): ReportRow[] {
    return this.listByStatusStmt.all(status, limit, offset) as unknown as ReportRow[];
  }

  setStatus(id: number, status: ReportStatus): ReportRow | undefined {
    return this.setStatusStmt.get({
      id,
      status,
      now: nowIso(),
    }) as unknown as ReportRow | undefined;
  }

  /** Hard-delete one report — only used by the reporter's "withdraw" path. */
  deleteById(id: number): void {
    this.deleteStmt.run(id);
  }

  countByStatus(status: ReportStatus): number {
    const row = this.countByStatusStmt.get(status) as { n: number };
    return row.n;
  }

  countRecentByReporter(reporterUserId: number, sinceIso: string): number {
    const row = this.countRecentByReporterStmt.get(reporterUserId, sinceIso) as { n: number };
    return row.n;
  }

  /** Reporter's own report history — newest first. */
  listByReporter(
    reporterUserId: number,
    status: ReportStatus | null,
    limit: number,
    offset: number,
  ): ReportRow[] {
    if (status === null) {
      return this.listByReporterStmt.all(
        reporterUserId,
        limit,
        offset,
      ) as unknown as ReportRow[];
    }
    return this.listByReporterAndStatusStmt.all(
      reporterUserId,
      status,
      limit,
      offset,
    ) as unknown as ReportRow[];
  }

  countByReporter(reporterUserId: number, status: ReportStatus | null): number {
    const row =
      status === null
        ? (this.countByReporterStmt.get(reporterUserId) as { n: number })
        : (this.countByReporterAndStatusStmt.get(reporterUserId, status) as { n: number });
    return row.n;
  }

  /** Number of OTHER reports filed against the same polymorphic target. */
  countOtherForTarget(
    targetType: ReportTargetType,
    targetId: number,
    excludeReportId: number,
  ): number {
    const row = this.countOtherForTargetStmt.get(targetType, targetId, excludeReportId) as {
      n: number;
    };
    return row.n;
  }
}
