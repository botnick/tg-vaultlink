/**
 * Collection-draft repository — transient, owner-scoped item buckets.
 *
 * A draft holds the in-progress list of items the owner intends to bundle
 * into a real {@link CollectionRow}. The UNIQUE(bot_id, owner_user_id, status)
 * constraint guarantees only one OPEN draft per (bot, user) at a time so the
 * upload flow never accidentally appends to multiple buckets.
 *
 * Drafts have a TTL recorded in `expires_at`; {@link cleanupExpired} purges
 * everything past the cutoff (cascading to draft items via the schema-level
 * ON DELETE CASCADE).
 */

import type { Db } from '../db/database.js';
import type {
  CollectionDraftRow,
  CollectionDraftItemRow,
  DraftStatus,
  FileType,
} from '../types/index.js';
import { FILE_TYPES } from '../types/index.js';

const nowIso = (): string => new Date().toISOString();

export class CollectionDraftRepository {
  private readonly findOpenByOwnerStmt;
  private readonly insertStmt;
  private readonly setStatusStmt;
  private readonly setMetadataStmt;
  private readonly deleteStmt;
  private readonly findByIdStmt;
  private readonly cleanupExpiredStmt;

  private readonly insertItemStmt;
  private readonly listItemsStmt;
  private readonly countItemsStmt;
  private readonly countItemsByTypeStmt;
  private readonly removeItemStmt;
  private readonly clearItemsStmt;

  constructor(private readonly db: Db) {
    this.findOpenByOwnerStmt = db.prepare(
      "SELECT * FROM collection_drafts WHERE bot_id = ? AND owner_user_id = ? AND status = 'open' LIMIT 1",
    );
    this.insertStmt = db.prepare(
      `INSERT INTO collection_drafts (
         bot_id, owner_user_id, status, title, description, expires_at, created_at, updated_at
       ) VALUES (
         @bot_id, @owner_user_id, 'open', @title, @description, @expires_at, @now, @now
       )
       RETURNING *`,
    );
    this.setStatusStmt = db.prepare(
      'UPDATE collection_drafts SET status = @status, updated_at = @now WHERE id = @id RETURNING *',
    );
    this.setMetadataStmt = db.prepare(
      `UPDATE collection_drafts
         SET title = COALESCE(@title, title),
             description = COALESCE(@description, description),
             updated_at = @now
       WHERE id = @id
       RETURNING *`,
    );
    this.deleteStmt = db.prepare('DELETE FROM collection_drafts WHERE id = ?');
    this.findByIdStmt = db.prepare('SELECT * FROM collection_drafts WHERE id = ?');
    this.cleanupExpiredStmt = db.prepare(
      'DELETE FROM collection_drafts WHERE expires_at IS NOT NULL AND expires_at < ?',
    );

    this.insertItemStmt = db.prepare(
      `INSERT INTO collection_draft_items (
         draft_id, telegram_file_id, telegram_file_unique_id,
         file_type, file_name, mime_type, size_bytes, caption,
         sort_order, created_at
       ) VALUES (
         @draft_id, @telegram_file_id, @telegram_file_unique_id,
         @file_type, @file_name, @mime_type, @size_bytes, @caption,
         @sort_order, @now
       )
       RETURNING *`,
    );
    this.listItemsStmt = db.prepare(
      'SELECT * FROM collection_draft_items WHERE draft_id = ? ORDER BY sort_order ASC, id ASC',
    );
    this.countItemsStmt = db.prepare(
      'SELECT COUNT(*) AS n FROM collection_draft_items WHERE draft_id = ?',
    );
    this.countItemsByTypeStmt = db.prepare(
      'SELECT file_type AS type, COUNT(*) AS n FROM collection_draft_items WHERE draft_id = ? GROUP BY file_type',
    );
    this.removeItemStmt = db.prepare('DELETE FROM collection_draft_items WHERE id = ?');
    this.clearItemsStmt = db.prepare('DELETE FROM collection_draft_items WHERE draft_id = ?');
  }

  /* ----------------------------------------------------------------------- *
   * Draft rows
   * ----------------------------------------------------------------------- */

  findOpenByOwner(botId: number, ownerUserId: number): CollectionDraftRow | undefined {
    return this.findOpenByOwnerStmt.get(botId, ownerUserId) as unknown as
      | CollectionDraftRow
      | undefined;
  }

  insert(input: {
    bot_id: number;
    owner_user_id: number;
    expires_at: string | null;
    title?: string | null;
    description?: string | null;
  }): CollectionDraftRow {
    return this.insertStmt.get({
      bot_id: input.bot_id,
      owner_user_id: input.owner_user_id,
      title: input.title ?? null,
      description: input.description ?? null,
      expires_at: input.expires_at,
      now: nowIso(),
    }) as unknown as CollectionDraftRow;
  }

  setStatus(id: number, status: DraftStatus): CollectionDraftRow | undefined {
    return this.setStatusStmt.get({
      id,
      status,
      now: nowIso(),
    }) as unknown as CollectionDraftRow | undefined;
  }

  setMetadata(
    id: number,
    fields: { title?: string | null; description?: string | null },
  ): CollectionDraftRow | undefined {
    const titleValue = fields.title === undefined ? null : fields.title;
    const descValue = fields.description === undefined ? null : fields.description;
    return this.setMetadataStmt.get({
      id,
      title: titleValue,
      description: descValue,
      now: nowIso(),
    }) as unknown as CollectionDraftRow | undefined;
  }

  delete(id: number): void {
    this.deleteStmt.run(id);
  }

  findById(id: number): CollectionDraftRow | undefined {
    return this.findByIdStmt.get(id) as unknown as CollectionDraftRow | undefined;
  }

  /** Delete every draft whose expires_at < now. Returns the count. */
  cleanupExpired(now: Date): number {
    const result = this.cleanupExpiredStmt.run(now.toISOString());
    return Number(result.changes ?? 0);
  }

  /* ----------------------------------------------------------------------- *
   * Draft items
   * ----------------------------------------------------------------------- */

  insertItem(input: {
    draft_id: number;
    telegram_file_id: string;
    telegram_file_unique_id: string | null;
    file_type: FileType;
    file_name: string | null;
    mime_type: string | null;
    size_bytes: number | null;
    caption: string | null;
    sort_order: number;
  }): CollectionDraftItemRow {
    return this.insertItemStmt.get({
      ...input,
      now: nowIso(),
    }) as unknown as CollectionDraftItemRow;
  }

  listItems(draftId: number): CollectionDraftItemRow[] {
    return this.listItemsStmt.all(draftId) as unknown as CollectionDraftItemRow[];
  }

  countItems(draftId: number): number {
    const row = this.countItemsStmt.get(draftId) as { n: number };
    return row.n;
  }

  countItemsByType(draftId: number): Record<FileType, number> {
    const out: Record<FileType, number> = {
      document: 0,
      photo: 0,
      video: 0,
      audio: 0,
      voice: 0,
      animation: 0,
      sticker: 0,
    };
    const rows = this.countItemsByTypeStmt.all(draftId) as Array<{
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

  clearItems(draftId: number): void {
    this.clearItemsStmt.run(draftId);
  }
}
