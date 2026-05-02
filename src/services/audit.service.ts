/**
 * VaultLink Bot — audit log service.
 *
 * Centralizes writes to the `audit_log` table so every call site uses the
 * same JSON-encoding rules for `metadata_json`. The service is deliberately
 * kept synchronous (matching the underlying better-sqlite3 driver) and never
 * throws on its own — a failed audit insert should bubble up from the repo so
 * the orchestrator decides how to handle it.
 */

import type { AuditLogRow } from '../types/index.js';

/** Subset of the audit repo this service depends on. */
export interface IAuditRepository {
  insert(input: {
    actor_user_id: number | null;
    action: string;
    target_type: string | null;
    target_id: string | null;
    metadata_json: string | null;
  }): AuditLogRow;
}

/** Optional metadata that callers may attach to a single audit entry. */
export interface AuditLogOptions {
  /** Acting user's local row id, or `null` for system-driven actions. */
  actorUserId?: number | null;
  /** Free-form classifier of the affected entity ("file", "bot", "user"...). */
  targetType?: string | null;
  /** Stable identifier of the affected entity. Stored as text. */
  targetId?: string | null;
  /** Structured payload; serialized to JSON if provided. */
  metadata?: Record<string, unknown> | null;
}

export class AuditService {
  private readonly repo: IAuditRepository;

  constructor(repo: IAuditRepository) {
    this.repo = repo;
  }

  /**
   * Append a single entry to the audit log. `metadata` is JSON-stringified
   * when present; `null`/missing values are passed through unchanged so the
   * underlying column stores `NULL` rather than the literal string `"null"`.
   */
  log(action: string, opts: AuditLogOptions = {}): void {
    const metadata = opts.metadata;
    const metadata_json: string | null =
      metadata === undefined || metadata === null ? null : JSON.stringify(metadata);

    this.repo.insert({
      actor_user_id: opts.actorUserId ?? null,
      action,
      target_type: opts.targetType ?? null,
      target_id: opts.targetId ?? null,
      metadata_json,
    });
  }
}
