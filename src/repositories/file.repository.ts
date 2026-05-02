/**
 * File repository — vault items plus their access trail.
 *
 * Two tables live here: `files` (the canonical record per uploaded item) and
 * `file_access_logs` (an append-only audit of who fetched what). The file
 * code is unique per `(bot_id, code)` pair; `findByCodeAcrossBots` exists for
 * the deep-link path where the user pastes a bare code without ever speaking
 * to the owning bot. Toggle setters return the freshly-updated row so callers
 * don't have to round-trip again.
 */

import type { Db } from '../db/database.js';
import type { FileRow, FileAccessLogRow } from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

export class FileRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly findByCodeStmt;
  private readonly findByCodeAcrossBotsStmt;
  private readonly listByOwnerWithDeletedStmt;
  private readonly listByOwnerActiveStmt;
  private readonly setLockedStmt;
  private readonly setDeletedStmt;
  private readonly setPasswordHashStmt;
  private readonly setExpiresAtStmt;
  private readonly incrementDownloadCountStmt;
  private readonly countByOwnerStmt;
  private readonly countAllStmt;
  private readonly countActiveStmt;
  private readonly totalDownloadsStmt;

  private readonly insertAccessLogStmt;
  private readonly listAccessLogsStmt;

  constructor(private readonly db: Db) {
    this.insertStmt = db.prepare(
      `INSERT INTO files (
         code, bot_id, owner_user_id, telegram_file_id, telegram_file_unique_id,
         file_type, file_name, mime_type, size_bytes, caption,
         visibility, password_hash, expires_at,
         is_locked, is_deleted, download_count, created_at, updated_at
       ) VALUES (
         @code, @bot_id, @owner_user_id, @telegram_file_id, @telegram_file_unique_id,
         @file_type, @file_name, @mime_type, @size_bytes, @caption,
         @visibility, @password_hash, @expires_at,
         0, 0, 0, @now, @now
       )
       RETURNING *`,
    );

    this.findByIdStmt = db.prepare('SELECT * FROM files WHERE id = ?');
    this.findByCodeStmt = db.prepare('SELECT * FROM files WHERE bot_id = ? AND code = ?');
    this.findByCodeAcrossBotsStmt = db.prepare(
      'SELECT * FROM files WHERE code = ? ORDER BY id ASC LIMIT 1',
    );

    this.listByOwnerWithDeletedStmt = db.prepare(
      'SELECT * FROM files WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    );
    this.listByOwnerActiveStmt = db.prepare(
      'SELECT * FROM files WHERE owner_user_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?',
    );

    this.setLockedStmt = db.prepare(
      'UPDATE files SET is_locked = @locked, updated_at = @now WHERE id = @id RETURNING *',
    );
    this.setDeletedStmt = db.prepare(
      'UPDATE files SET is_deleted = @deleted, updated_at = @now WHERE id = @id RETURNING *',
    );
    this.setPasswordHashStmt = db.prepare(
      'UPDATE files SET password_hash = @hash, updated_at = @now WHERE id = @id RETURNING *',
    );
    this.setExpiresAtStmt = db.prepare(
      'UPDATE files SET expires_at = @expires_at, updated_at = @now WHERE id = @id RETURNING *',
    );
    this.incrementDownloadCountStmt = db.prepare(
      'UPDATE files SET download_count = download_count + 1, updated_at = @now WHERE id = @id',
    );

    this.countByOwnerStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM files WHERE owner_user_id = ?',
    );
    this.countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM files');
    this.countActiveStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM files WHERE is_deleted = 0 AND is_locked = 0',
    );
    this.totalDownloadsStmt = db.prepare(
      'SELECT COALESCE(SUM(download_count), 0) AS n FROM files',
    );

    this.insertAccessLogStmt = db.prepare(
      `INSERT INTO file_access_logs (file_id, requester_user_id, action, created_at)
       VALUES (@file_id, @requester_user_id, @action, @now)
       RETURNING *`,
    );
    this.listAccessLogsStmt = db.prepare(
      'SELECT * FROM file_access_logs WHERE file_id = ? ORDER BY id DESC LIMIT ?',
    );
  }

  insert(input: {
    code: string;
    bot_id: number;
    owner_user_id: number;
    telegram_file_id: string;
    telegram_file_unique_id: string | null;
    file_type: FileRow['file_type'];
    file_name: string | null;
    mime_type: string | null;
    size_bytes: number | null;
    caption: string | null;
    visibility: FileRow['visibility'];
    password_hash: string | null;
    expires_at: string | null;
  }): FileRow {
    return this.insertStmt.get({ ...input, now: nowIso() }) as unknown as FileRow;
  }

  findById(id: number): FileRow | undefined {
    return this.findByIdStmt.get(id) as unknown as FileRow | undefined;
  }

  findByCode(botId: number, code: string): FileRow | undefined {
    return this.findByCodeStmt.get(botId, code) as unknown as FileRow | undefined;
  }

  findByCodeAcrossBots(code: string): FileRow | undefined {
    return this.findByCodeAcrossBotsStmt.get(code) as unknown as FileRow | undefined;
  }

  listByOwner(
    ownerUserId: number,
    opts?: { includeDeleted?: boolean; limit?: number; offset?: number },
  ): FileRow[] {
    const includeDeleted = opts?.includeDeleted ?? false;
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;
    const stmt = includeDeleted ? this.listByOwnerWithDeletedStmt : this.listByOwnerActiveStmt;
    return stmt.all(ownerUserId, limit, offset) as unknown as FileRow[];
  }

  setLocked(id: number, locked: boolean): FileRow | undefined {
    return this.setLockedStmt.get({
      id,
      locked: locked ? 1 : 0,
      now: nowIso(),
    }) as unknown as FileRow | undefined;
  }

  setDeleted(id: number, deleted: boolean): FileRow | undefined {
    return this.setDeletedStmt.get({
      id,
      deleted: deleted ? 1 : 0,
      now: nowIso(),
    }) as unknown as FileRow | undefined;
  }

  setPasswordHash(id: number, hash: string | null): FileRow | undefined {
    return this.setPasswordHashStmt.get({
      id,
      hash,
      now: nowIso(),
    }) as unknown as FileRow | undefined;
  }

  setExpiresAt(id: number, expiresAt: string | null): FileRow | undefined {
    return this.setExpiresAtStmt.get({
      id,
      expires_at: expiresAt,
      now: nowIso(),
    }) as unknown as FileRow | undefined;
  }

  incrementDownloadCount(id: number): void {
    this.incrementDownloadCountStmt.run({ id, now: nowIso() });
  }

  countByOwner(ownerUserId: number): number {
    const row = this.countByOwnerStmt.get(ownerUserId) as { n: number };
    return row.n;
  }

  countAll(): number {
    const row = this.countAllStmt.get() as { n: number };
    return row.n;
  }

  countActive(): number {
    const row = this.countActiveStmt.get() as { n: number };
    return row.n;
  }

  totalDownloads(): number {
    const row = this.totalDownloadsStmt.get() as { n: number };
    return row.n;
  }

  insertAccessLog(input: {
    file_id: number;
    requester_user_id: number | null;
    action: string;
  }): FileAccessLogRow {
    return this.insertAccessLogStmt.get({
      ...input,
      now: nowIso(),
    }) as unknown as FileAccessLogRow;
  }

  listAccessLogs(fileId: number, limit: number): FileAccessLogRow[] {
    return this.listAccessLogsStmt.all(fileId, limit) as unknown as FileAccessLogRow[];
  }
}
