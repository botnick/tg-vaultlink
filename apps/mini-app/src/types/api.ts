/**
 * VaultLink Mini App — public API DTOs.
 *
 * Mirrors the Hono backend's response shapes. Sensitive columns
 * (`encrypted_token`, `password_hash`) are intentionally absent — the
 * type system itself flags accidental leaks.
 */

/* ---------- Primitive enums (mirroring backend) ---------- */

export type FileType =
  | 'document'
  | 'photo'
  | 'video'
  | 'audio'
  | 'voice'
  | 'animation'
  | 'sticker';
export type FileVisibility = 'public' | 'private';
export type Visibility = FileVisibility;
export type BotMode = 'personal_public' | 'personal_private';
export type BotStatus = 'active' | 'disabled' | 'errored';
export type ReportStatus = 'pending' | 'reviewed' | 'dismissed';
export type UserRole = 'user' | 'admin';
export type Locale = 'th' | 'en';

/* ---------- Files ---------- */

export interface FileSummary {
  id: number;
  code: string;
  file_type: FileType;
  file_name: string | null;
  size_bytes: number | null;
  has_password: boolean;
  is_locked: boolean;
  is_deleted: boolean;
  expires_at: string | null;
  download_count: number;
  created_at: string;
}

export interface FileDetail extends FileSummary {
  bot_id: number;
  visibility: FileVisibility;
  caption: string | null;
  mime_type: string | null;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  updated_at: string;
}

/* ---------- Bots ---------- */

export interface BotSummary {
  id: number;
  owner_user_id: number;
  telegram_bot_id: string;
  username: string;
  display_name: string | null;
  mode: BotMode;
  status: BotStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Mini App backend currently returns the same fields for detail and
 *  summary. We keep a separate type so future server-side fields can be
 *  added without disturbing list call sites. */
export type BotDetail = BotSummary;

export interface BotPermission {
  id: number;
  bot_id: number;
  user_id: number;
  permission_type: 'use' | 'upload';
  created_at: string;
}

/* ---------- Users / settings ---------- */

export interface MeUser {
  id: number;
  telegram_user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  locale: string | null;
  role: UserRole;
  is_admin: boolean;
}

export interface MeResponse {
  user: MeUser;
}

export interface SettingsResponse {
  user: { telegram_user_id: string; locale: string | null };
  ui: { default_locale: string; supported_locales: readonly string[] };
}

/* ---------- Reports / audit ---------- */

export interface ReportRow {
  id: number;
  file_id: number | null;
  reporter_user_id: number | null;
  reason: string;
  status: ReportStatus;
  created_at: string;
  updated_at: string;
}

export interface AuditLogRow {
  id: number;
  actor_user_id: number | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

/* ---------- Admin ---------- */

export interface AdminStats {
  users: number;
  bots: number;
  files: number;
  activeFiles?: number;
  downloads: number;
  pendingReports: number;
}

/* ---------- Collections ---------- */

export interface CollectionSummary {
  id: number;
  code: string;
  bot_id: number;
  title: string | null;
  description: string | null;
  visibility: Visibility;
  has_password: boolean;
  expires_at: string | null;
  is_locked: number;
  is_deleted: number;
  total_items: number;
  download_count: number;
  created_at: string;
  updated_at: string;
}

export interface CollectionItemSummary {
  id: number;
  telegram_file_id: string;
  file_type: FileType;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  caption: string | null;
  sort_order: number;
}

export interface CollectionDetail extends CollectionSummary {
  items: CollectionItemSummary[];
  counts_by_type: Partial<Record<FileType, number>>;
}

/* ---------- Pagination envelope ---------- */

export interface PageResponse<T> {
  items: T[];
  total?: number;
}

/* ---------- Error envelope ---------- */

export interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

/** Thrown by the `api()` fetch wrapper for any non-2xx response. */
export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}
