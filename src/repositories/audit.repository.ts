/**
 * Audit-log repository — append-only operator trail.
 *
 * `metadata_json` is stored as already-serialized text — the contract puts
 * stringification at the call site so the same row shape can be replayed
 * verbatim by the caller. The list helper accepts an optional actor and/or
 * action filter; either, both, or neither are valid and the SQL is composed
 * accordingly inside the constructor's prepared cache.
 */

import type { Db } from '../db/database.js';
import type { AuditLogRow } from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

export class AuditRepository {
  private readonly insertStmt;
  private readonly listAllStmt;
  private readonly listByActorStmt;
  private readonly listByActionStmt;
  private readonly listByActorAndActionStmt;

  constructor(private readonly db: Db) {
    this.insertStmt = db.prepare(
      `INSERT INTO audit_logs (
         actor_user_id, action, target_type, target_id, metadata_json, created_at
       ) VALUES (
         @actor_user_id, @action, @target_type, @target_id, @metadata_json, @now
       )
       RETURNING *`,
    );

    this.listAllStmt = db.prepare(
      'SELECT * FROM audit_logs ORDER BY id DESC LIMIT ? OFFSET ?',
    );
    this.listByActorStmt = db.prepare(
      'SELECT * FROM audit_logs WHERE actor_user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?',
    );
    this.listByActionStmt = db.prepare(
      'SELECT * FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT ? OFFSET ?',
    );
    this.listByActorAndActionStmt = db.prepare(
      'SELECT * FROM audit_logs WHERE actor_user_id = ? AND action = ? ORDER BY id DESC LIMIT ? OFFSET ?',
    );
  }

  insert(input: {
    actor_user_id: number | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    metadata_json: string | null;
  }): AuditLogRow {
    return this.insertStmt.get({ ...input, now: nowIso() }) as unknown as AuditLogRow;
  }

  list(opts: {
    actorUserId?: number;
    action?: string;
    limit: number;
    offset: number;
  }): AuditLogRow[] {
    const { actorUserId, action, limit, offset } = opts;
    if (actorUserId !== undefined && action !== undefined) {
      return this.listByActorAndActionStmt.all(
        actorUserId,
        action,
        limit,
        offset,
      ) as unknown as AuditLogRow[];
    }
    if (actorUserId !== undefined) {
      return this.listByActorStmt.all(actorUserId, limit, offset) as unknown as AuditLogRow[];
    }
    if (action !== undefined) {
      return this.listByActionStmt.all(action, limit, offset) as unknown as AuditLogRow[];
    }
    return this.listAllStmt.all(limit, offset) as unknown as AuditLogRow[];
  }
}
