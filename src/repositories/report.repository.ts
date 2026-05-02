/**
 * Report repository — abuse / takedown queue.
 *
 * `file_id` and `reporter_user_id` are nullable so reports survive even when
 * either side gets purged. `countRecentByReporter` powers the spam-budget
 * check in the report service: a single window-based count is cheaper than
 * threading window math into a more general listing call.
 */

import type { Db } from '../db/database.js';
import type { ReportRow, ReportStatus } from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

export class ReportRepository {
  private readonly insertStmt;
  private readonly countPendingForFileStmt;
  private readonly listPendingStmt;
  private readonly listByStatusStmt;
  private readonly setStatusStmt;
  private readonly countByStatusStmt;
  private readonly countRecentByReporterStmt;

  constructor(private readonly db: Db) {
    this.insertStmt = db.prepare(
      `INSERT INTO reports (file_id, reporter_user_id, reason, status, created_at, updated_at)
       VALUES (@file_id, @reporter_user_id, @reason, 'pending', @now, @now)
       RETURNING *`,
    );

    this.countPendingForFileStmt = db.prepare(
      "SELECT COUNT(*) AS n FROM reports WHERE file_id = ? AND status = 'pending'",
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
    this.countByStatusStmt = db.prepare('SELECT COUNT(*) AS n FROM reports WHERE status = ?');
    this.countRecentByReporterStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM reports WHERE reporter_user_id = ? AND created_at >= ?',
    );
  }

  insert(input: {
    file_id: number | null;
    reporter_user_id: number | null;
    reason: string;
  }): ReportRow {
    return this.insertStmt.get({ ...input, now: nowIso() }) as unknown as ReportRow;
  }

  countPendingForFile(fileId: number): number {
    const row = this.countPendingForFileStmt.get(fileId) as { n: number };
    return row.n;
  }

  listPending(limit: number, offset: number): ReportRow[] {
    return this.listPendingStmt.all(limit, offset) as unknown as ReportRow[];
  }

  /**
   * Pending reports filtered to ONLY include reports against files whose
   * `bot_id` is one of the supplied ids. Returns `[]` for an empty bot list
   * — the SQL placeholders would otherwise be invalid. Used by the per-bot
   * moderator view (`/admin_reports` for non-super-admin bot owners).
   *
   * The SQL is rebuilt per call because better-sqlite3 prepared statements
   * cannot expand IN-list parameters; the cost is negligible for an
   * admin-paged query.
   */
  listPendingForBots(botIds: number[], limit: number, offset: number): ReportRow[] {
    if (botIds.length === 0) return [];
    const placeholders = botIds.map(() => '?').join(',');
    const sql = `SELECT r.* FROM reports r
                 JOIN files f ON r.file_id = f.id
                 WHERE r.status = 'pending'
                   AND f.bot_id IN (${placeholders})
                 ORDER BY r.created_at ASC
                 LIMIT ? OFFSET ?`;
    return this.db.prepare(sql).all(...botIds, limit, offset) as unknown as ReportRow[];
  }

  /** Count pending reports against files on the supplied bot ids. */
  countPendingForBots(botIds: number[]): number {
    if (botIds.length === 0) return 0;
    const placeholders = botIds.map(() => '?').join(',');
    const sql = `SELECT COUNT(*) AS n FROM reports r
                 JOIN files f ON r.file_id = f.id
                 WHERE r.status = 'pending'
                   AND f.bot_id IN (${placeholders})`;
    const row = this.db.prepare(sql).get(...botIds) as { n: number };
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

  countByStatus(status: ReportStatus): number {
    const row = this.countByStatusStmt.get(status) as { n: number };
    return row.n;
  }

  countRecentByReporter(reporterUserId: number, sinceIso: string): number {
    const row = this.countRecentByReporterStmt.get(reporterUserId, sinceIso) as { n: number };
    return row.n;
  }
}
