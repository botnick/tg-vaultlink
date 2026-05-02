/**
 * VaultLink Bot — file lifecycle service.
 *
 * Owns the upload, decode (download lookup), and management flows for
 * vault items. The service composes the file repository with the audit
 * trail and password helpers so handlers stay thin: they collect a
 * Telegram message, hand it off here, and forward the resulting
 * {@link UploadResult} or {@link DecodeResult} back to the user.
 *
 * Validation rules live here rather than in the repository so all error
 * messages are consistent across the upload and management entry points,
 * and so each rule can be tied back to a feature flag in `config`.
 */

import type { Config } from '../config/env.js';
import type { FileRow, FileType, FileVisibility, ManagedBotRow, UserRow } from '../types/index.js';
import type { FileRepository } from '../repositories/file.repository.js';
import type { BotRepository } from '../repositories/bot.repository.js';
import type { AuditService } from './audit.service.js';
import { hashPassword, verifyPassword, validatePasswordLength } from './password.service.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { generateCode } from '../utils/codeGenerator.js';
import { parseShareCode } from '../utils/codeParser.js';
import { addDays, isExpired } from '../utils/date.js';
import { truncate } from '../utils/safeText.js';
import { CAPTION_MAX_LENGTH, FILENAME_MAX_LENGTH } from '../config/constants.js';

export interface UploadInput {
  user: UserRow;
  bot: ManagedBotRow;
  meta: {
    file_type: FileType;
    telegram_file_id: string;
    telegram_file_unique_id: string | null;
    file_name: string | null;
    mime_type: string | null;
    size_bytes: number | null;
    caption: string | null;
  };
  visibility?: FileVisibility;
  password?: string | null;
  expiresInDays?: number | null;
}

export interface UploadResult {
  file: FileRow;
  /** Bot-namespaced share code: `<bot.username>:<code>`. */
  shareCode: string;
  /** Telegram deep link: `<TELEGRAM_DEEP_LINK_BASE>/<bot.username>?start=<code>`. */
  deepLink: string;
}

export interface DecodeInput {
  user: UserRow;
  /** The raw text the user sent (deep link, namespaced code, or bare code). */
  rawCode: string;
  /** When the input is a bare code, restrict lookup to this bot. `null` searches across bots. */
  contextBot?: ManagedBotRow | null;
  /** Password supplied alongside the code (or in a follow-up message). */
  password?: string | null;
}

export interface DecodeResult {
  file: FileRow;
  bot: ManagedBotRow;
}

const MAX_CODE_GEN_ATTEMPTS = 8;

export class FileService {
  private readonly files: FileRepository;
  private readonly bots: BotRepository;
  private readonly audit: AuditService;
  private readonly config: Config;

  constructor(files: FileRepository, bots: BotRepository, audit: AuditService, config: Config) {
    this.files = files;
    this.bots = bots;
    this.audit = audit;
    this.config = config;
  }

  /**
   * Validate the upload, generate a unique share code, persist the row,
   * write the audit entry, and return both the row and the user-facing
   * share artifacts (namespaced code + deep link).
   */
  async upload(input: UploadInput): Promise<UploadResult> {
    const { user, bot, meta } = input;

    // 1) Size cap.
    const maxBytes = this.config.MAX_FILE_SIZE_MB * 1024 * 1024;
    if (meta.size_bytes !== null && meta.size_bytes > maxBytes) {
      throw new AppError(
        ErrorCode.FILE_TOO_LARGE,
        `file exceeds the ${this.config.MAX_FILE_SIZE_MB} MB limit`,
        { expose: true },
      );
    }

    // 2) Blocked extensions (only meaningful for files that carry a name).
    if (meta.file_name !== null && this.isBlockedExtension(meta.file_name)) {
      throw new AppError(ErrorCode.FILE_TYPE_BLOCKED, 'this file type is not allowed', {
        expose: true,
      });
    }

    // 3) Password handling — feature flag + length check + hash.
    let passwordHash: string | null = null;
    if (input.password !== undefined && input.password !== null && input.password !== '') {
      if (!this.config.ENABLE_PASSWORD_PROTECTION) {
        throw new AppError(ErrorCode.FEATURE_DISABLED, 'password protection is disabled', {
          expose: true,
        });
      }
      validatePasswordLength(input.password);
      passwordHash = await hashPassword(input.password);
    }

    // 4) Expiry resolution.
    const expiresAt = this.resolveExpiry(input.expiresInDays ?? null);

    // 5) Sanitize bounded text fields.
    const caption = meta.caption === null ? null : truncate(meta.caption, CAPTION_MAX_LENGTH);
    const fileName = meta.file_name === null ? null : truncate(meta.file_name, FILENAME_MAX_LENGTH);

    // 6) Allocate a fresh share code (per-bot uniqueness).
    const code = this.allocateCode(bot.id);

    // 7) Persist.
    const visibility: FileVisibility = input.visibility ?? 'public';
    const file = this.files.insert({
      code,
      bot_id: bot.id,
      owner_user_id: user.id,
      telegram_file_id: meta.telegram_file_id,
      telegram_file_unique_id: meta.telegram_file_unique_id,
      file_type: meta.file_type,
      file_name: fileName,
      mime_type: meta.mime_type,
      size_bytes: meta.size_bytes,
      caption,
      visibility,
      password_hash: passwordHash,
      expires_at: expiresAt,
    });

    // 8) Audit.
    this.audit.log('file.uploaded', {
      actorUserId: user.id,
      targetType: 'file',
      targetId: String(file.id),
      metadata: {
        bot_id: bot.id,
        code: file.code,
        file_type: file.file_type,
        size_bytes: file.size_bytes,
        has_password: passwordHash !== null,
        expires_at: file.expires_at,
      },
    });

    // 9) User-facing artifacts.
    const shareCode = `${bot.username}:${code}`;
    const deepLink = `${this.config.TELEGRAM_DEEP_LINK_BASE}/${bot.username}?start=${code}`;

    return { file, shareCode, deepLink };
  }

  /**
   * Decode a share-code reference, run state + password checks, record the
   * download, and return the resolved file/bot pair for delivery. Every
   * "this code is unusable" path collapses into {@link ErrorCode.FILE_NOT_AVAILABLE}
   * so the caller cannot probe for code existence by error-message diff.
   */
  async decode(input: DecodeInput): Promise<DecodeResult> {
    const parsed = parseShareCode(input.rawCode);
    if (!parsed) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }

    // 1) Resolve the file row.
    let file: FileRow | undefined;
    if (parsed.botUsername !== null) {
      const namedBot = this.bots.findByUsername(parsed.botUsername);
      if (!namedBot || namedBot.status !== 'active') {
        throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
      }
      file = this.files.findByCode(namedBot.id, parsed.code);
    } else if (input.contextBot) {
      file = this.files.findByCode(input.contextBot.id, parsed.code);
    } else {
      file = this.files.findByCodeAcrossBots(parsed.code);
    }

    if (!file || file.is_deleted === 1) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }

    // 2) Locked / expired.
    if (file.is_locked === 1) {
      throw new AppError(ErrorCode.FILE_LOCKED, 'this file is locked', { expose: true });
    }
    if (isExpired(file.expires_at)) {
      throw new AppError(ErrorCode.FILE_EXPIRED, 'this file has expired', { expose: true });
    }

    // 3) Password gate.
    if (file.password_hash !== null) {
      const supplied = input.password ?? '';
      if (supplied.length === 0) {
        throw new AppError(
          ErrorCode.PASSWORD_REQUIRED,
          'a password is required to download this file',
          { expose: true },
        );
      }
      const ok = await verifyPassword(file.password_hash, supplied);
      if (!ok) {
        throw new AppError(ErrorCode.PASSWORD_INCORRECT, 'incorrect password', { expose: true });
      }
    }

    // 4) Resolve owning bot (we may not have looked it up yet).
    const bot = this.bots.findById(file.bot_id);
    if (!bot) {
      // The schema's foreign key should make this impossible, but guard anyway.
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }

    // 5) Bookkeeping.
    this.files.incrementDownloadCount(file.id);
    this.files.insertAccessLog({
      file_id: file.id,
      requester_user_id: input.user.id,
      action: 'download',
    });
    this.audit.log('file.downloaded', {
      actorUserId: input.user.id,
      targetType: 'file',
      targetId: String(file.id),
      metadata: { bot_id: bot.id, code: file.code },
    });

    return { file, bot };
  }

  /** Soft-delete a file; the row stays for history but downloads stop. */
  softDelete(file: FileRow, actor: UserRow): void {
    this.files.setDeleted(file.id, true);
    this.audit.log('file.deleted', {
      actorUserId: actor.id,
      targetType: 'file',
      targetId: String(file.id),
    });
  }

  /** Set or replace a file password. */
  async setPassword(file: FileRow, password: string, actor: UserRow): Promise<FileRow> {
    if (!this.config.ENABLE_PASSWORD_PROTECTION) {
      throw new AppError(ErrorCode.FEATURE_DISABLED, 'password protection is disabled', {
        expose: true,
      });
    }
    validatePasswordLength(password);
    const hash = await hashPassword(password);
    const updated = this.files.setPasswordHash(file.id, hash);
    if (!updated) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'file disappeared during update');
    }
    this.audit.log('file.password_set', {
      actorUserId: actor.id,
      targetType: 'file',
      targetId: String(file.id),
    });
    return updated;
  }

  removePassword(file: FileRow, actor: UserRow): FileRow {
    const updated = this.files.setPasswordHash(file.id, null);
    if (!updated) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'file disappeared during update');
    }
    this.audit.log('file.password_removed', {
      actorUserId: actor.id,
      targetType: 'file',
      targetId: String(file.id),
    });
    return updated;
  }

  /** Update expiry: `null` or `0` clears it; otherwise N days from now. */
  setExpiry(file: FileRow, days: number | null, actor: UserRow): FileRow {
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
    const updated = this.files.setExpiresAt(file.id, expiresAt);
    if (!updated) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'file disappeared during update');
    }
    this.audit.log('file.expiry_set', {
      actorUserId: actor.id,
      targetType: 'file',
      targetId: String(file.id),
      metadata: { expires_at: expiresAt },
    });
    return updated;
  }

  /**
   * Lock or unlock a file. Caller is responsible for verifying admin
   * authority — this method records the action in the audit log but does
   * not re-check permissions.
   */
  setLocked(file: FileRow, locked: boolean, actor: UserRow): FileRow {
    const updated = this.files.setLocked(file.id, locked);
    if (!updated) {
      throw new AppError(ErrorCode.INTERNAL_ERROR, 'file disappeared during update');
    }
    this.audit.log(locked ? 'file.locked' : 'file.unlocked', {
      actorUserId: actor.id,
      targetType: 'file',
      targetId: String(file.id),
    });
    return updated;
  }

  listByOwner(user: UserRow, opts?: { limit?: number; offset?: number }): FileRow[] {
    const repoOpts: { limit?: number; offset?: number } = {};
    if (opts?.limit !== undefined) repoOpts.limit = opts.limit;
    if (opts?.offset !== undefined) repoOpts.offset = opts.offset;
    return this.files.listByOwner(user.id, repoOpts);
  }

  countByOwner(user: UserRow): number {
    return this.files.countByOwner(user.id);
  }

  /* --------------------------------------------------------------------- *
   * Internals
   * --------------------------------------------------------------------- */

  private isBlockedExtension(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    for (const ext of this.config.BLOCKED_EXTENSIONS) {
      // Stored extensions are normalized to start with '.' by env loader.
      if (lower.endsWith(ext)) return true;
    }
    return false;
  }

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

  private allocateCode(botId: number): string {
    for (let attempt = 0; attempt < MAX_CODE_GEN_ATTEMPTS; attempt++) {
      const candidate = generateCode(this.config.CODE_LENGTH);
      if (this.files.findByCode(botId, candidate) === undefined) {
        return candidate;
      }
    }
    throw new AppError(
      ErrorCode.INTERNAL_ERROR,
      `failed to allocate a unique share code after ${MAX_CODE_GEN_ATTEMPTS} attempts`,
    );
  }
}
