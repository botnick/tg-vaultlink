/**
 * Rate-limit repository — fixed-window counters.
 *
 * Each `(scope, key)` pair gets a single row holding the live count plus the
 * window's start timestamp. `hit` performs the read-decide-write triplet
 * inside `db.transaction(...)` so two concurrent requests cannot both observe
 * a stale count and double-increment, and so a window rollover is atomic with
 * the count reset that follows it. better-sqlite3 transactions are
 * synchronous, which is what makes this safe in a Node single-thread world.
 */

import type { Db } from '../db/database.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import type { RateLimitRow } from '../types/index.js';

export class RateLimitRepository {
  private readonly getStmt;
  private readonly insertStmt;
  private readonly resetStmt;
  private readonly bumpStmt;
  private readonly deleteStmt;

  constructor(private readonly db: Db) {
    this.getStmt = db.prepare('SELECT * FROM rate_limits WHERE scope = ? AND key = ?');
    this.insertStmt = db.prepare(
      `INSERT INTO rate_limits (scope, key, count, window_start)
       VALUES (@scope, @key, 1, @window_start)
       RETURNING *`,
    );
    this.resetStmt = db.prepare(
      `UPDATE rate_limits SET count = 1, window_start = @window_start
       WHERE scope = @scope AND key = @key
       RETURNING *`,
    );
    this.bumpStmt = db.prepare(
      `UPDATE rate_limits SET count = count + 1
       WHERE scope = @scope AND key = @key
       RETURNING *`,
    );
    this.deleteStmt = db.prepare('DELETE FROM rate_limits WHERE scope = ? AND key = ?');
  }

  get(scope: string, key: string): RateLimitRow | undefined {
    return this.getStmt.get(scope, key) as unknown as RateLimitRow | undefined;
  }

  hit(
    scope: string,
    key: string,
    windowMs: number,
    now?: Date,
  ): { row: RateLimitRow; newWindow: boolean } {
    const nowDate = now ?? new Date();
    const nowIsoStr = nowDate.toISOString();
    const nowMs = nowDate.getTime();

    const txn = this.db.transaction(() => {
      const existing = this.getStmt.get(scope, key) as unknown as RateLimitRow | undefined;

      if (!existing) {
        const row = this.insertStmt.get({
          scope,
          key,
          window_start: nowIsoStr,
        }) as unknown as RateLimitRow | undefined;
        if (!row) {
          throw new AppError(ErrorCode.INTERNAL_ERROR, 'Rate-limit insert returned no row', {
            meta: { scope, key },
          });
        }
        return { row, newWindow: true };
      }

      const windowStartMs = Date.parse(existing.window_start);
      const expired =
        Number.isFinite(windowStartMs) && nowMs - windowStartMs >= windowMs;

      if (expired) {
        const row = this.resetStmt.get({
          scope,
          key,
          window_start: nowIsoStr,
        }) as unknown as RateLimitRow | undefined;
        if (!row) {
          throw new AppError(ErrorCode.INTERNAL_ERROR, 'Rate-limit reset returned no row', {
            meta: { scope, key },
          });
        }
        return { row, newWindow: true };
      }

      const row = this.bumpStmt.get({ scope, key }) as unknown as RateLimitRow | undefined;
      if (!row) {
        throw new AppError(ErrorCode.INTERNAL_ERROR, 'Rate-limit bump returned no row', {
          meta: { scope, key },
        });
      }
      return { row, newWindow: false };
    });

    return txn();
  }

  reset(scope: string, key: string): void {
    this.deleteStmt.run(scope, key);
  }
}
