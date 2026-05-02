/**
 * VaultLink Bot — shared type definitions.
 *
 * These types describe the cross-cutting domain shapes (locales, log levels,
 * roles, file metadata, persistence row shapes) that every layer of the bot
 * agrees on. Database row interfaces mirror the SQLite schema literally so the
 * data layer can return raw rows without a separate mapping pass.
 */

export type Locale = 'th' | 'en';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
export type NodeEnv = 'development' | 'production' | 'test';

export type FileType = 'document' | 'photo' | 'video' | 'audio' | 'voice' | 'animation' | 'sticker';
export const FILE_TYPES: readonly FileType[] = [
  'document',
  'photo',
  'video',
  'audio',
  'voice',
  'animation',
  'sticker',
] as const;

export type FileVisibility = 'public' | 'private';
export type UserRole = 'super_admin' | 'user' | 'bot_owner' | 'uploader' | 'viewer' | 'banned_user';
export type BotMode = 'main_public' | 'personal_public' | 'personal_private';
export type BotStatus = 'active' | 'error' | 'removed';
export type ReportStatus = 'pending' | 'reviewed' | 'dismissed';
export type BotPermissionType = 'allow' | 'allow_upload' | 'deny' | 'deny_upload';

export interface UserRow {
  id: number;
  telegram_user_id: string;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  locale: string | null;
  role: UserRole;
  is_banned: number; // 0 | 1
  created_at: string;
  updated_at: string;
}

export interface ManagedBotRow {
  id: number;
  owner_user_id: number;
  telegram_bot_id: string;
  username: string;
  display_name: string | null;
  encrypted_token: string;
  token_nonce: string;
  token_auth_tag: string;
  mode: BotMode;
  status: BotStatus;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface FileRow {
  id: number;
  code: string;
  bot_id: number;
  owner_user_id: number;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  file_type: FileType;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  caption: string | null;
  visibility: FileVisibility;
  password_hash: string | null;
  expires_at: string | null;
  is_locked: number;
  is_deleted: number;
  download_count: number;
  created_at: string;
  updated_at: string;
}

export interface FileAccessLogRow {
  id: number;
  file_id: number;
  requester_user_id: number | null;
  action: string;
  created_at: string;
}

export interface BotPermissionRow {
  id: number;
  bot_id: number;
  user_id: number;
  permission_type: BotPermissionType;
  created_at: string;
}

export interface ReportRow {
  id: number;
  file_id: number | null;
  reporter_user_id: number | null;
  reason: string;
  status: ReportStatus;
  created_at: string;
  updated_at: string;
}

export interface RateLimitRow {
  id: number;
  scope: string;
  key: string;
  count: number;
  window_start: string;
}

export interface SettingsRow {
  key: string;
  value: string;
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

/* ------------------------------------------------------------------------- *
 * Wave 7 — Collections
 * ------------------------------------------------------------------------- */

/** A share code resolves to either a single file or a collection. */
export type ShareType = 'single_file' | 'collection';

/** Lifecycle states for a {@link CollectionDraftRow}. */
export type DraftStatus = 'open' | 'finalizing' | 'cancelled';

export interface CollectionRow {
  id: number;
  code: string;
  bot_id: number;
  owner_user_id: number;
  title: string | null;
  description: string | null;
  visibility: FileVisibility;
  password_hash: string | null;
  expires_at: string | null;
  is_locked: number;
  is_deleted: number;
  total_items: number;
  download_count: number;
  created_at: string;
  updated_at: string;
}

export interface CollectionItemRow {
  id: number;
  collection_id: number;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  file_type: FileType;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  caption: string | null;
  sort_order: number;
  created_at: string;
}

export interface CollectionDraftRow {
  id: number;
  bot_id: number;
  owner_user_id: number;
  status: DraftStatus;
  title: string | null;
  description: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CollectionDraftItemRow {
  id: number;
  draft_id: number;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  file_type: FileType;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  caption: string | null;
  sort_order: number;
  created_at: string;
}
