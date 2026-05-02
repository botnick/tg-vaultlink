/**
 * Bot-permission repository — per-bot allow/deny rules.
 *
 * Each row says "user U has permission P on bot B"; the schema's UNIQUE
 * (bot_id, user_id, permission_type) constraint makes `grant` idempotent via
 * INSERT OR IGNORE so callers don't have to pre-check. `revoke` is the
 * matching delete; `has` is the predicate. The contract is intentionally
 * verb-shaped (grant/revoke/has) to read naturally at call sites.
 */

import type { Db } from '../db/database.js';
import type { BotPermissionRow, BotPermissionType } from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

export class PermissionRepository {
  private readonly grantStmt;
  private readonly revokeStmt;
  private readonly listStmt;
  private readonly hasStmt;
  private readonly countStmt;

  constructor(private readonly db: Db) {
    this.grantStmt = db.prepare(
      `INSERT OR IGNORE INTO bot_permissions (bot_id, user_id, permission_type, created_at)
       VALUES (@bot_id, @user_id, @permission_type, @now)`,
    );
    this.revokeStmt = db.prepare(
      'DELETE FROM bot_permissions WHERE bot_id = ? AND user_id = ? AND permission_type = ?',
    );
    this.listStmt = db.prepare(
      'SELECT * FROM bot_permissions WHERE bot_id = ? ORDER BY id ASC',
    );
    this.hasStmt = db.prepare(
      'SELECT 1 FROM bot_permissions WHERE bot_id = ? AND user_id = ? AND permission_type = ? LIMIT 1',
    );
    this.countStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM bot_permissions WHERE bot_id = ?',
    );
  }

  grant(botId: number, userId: number, permissionType: BotPermissionType): void {
    this.grantStmt.run({
      bot_id: botId,
      user_id: userId,
      permission_type: permissionType,
      now: nowIso(),
    });
  }

  revoke(botId: number, userId: number, permissionType: BotPermissionType): void {
    this.revokeStmt.run(botId, userId, permissionType);
  }

  list(botId: number): BotPermissionRow[] {
    return this.listStmt.all(botId) as unknown as BotPermissionRow[];
  }

  has(botId: number, userId: number, permissionType: BotPermissionType): boolean {
    return this.hasStmt.get(botId, userId, permissionType) !== undefined;
  }

  count(botId: number): number {
    const row = this.countStmt.get(botId) as { n: number };
    return row.n;
  }
}
