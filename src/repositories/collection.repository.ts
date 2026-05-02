/**
 * Collection repository — multi-file share bundles.
 *
 * Mirrors the {@link FileRepository} surface for collections, plus a
 * sub-API for the immutable per-collection items list. Codes are unique
 * per `(bot_id, code)` like single files; the polymorphic share resolver
 * (in `share.service.ts`) is responsible for treating files and collections
 * as a single namespace at the bot scope.
 */

import type { Db } from '../db/database.js';
import type { CollectionRow, CollectionItemRow, FileType, FileVisibility } from '../types/index.js';
import { FILE_TYPES } from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

export class CollectionRepository {
  private readonly insertStmt;
  private readonly findByIdStmt;
  private readonly findByCodeStmt;
  private readonly findByCodeAcrossBotsStmt;
  private readonly listByOwnerWithDeletedStmt;
  private readonly listByOwnerActiveStmt;
  private readonly listAllStmt;
  private readonly listAllByOwnerStmt;
  private readonly setLockedStmt;
  private readonly setDeletedStmt;
  private readonly setPasswordHashStmt;
  private readonly setExpiresAtStmt;
  private readonly setVisibilityStmt;
  private readonly setMetadataStmt;
  private readonly incrementDownloadCountStmt;
  private readonly updateTotalItemsStmt;
  private readonly countByOwnerStmt;
  private readonly countActiveByOwnerStmt;
  private readonly countAllStmt;
  private readonly countActiveStmt;
  private readonly totalDownloadsStmt;

  private readonly insertItemStmt;
  private readonly listItemsStmt;
  private readonly listItemsPagedStmt;
  private readonly countItemsStmt;
  private readonly countItemsByTypeStmt;
  private readonly removeItemStmt;
  private readonly setItemSortStmt;

  constructor(private readonly db: Db) {
    this.insertStmt = db.prepare(
      `INSERT INTO collections (
         code, bot_id, owner_user_id, title, description,
         visibility, password_hash, expires_at,
         is_locked, is_deleted, total_items, download_count,
         created_at, updated_at
       ) VALUES (
         @code, @bot_id, @owner_user_id, @title, @description,
         @visibility, @password_hash, @expires_at,
         0, 0, 0, 0, @now, @now
       )
       RETURNING *`,
    );
    this.findByIdStmt = db.prepare('SELECT * FROM collections WHERE id = ?');
    this.findByCodeStmt = db.prepare('SELECT * FROM collections WHERE bot_id = ? AND code = ?');
    this.findByCodeAcrossBotsStmt = db.prepare(
      'SELECT * FROM collections WHERE code = ? ORDER BY id ASC LIMIT 1',
    );
    this.listByOwnerWithDeletedStmt = db.prepare(
      'SELECT * FROM collections WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    );
    this.listByOwnerActiveStmt = db.prepare(
      'SELECT * FROM collections WHERE owner_user_id = ? AND is_deleted = 0 ORDER BY created_at DESC LIMIT ? OFFSET ?',
    );
    this.listAllStmt = db.prepare(
      'SELECT * FROM collections ORDER BY created_at DESC LIMIT ? OFFSET ?',
    );
    this.listAllByOwnerStmt = db.prepare(
      'SELECT * FROM collections WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
    );
    this.setLockedStmt = db.prepare(
      'UPDATE collections SET is_locked = @locked, updated_at = @now WHERE id = @id RETURNING *',
    );
    this.setDeletedStmt = db.prepare(
      'UPDATE collections SET is_deleted = @deleted, updated_at = @now WHERE id = @id RETURNING *',
    );
    this.setPasswordHashStmt = db.prepare(
      'UPDATE collections SET password_hash = @hash, updated_at = @now WHERE id = @id RETURNING *',
    );
    this.setExpiresAtStmt = db.prepare(
      'UPDATE collections SET expires_at = @expires_at, updated_at = @now WHERE id = @id RETURNING *',
    );
    this.setVisibilityStmt = db.prepare(
      'UPDATE collections SET visibility = @visibility, updated_at = @now WHERE id = @id RETURNING *',
    );
    this.setMetadataStmt = db.prepare(
      `UPDATE collections
         SET title = COALESCE(@title, title),
             description = COALESCE(@description, description),
             updated_at = @now
       WHERE id = @id
       RETURNING *`,
    );
    this.incrementDownloadCountStmt = db.prepare(
      'UPDATE collections SET download_count = download_count + 1, updated_at = @now WHERE id = @id',
    );
    this.updateTotalItemsStmt = db.prepare(
      'UPDATE collections SET total_items = @total, updated_at = @now WHERE id = @id RETURNING *',
    );
    this.countByOwnerStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM collections WHERE owner_user_id = ?',
    );
    this.countActiveByOwnerStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM collections WHERE owner_user_id = ? AND is_deleted = 0',
    );
    this.countAllStmt = db.prepare('SELECT COUNT(*) AS n FROM collections');
    this.countActiveStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM collections WHERE is_deleted = 0 AND is_locked = 0',
    );
    this.totalDownloadsStmt = db.prepare(
      'SELECT COALESCE(SUM(download_count), 0) AS n FROM collections',
    );

    this.insertItemStmt = db.prepare(
      `INSERT INTO collection_items (
         collection_id, telegram_file_id, telegram_file_unique_id,
         file_type, file_name, mime_type, size_bytes, caption,
         sort_order, created_at
       ) VALUES (
         @collection_id, @telegram_file_id, @telegram_file_unique_id,
         @file_type, @file_name, @mime_type, @size_bytes, @caption,
         @sort_order, @now
       )
       RETURNING *`,
    );
    this.listItemsStmt = db.prepare(
      'SELECT * FROM collection_items WHERE collection_id = ? ORDER BY sort_order ASC, id ASC',
    );
    this.listItemsPagedStmt = db.prepare(
      'SELECT * FROM collection_items WHERE collection_id = ? ORDER BY sort_order ASC, id ASC LIMIT ? OFFSET ?',
    );
    this.countItemsStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM collection_items WHERE collection_id = ?',
    );
    this.countItemsByTypeStmt = db.prepare(
      'SELECT file_type AS type, COUNT(*) AS n FROM collection_items WHERE collection_id = ? GROUP BY file_type',
    );
    this.removeItemStmt = db.prepare('DELETE FROM collection_items WHERE id = ?');
    this.setItemSortStmt = db.prepare(
      'UPDATE collection_items SET sort_order = @sort_order WHERE id = @id AND collection_id = @collection_id',
    );
  }

  /* ----------------------------------------------------------------------- *
   * Collection rows
   * ----------------------------------------------------------------------- */

  insert(input: {
    code: string;
    bot_id: number;
    owner_user_id: number;
    title: string | null;
    description: string | null;
    visibility: FileVisibility;
    password_hash: string | null;
    expires_at: string | null;
  }): CollectionRow {
    return this.insertStmt.get({ ...input, now: nowIso() }) as unknown as CollectionRow;
  }

  findById(id: number): CollectionRow | undefined {
    return this.findByIdStmt.get(id) as unknown as CollectionRow | undefined;
  }

  findByCode(botId: number, code: string): CollectionRow | undefined {
    return this.findByCodeStmt.get(botId, code) as unknown as CollectionRow | undefined;
  }

  findByCodeAcrossBots(code: string): CollectionRow | undefined {
    return this.findByCodeAcrossBotsStmt.get(code) as unknown as CollectionRow | undefined;
  }

  listByOwner(
    ownerUserId: number,
    opts?: { includeDeleted?: boolean; limit?: number; offset?: number },
  ): CollectionRow[] {
    const includeDeleted = opts?.includeDeleted ?? false;
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;
    const stmt = includeDeleted ? this.listByOwnerWithDeletedStmt : this.listByOwnerActiveStmt;
    return stmt.all(ownerUserId, limit, offset) as unknown as CollectionRow[];
  }

  countByOwner(ownerUserId: number): number {
    const row = this.countByOwnerStmt.get(ownerUserId) as { n: number };
    return row.n;
  }

  /** Count of non-soft-deleted collections owned by `ownerUserId`. */
  countActiveByOwner(ownerUserId: number): number {
    const row = this.countActiveByOwnerStmt.get(ownerUserId) as { n: number };
    return row.n;
  }

  /**
   * List ALL collections in the database (admin tooling). Optionally filter
   * by owner. Soft-deleted rows are included so admins can audit deletions.
   */
  listAll(opts?: { limit?: number; offset?: number; ownerUserId?: number }): CollectionRow[] {
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;
    if (opts?.ownerUserId !== undefined) {
      return this.listAllByOwnerStmt.all(
        opts.ownerUserId,
        limit,
        offset,
      ) as unknown as CollectionRow[];
    }
    return this.listAllStmt.all(limit, offset) as unknown as CollectionRow[];
  }

  setLocked(id: number, locked: boolean): CollectionRow | undefined {
    return this.setLockedStmt.get({
      id,
      locked: locked ? 1 : 0,
      now: nowIso(),
    }) as unknown as CollectionRow | undefined;
  }

  setDeleted(id: number, deleted: boolean): CollectionRow | undefined {
    return this.setDeletedStmt.get({
      id,
      deleted: deleted ? 1 : 0,
      now: nowIso(),
    }) as unknown as CollectionRow | undefined;
  }

  setPasswordHash(id: number, hash: string | null): CollectionRow | undefined {
    return this.setPasswordHashStmt.get({
      id,
      hash,
      now: nowIso(),
    }) as unknown as CollectionRow | undefined;
  }

  setExpiresAt(id: number, expiresAt: string | null): CollectionRow | undefined {
    return this.setExpiresAtStmt.get({
      id,
      expires_at: expiresAt,
      now: nowIso(),
    }) as unknown as CollectionRow | undefined;
  }

  setVisibility(id: number, visibility: FileVisibility): CollectionRow | undefined {
    return this.setVisibilityStmt.get({
      id,
      visibility,
      now: nowIso(),
    }) as unknown as CollectionRow | undefined;
  }

  setMetadata(
    id: number,
    fields: { title?: string | null; description?: string | null },
  ): CollectionRow | undefined {
    // COALESCE(@x, x) means "leave the column alone unless we passed an
    // explicit value". `undefined` becomes SQL NULL via better-sqlite3 which
    // would clobber the existing column — so we substitute `null` to mean
    // "no change" and accept explicit `null`s only when the caller wants to
    // wipe a column.
    const titleValue = fields.title === undefined ? null : fields.title;
    const descValue = fields.description === undefined ? null : fields.description;
    return this.setMetadataStmt.get({
      id,
      title: titleValue,
      description: descValue,
      now: nowIso(),
    }) as unknown as CollectionRow | undefined;
  }

  incrementDownloadCount(id: number): void {
    this.incrementDownloadCountStmt.run({ id, now: nowIso() });
  }

  updateTotalItems(id: number, total: number): CollectionRow | undefined {
    return this.updateTotalItemsStmt.get({
      id,
      total,
      now: nowIso(),
    }) as unknown as CollectionRow | undefined;
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

  /* ----------------------------------------------------------------------- *
   * Collection items
   * ----------------------------------------------------------------------- */

  insertItem(input: {
    collection_id: number;
    telegram_file_id: string;
    telegram_file_unique_id: string | null;
    file_type: FileType;
    file_name: string | null;
    mime_type: string | null;
    size_bytes: number | null;
    caption: string | null;
    sort_order: number;
  }): CollectionItemRow {
    return this.insertItemStmt.get({ ...input, now: nowIso() }) as unknown as CollectionItemRow;
  }

  listItems(collectionId: number, opts?: { limit?: number; offset?: number }): CollectionItemRow[] {
    if (opts?.limit !== undefined) {
      const offset = opts.offset ?? 0;
      return this.listItemsPagedStmt.all(
        collectionId,
        opts.limit,
        offset,
      ) as unknown as CollectionItemRow[];
    }
    return this.listItemsStmt.all(collectionId) as unknown as CollectionItemRow[];
  }

  countItems(collectionId: number): number {
    const row = this.countItemsStmt.get(collectionId) as { n: number };
    return row.n;
  }

  countItemsByType(collectionId: number): Record<FileType, number> {
    const out: Record<FileType, number> = {
      document: 0,
      photo: 0,
      video: 0,
      audio: 0,
      voice: 0,
      animation: 0,
      sticker: 0,
    };
    const rows = this.countItemsByTypeStmt.all(collectionId) as Array<{
      type: FileType;
      n: number;
    }>;
    for (const r of rows) {
      if (FILE_TYPES.includes(r.type)) out[r.type] = r.n;
    }
    return out;
  }

  removeItem(itemId: number): void {
    this.removeItemStmt.run(itemId);
  }

  /**
   * Re-number every item in `orderedIds` so its `sort_order` matches its
   * position in the input array (0-indexed). Runs inside a transaction so a
   * failure halfway through cannot leave a broken ordering on disk.
   */
  reorderItems(collectionId: number, orderedIds: number[]): void {
    const tx = this.db.transaction((ids: number[]) => {
      for (let i = 0; i < ids.length; i++) {
        this.setItemSortStmt.run({
          id: ids[i],
          collection_id: collectionId,
          sort_order: i,
        });
      }
    });
    tx(orderedIds);
  }
}
