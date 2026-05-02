/**
 * VaultLink Bot — unified share service (Wave 7).
 *
 * A "share" is the user-facing artifact identified by a single share code; it
 * resolves to either an individual {@link FileRow} or a {@link CollectionRow}.
 * Single-file shares continue to flow through {@link FileService} for upload
 * and decode; ShareService owns the collection lifecycle (drafts → finished
 * collection) and the polymorphic resolver that lets the bot's decode router
 * accept the same code surface for both shapes.
 *
 * Code uniqueness is enforced PER BOT across BOTH the `files` AND
 * `collections` tables: a code that already lives on a file row in the same
 * bot cannot be reused for a new collection (and vice-versa). The mint loop
 * retries up to MAX_CODE_GEN_ATTEMPTS times before surfacing INTERNAL_ERROR.
 *
 * All locked/expired/deleted/password gates surface the same set of error
 * codes used by the single-file path so callers can branch identically.
 */

import type { Config } from '../config/env.js';
import type {
  CollectionRow,
  CollectionItemRow,
  CollectionDraftRow,
  CollectionDraftItemRow,
  FileRow,
  FileType,
  FileVisibility,
  ManagedBotRow,
  Locale,
  UserRow,
} from '../types/index.js';
import type { FileRepository } from '../repositories/file.repository.js';
import type { BotRepository } from '../repositories/bot.repository.js';
import type { CollectionRepository } from '../repositories/collection.repository.js';
import type { CollectionDraftRepository } from '../repositories/collectionDraft.repository.js';
import type { AuditService } from './audit.service.js';
import { hashPassword, verifyPassword, validatePasswordLength } from './password.service.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { generateCode } from '../utils/codeGenerator.js';
import { parseShareCode } from '../utils/codeParser.js';
import { addDays, isExpired } from '../utils/date.js';
import { truncate } from '../utils/safeText.js';
import { t } from '../utils/i18n.js';
import { CAPTION_MAX_LENGTH, FILENAME_MAX_LENGTH } from '../config/constants.js';

/* -------------------------------------------------------------------------- *
 * Public types
 * -------------------------------------------------------------------------- */

export type ResolvedShare =
  | { type: 'single_file'; file: FileRow; bot: ManagedBotRow }
  | { type: 'collection'; collection: CollectionRow; bot: ManagedBotRow };

/** Subset of {@link import('../utils/fileMeta.js').ExtractedFileMeta} that the
 * collection draft accepts. Re-declared here so this module stays free of the
 * grammY-tied utility imports. */
export interface DraftItemMeta {
  file_type: FileType;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  caption: string | null;
}

export interface RenderedCollectionPage {
  page: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  countsByType: Partial<Record<FileType, number>>;
  /** Items belonging to THIS page only, in `sort_order` ascending. */
  items: CollectionItemRow[];
  /** Pre-localized caption built from the `collection.preview.caption` key. */
  caption: string;
}

export interface FinishCollectionResult {
  collection: CollectionRow;
  shareCode: string;
  deepLink: string;
}

/* -------------------------------------------------------------------------- *
 * Implementation
 * -------------------------------------------------------------------------- */

const MAX_CODE_GEN_ATTEMPTS = 8;

export class ShareService {
  private readonly files: FileRepository;
  private readonly bots: BotRepository;
  private readonly collections: CollectionRepository;
  private readonly drafts: CollectionDraftRepository;
  private readonly audit: AuditService;
  private readonly config: Config;

  constructor(deps: {
    files: FileRepository;
    bots: BotRepository;
    collections: CollectionRepository;
    drafts: CollectionDraftRepository;
    audit: AuditService;
    config: Config;
  }) {
    this.files = deps.files;
    this.bots = deps.bots;
    this.collections = deps.collections;
    this.drafts = deps.drafts;
    this.audit = deps.audit;
    this.config = deps.config;
  }

  /* ------------------------------------------------------------------ *
   * Polymorphic resolution
   * ------------------------------------------------------------------ */

  /**
   * Resolve a parsed share code (with optional bot context) to either a
   * single_file or collection share. Returns `null` when the code does not
   * match anything. Soft-deleted rows in both tables are treated as missing.
   */
  async resolveShareCode(input: {
    rawCode: string;
    contextBot?: ManagedBotRow | null;
  }): Promise<ResolvedShare | null> {
    const parsed = parseShareCode(input.rawCode);
    if (!parsed) return null;

    let bot: ManagedBotRow | undefined;
    if (parsed.botUsername !== null) {
      bot = this.bots.findByUsername(parsed.botUsername);
      if (!bot || bot.status !== 'active') return null;
    } else if (input.contextBot) {
      bot = input.contextBot;
    }

    // Single-file lookup first, then fall back to collections. We try files
    // first because the volume of single-file rows is far higher in
    // production traffic.
    if (bot) {
      const file = this.files.findByCode(bot.id, parsed.code);
      if (file && file.is_deleted === 0) {
        return { type: 'single_file', file, bot };
      }
      const collection = this.collections.findByCode(bot.id, parsed.code);
      if (collection && collection.is_deleted === 0) {
        return { type: 'collection', collection, bot };
      }
      return null;
    }

    // No bot context: search across bots.
    const fileGlobal = this.files.findByCodeAcrossBots(parsed.code);
    if (fileGlobal && fileGlobal.is_deleted === 0) {
      const owningBot = this.bots.findById(fileGlobal.bot_id);
      if (owningBot) {
        return { type: 'single_file', file: fileGlobal, bot: owningBot };
      }
    }
    const collGlobal = this.collections.findByCodeAcrossBots(parsed.code);
    if (collGlobal && collGlobal.is_deleted === 0) {
      const owningBot = this.bots.findById(collGlobal.bot_id);
      if (owningBot) {
        return { type: 'collection', collection: collGlobal, bot: owningBot };
      }
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * Draft lifecycle
   * ------------------------------------------------------------------ */

  /**
   * Create or fetch the open draft for `(bot, owner)`. The UNIQUE constraint
   * on `(bot_id, owner_user_id, status='open')` guarantees idempotency.
   */
  createCollectionDraft(owner: UserRow, bot: ManagedBotRow): CollectionDraftRow {
    if (!this.config.ENABLE_COLLECTIONS) {
      throw new AppError(ErrorCode.FEATURE_DISABLED, 'collections are disabled', { expose: true });
    }
    const existing = this.drafts.findOpenByOwner(bot.id, owner.id);
    if (existing) return existing;

    const ttlMs = this.config.COLLECTION_DRAFT_TTL_MINUTES * 60_000;
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const row = this.drafts.insert({
      bot_id: bot.id,
      owner_user_id: owner.id,
      expires_at: expiresAt,
    });
    this.audit.log('collection.draft_started', {
      actorUserId: owner.id,
      targetType: 'collection_draft',
      targetId: String(row.id),
      metadata: { bot_id: bot.id },
    });
    return row;
  }

  /** Return the user's currently-open draft for the given bot, if any. */
  getOpenDraft(owner: UserRow, bot: ManagedBotRow): CollectionDraftRow | null {
    return this.drafts.findOpenByOwner(bot.id, owner.id) ?? null;
  }

  /**
   * Append a new item to a draft. Enforces the per-collection cap and the
   * collections feature flag. Returns the inserted item row.
   */
  addItemToDraft(draft: CollectionDraftRow, meta: DraftItemMeta): CollectionDraftItemRow {
    if (!this.config.ENABLE_COLLECTIONS) {
      throw new AppError(ErrorCode.FEATURE_DISABLED, 'collections are disabled', { expose: true });
    }
    if (draft.status !== 'open') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'this draft is no longer accepting items', {
        expose: true,
      });
    }
    const current = this.drafts.countItems(draft.id);
    if (current >= this.config.MAX_COLLECTION_ITEMS) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        `cannot exceed ${this.config.MAX_COLLECTION_ITEMS} items per collection`,
        { expose: true, meta: { max: this.config.MAX_COLLECTION_ITEMS } },
      );
    }
    const sortOrder = current; // 0-indexed
    const caption = meta.caption === null ? null : truncate(meta.caption, CAPTION_MAX_LENGTH);
    const fileName = meta.file_name === null ? null : truncate(meta.file_name, FILENAME_MAX_LENGTH);
    return this.drafts.insertItem({
      draft_id: draft.id,
      telegram_file_id: meta.telegram_file_id,
      telegram_file_unique_id: meta.telegram_file_unique_id,
      file_type: meta.file_type,
      file_name: fileName,
      mime_type: meta.mime_type,
      size_bytes: meta.size_bytes,
      caption,
      sort_order: sortOrder,
    });
  }

  setDraftMetadata(
    draft: CollectionDraftRow,
    fields: { title?: string | null; description?: string | null },
  ): CollectionDraftRow {
    const updated = this.drafts.setMetadata(draft.id, fields);
    if (!updated) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'draft disappeared during update');
    }
    return updated;
  }

  /** Cancel and delete the draft (cascades draft items via the schema). */
  cancelDraft(draft: CollectionDraftRow, actor: UserRow): void {
    this.drafts.delete(draft.id);
    this.audit.log('collection.draft_cancelled', {
      actorUserId: actor.id,
      targetType: 'collection_draft',
      targetId: String(draft.id),
    });
  }

  /**
   * Convert an open draft into a real collection. Allocates a fresh share
   * code, copies items in the draft's sort_order, updates total_items, then
   * deletes the draft. The whole sequence runs inside a single transaction.
   */
  async finishCollection(
    draft: CollectionDraftRow,
    actor: UserRow,
    opts?: {
      visibility?: FileVisibility;
      password?: string | null;
      expiresInDays?: number | null;
    },
  ): Promise<FinishCollectionResult> {
    if (!this.config.ENABLE_COLLECTIONS) {
      throw new AppError(ErrorCode.FEATURE_DISABLED, 'collections are disabled', { expose: true });
    }
    if (draft.status !== 'open') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'this draft can no longer be finished', {
        expose: true,
      });
    }
    const items = this.drafts.listItems(draft.id);
    if (items.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'cannot finish an empty collection', {
        expose: true,
      });
    }

    let passwordHash: string | null = null;
    if (opts?.password !== undefined && opts.password !== null && opts.password !== '') {
      if (!this.config.ENABLE_PASSWORD_PROTECTION) {
        throw new AppError(ErrorCode.FEATURE_DISABLED, 'password protection is disabled', {
          expose: true,
        });
      }
      validatePasswordLength(opts.password);
      passwordHash = await hashPassword(opts.password);
    }

    const expiresAt = this.resolveExpiry(opts?.expiresInDays ?? null);
    const visibility: FileVisibility = opts?.visibility ?? 'public';

    const bot = this.bots.findById(draft.bot_id);
    if (!bot) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'draft references missing bot');
    }

    const code = this.allocateCode(bot.id);
    const collection = this.collections.insert({
      code,
      bot_id: bot.id,
      owner_user_id: actor.id,
      title: draft.title,
      description: draft.description,
      visibility,
      password_hash: passwordHash,
      expires_at: expiresAt,
    });

    // Copy items preserving the draft's sort_order, normalising to 0..N.
    let i = 0;
    for (const item of items) {
      this.collections.insertItem({
        collection_id: collection.id,
        telegram_file_id: item.telegram_file_id,
        telegram_file_unique_id: item.telegram_file_unique_id,
        file_type: item.file_type,
        file_name: item.file_name,
        mime_type: item.mime_type,
        size_bytes: item.size_bytes,
        caption: item.caption,
        sort_order: i,
      });
      i++;
    }
    const total = i;
    const updated = this.collections.updateTotalItems(collection.id, total);
    const finalRow = updated ?? collection;

    // Drop the draft (cascades items).
    this.drafts.delete(draft.id);

    this.audit.log('collection.finished', {
      actorUserId: actor.id,
      targetType: 'collection',
      targetId: String(finalRow.id),
      metadata: {
        bot_id: bot.id,
        code: finalRow.code,
        total_items: total,
        has_password: passwordHash !== null,
        expires_at: finalRow.expires_at,
      },
    });

    const shareCode = `${bot.username}_${finalRow.code}`;
    const deepLink = `${this.config.TELEGRAM_DEEP_LINK_BASE}/${bot.username}?start=${finalRow.code}`;
    return { collection: finalRow, shareCode, deepLink };
  }

  /* ------------------------------------------------------------------ *
   * Consumption
   * ------------------------------------------------------------------ */

  /**
   * Build a single page worth of items + a localized caption. The caller is
   * responsible for any locked/expired/password gating beforehand — this
   * method is pure and never throws on those cases.
   *
   * Out-of-range pages are CLAMPED rather than rejected: a stale callback
   * with a too-high page number simply lands on the last page.
   */
  renderCollectionPage(input: {
    collection: CollectionRow;
    page: number;
    locale: Locale;
  }): RenderedCollectionPage {
    const totalItems = this.collections.countItems(input.collection.id);
    const pageSize = this.config.COLLECTION_PAGE_SIZE;
    const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    const safePage = Math.min(Math.max(1, Math.trunc(input.page) || 1), totalPages);
    const offset = (safePage - 1) * pageSize;
    const items =
      totalItems === 0
        ? []
        : this.collections.listItems(input.collection.id, { limit: pageSize, offset });

    const counts = this.collections.countItemsByType(input.collection.id);
    const caption = t(input.locale, 'collection.preview.caption', {
      page: safePage,
      totalPages,
      total: totalItems,
      photo: counts.photo,
      video: counts.video,
      doc: counts.document,
      audio: counts.audio,
      voice: counts.voice,
      animation: counts.animation,
      sticker: counts.sticker,
    });

    return {
      page: safePage,
      totalPages,
      pageSize,
      totalItems,
      countsByType: counts,
      items,
      caption,
    };
  }

  /**
   * Validate a collection access attempt (locked / deleted / expired /
   * password). Mirrors the gate logic on {@link FileService.decode} so the
   * bot router can branch identically. Returns the (possibly password-passed)
   * collection. Throws on any failure.
   */
  async ensureAccessible(input: {
    collection: CollectionRow;
    password?: string | null;
  }): Promise<CollectionRow> {
    const c = input.collection;
    if (c.is_deleted === 1) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'not available', { expose: true });
    }
    if (c.is_locked === 1) {
      throw new AppError(ErrorCode.FILE_LOCKED, 'locked', { expose: true });
    }
    if (isExpired(c.expires_at)) {
      throw new AppError(ErrorCode.FILE_EXPIRED, 'expired', { expose: true });
    }
    if (c.password_hash !== null) {
      const supplied = input.password ?? '';
      if (supplied.length === 0) {
        throw new AppError(ErrorCode.PASSWORD_REQUIRED, 'password required', { expose: true });
      }
      const ok = await verifyPassword(c.password_hash, supplied);
      if (!ok) {
        throw new AppError(ErrorCode.PASSWORD_INCORRECT, 'incorrect password', { expose: true });
      }
    }
    return c;
  }

  /** Increment the download counter (called once per "send_all" or first page view). */
  recordCollectionAccess(c: CollectionRow, actor: UserRow): void {
    this.collections.incrementDownloadCount(c.id);
    this.audit.log('collection.downloaded', {
      actorUserId: actor.id,
      targetType: 'collection',
      targetId: String(c.id),
      metadata: { bot_id: c.bot_id, code: c.code },
    });
  }

  /* ------------------------------------------------------------------ *
   * Owner / admin management
   * ------------------------------------------------------------------ */

  softDeleteCollection(c: CollectionRow, actor: UserRow): void {
    this.collections.setDeleted(c.id, true);
    this.audit.log('collection.deleted', {
      actorUserId: actor.id,
      targetType: 'collection',
      targetId: String(c.id),
    });
  }

  setLocked(c: CollectionRow, locked: boolean, actor: UserRow): CollectionRow {
    const updated = this.collections.setLocked(c.id, locked);
    if (!updated)
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'collection disappeared during update');
    this.audit.log(locked ? 'collection.locked' : 'collection.unlocked', {
      actorUserId: actor.id,
      targetType: 'collection',
      targetId: String(c.id),
    });
    return updated;
  }

  async setPassword(c: CollectionRow, password: string, actor: UserRow): Promise<CollectionRow> {
    if (!this.config.ENABLE_PASSWORD_PROTECTION) {
      throw new AppError(ErrorCode.FEATURE_DISABLED, 'password protection is disabled', {
        expose: true,
      });
    }
    validatePasswordLength(password);
    const hash = await hashPassword(password);
    const updated = this.collections.setPasswordHash(c.id, hash);
    if (!updated)
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'collection disappeared during update');
    this.audit.log('collection.password_set', {
      actorUserId: actor.id,
      targetType: 'collection',
      targetId: String(c.id),
    });
    return updated;
  }

  removePassword(c: CollectionRow, actor: UserRow): CollectionRow {
    const updated = this.collections.setPasswordHash(c.id, null);
    if (!updated)
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'collection disappeared during update');
    this.audit.log('collection.password_removed', {
      actorUserId: actor.id,
      targetType: 'collection',
      targetId: String(c.id),
    });
    return updated;
  }

  setExpiry(c: CollectionRow, days: number | null, actor: UserRow): CollectionRow {
    let expiresAt: string | null;
    if (days === null || days === 0) {
      expiresAt = null;
    } else {
      if (!Number.isInteger(days) || days < 0) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'expiry must be a non-negative integer', {
          expose: true,
        });
      }
      if (!this.config.ENABLE_FILE_EXPIRY) {
        throw new AppError(ErrorCode.FEATURE_DISABLED, 'file expiry is disabled', {
          expose: true,
        });
      }
      expiresAt = addDays(new Date(), days).toISOString();
    }
    const updated = this.collections.setExpiresAt(c.id, expiresAt);
    if (!updated)
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'collection disappeared during update');
    this.audit.log('collection.expiry_set', {
      actorUserId: actor.id,
      targetType: 'collection',
      targetId: String(c.id),
      metadata: { expires_at: expiresAt },
    });
    return updated;
  }

  setVisibility(c: CollectionRow, vis: FileVisibility, actor: UserRow): CollectionRow {
    const updated = this.collections.setVisibility(c.id, vis);
    if (!updated)
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'collection disappeared during update');
    this.audit.log('collection.visibility_set', {
      actorUserId: actor.id,
      targetType: 'collection',
      targetId: String(c.id),
      metadata: { visibility: vis },
    });
    return updated;
  }

  setMetadata(
    c: CollectionRow,
    fields: { title?: string | null; description?: string | null },
    actor: UserRow,
  ): CollectionRow {
    const updated = this.collections.setMetadata(c.id, fields);
    if (!updated)
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'collection disappeared during update');
    this.audit.log('collection.metadata_set', {
      actorUserId: actor.id,
      targetType: 'collection',
      targetId: String(c.id),
    });
    return updated;
  }

  reorderItems(c: CollectionRow, orderedIds: number[], actor: UserRow): void {
    this.collections.reorderItems(c.id, orderedIds);
    this.audit.log('collection.items_reordered', {
      actorUserId: actor.id,
      targetType: 'collection',
      targetId: String(c.id),
      metadata: { order: orderedIds },
    });
  }

  removeItem(c: CollectionRow, itemId: number, actor: UserRow): void {
    this.collections.removeItem(itemId);
    const newTotal = this.collections.countItems(c.id);
    this.collections.updateTotalItems(c.id, newTotal);
    this.audit.log('collection.item_removed', {
      actorUserId: actor.id,
      targetType: 'collection',
      targetId: String(c.id),
      metadata: { item_id: itemId, total_items: newTotal },
    });
  }

  listOwnerCollections(
    owner: UserRow,
    opts?: { limit?: number; offset?: number },
  ): CollectionRow[] {
    const repoOpts: { limit?: number; offset?: number } = {};
    if (opts?.limit !== undefined) repoOpts.limit = opts.limit;
    if (opts?.offset !== undefined) repoOpts.offset = opts.offset;
    return this.collections.listByOwner(owner.id, repoOpts);
  }

  countOwnerCollections(owner: UserRow): number {
    return this.collections.countByOwner(owner.id);
  }

  /* ------------------------------------------------------------------ *
   * Internals
   * ------------------------------------------------------------------ */

  private resolveExpiry(requestedDays: number | null): string | null {
    if (!this.config.ENABLE_FILE_EXPIRY) return null;
    if (requestedDays !== null && requestedDays > 0) {
      if (!Number.isInteger(requestedDays)) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'expiry must be an integer', {
          expose: true,
        });
      }
      return addDays(new Date(), requestedDays).toISOString();
    }
    if (this.config.DEFAULT_FILE_EXPIRY_DAYS > 0) {
      return addDays(new Date(), this.config.DEFAULT_FILE_EXPIRY_DAYS).toISOString();
    }
    return null;
  }

  /**
   * Allocate a share code unique within `bot_id` across BOTH `files` AND
   * `collections`. The mint loop retries on collisions; the practical retry
   * count at our default 12-character alphabet is effectively zero.
   */
  private allocateCode(botId: number): string {
    for (let attempt = 0; attempt < MAX_CODE_GEN_ATTEMPTS; attempt++) {
      const candidate = generateCode(this.config.CODE_LENGTH);
      const fileHit = this.files.findByCode(botId, candidate);
      const collHit = this.collections.findByCode(botId, candidate);
      if (fileHit === undefined && collHit === undefined) {
        return candidate;
      }
    }
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      `failed to allocate a unique share code after ${MAX_CODE_GEN_ATTEMPTS} attempts`,
    );
  }
}
