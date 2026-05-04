/**
 * VaultLink Bot — Mini App backend shared types.
 *
 * Aggregates the service + repository handles every router needs so each
 * route module can take a single `deps` object instead of re-declaring its
 * dependency surface. The same shape is also handed to the server factory.
 *
 * The DTO interfaces below are the externally-facing JSON shapes the Mini
 * App frontend depends on. They deliberately omit every secret column
 * (`encrypted_token`, `token_nonce`, `token_auth_tag`, `password_hash`) so
 * the type system itself flags any accidental leak.
 */

import type { FileService } from '../services/file.service.js';
import type { BotService } from '../services/bot.service.js';
import type { PermissionService } from '../services/permission.service.js';
import type { UserService } from '../services/user.service.js';
import type { RateLimitService } from '../services/rateLimit.service.js';
import type { SettingsService } from '../services/settings.service.js';
import type { ReportService } from '../services/report.service.js';
import type { AuditService } from '../services/audit.service.js';
import type { ShareService } from '../services/share.service.js';

import type { UserRepository } from '../repositories/user.repository.js';
import type { FileRepository } from '../repositories/file.repository.js';
import type { BotRepository } from '../repositories/bot.repository.js';
import type { PermissionRepository } from '../repositories/permission.repository.js';
import type { ReportRepository } from '../repositories/report.repository.js';
import type { AuditRepository } from '../repositories/audit.repository.js';
import type { SettingsRepository } from '../repositories/settings.repository.js';
import type { RateLimitRepository } from '../repositories/rateLimit.repository.js';
import type { CollectionRepository } from '../repositories/collection.repository.js';
import type { CollectionDraftRepository } from '../repositories/collectionDraft.repository.js';

/** Bundle of every domain service the Mini App backend talks to. */
export interface AppServices {
  file: FileService;
  bot: BotService;
  permission: PermissionService;
  user: UserService;
  rateLimit: RateLimitService;
  settings: SettingsService;
  report: ReportService;
  audit: AuditService;
  /** Wave 7 — unified shares (single files + collections). */
  share: ShareService;
}

/** Bundle of repositories the Mini App backend reads from directly. */
export interface AppRepos {
  users: UserRepository;
  files: FileRepository;
  bots: BotRepository;
  permissions: PermissionRepository;
  reports: ReportRepository;
  audit: AuditRepository;
  settings: SettingsRepository;
  rateLimit: RateLimitRepository;
  /** Wave 7 — collections + drafts. */
  collections: CollectionRepository;
  collectionDrafts: CollectionDraftRepository;
}

/* -------------------------------------------------------------------------- *
 * Public DTOs — what the frontend sees.
 * -------------------------------------------------------------------------- */

/** Trimmed file row for list responses (omits secrets + internal handles). */
export interface FileSummaryDto {
  id: number;
  /** Bare base code (lookup key). Kept for backward compat. */
  code: string;
  /** Canonical display form `botname:CODE_<n><L>` — what the user copies. */
  share_code: string;
  file_type: string;
  file_name: string | null;
  size_bytes: number | null;
  has_password: boolean;
  is_locked: boolean;
  is_deleted: boolean;
  expires_at: string | null;
  download_count: number;
  created_at: string;
}

/**
 * File detail response — same shape as {@link FileSummaryDto} plus the
 * Telegram file id (the bot needs it to actually deliver the file). The
 * `password_hash` column is never exposed.
 */
export interface FileDetailDto extends FileSummaryDto {
  bot_id: number;
  visibility: string;
  caption: string | null;
  mime_type: string | null;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  updated_at: string;
}

/** Public bot row — the secret token tuple is intentionally absent. */
export interface BotDto {
  id: number;
  owner_user_id: number;
  telegram_bot_id: string;
  username: string;
  display_name: string | null;
  mode: string;
  status: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Public user row for the `/me` endpoint. */
export interface MeDto {
  id: number;
  telegram_user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  locale: string | null;
  role: string;
  is_admin: boolean;
  /** True only for env-driven `ADMIN_IDS` members. Founders can promote /
   * demote other users to / from super_admin; promoted super admins
   * cannot. The frontend uses this flag to render the per-row promote /
   * demote buttons on the admin user list. */
  is_founder: boolean;
}

/** Standard error envelope. */
export interface ApiError {
  code: string;
  message: string;
}

/** Standard success envelope; both keys are optional but at least one is set. */
export interface ApiEnvelope<T> {
  data?: T;
  error?: ApiError;
}
