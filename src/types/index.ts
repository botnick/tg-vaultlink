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
  broadcast_unsubscribed: number; // 0 | 1 — global broadcast opt-out
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

/* ------------------------------------------------------------------------- *
 * Wave 8 — Broadcasts
 * ------------------------------------------------------------------------- */

export type BroadcastStatus =
  | 'draft'
  | 'scheduled'
  | 'sending'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type BroadcastRecipientStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'blocked'
  | 'cancelled';

export type BroadcastParseMode = 'HTML' | 'MarkdownV2';

/** Inline keyboard button (text + URL only — no callback_data in v0.3). */
export interface BroadcastButton {
  text: string;
  url: string;
}

/** Audience filter, persisted as JSON in `broadcasts.audience_json`. */
export interface BroadcastAudience {
  /** 'all' | 'en' | 'th' */
  locale: 'all' | 'en' | 'th';
  /** 'all' | 'super_admin' | 'user' */
  role: 'all' | 'super_admin' | 'user';
  /** When true, banned users are excluded (default true). */
  exclude_banned: boolean;
  /** When true, users who set /stop_broadcasts are excluded (default true). */
  exclude_unsubscribed: boolean;
  /**
   * Only users registered (created_at) within the last N days. `null` =
   * no constraint. Useful for re-engagement of recent signups only.
   */
  registered_within_days: number | null;
  /**
   * When non-empty, broadcast goes ONLY to these users (overrides every
   * other filter). Stored as Telegram user IDs (string form, matching
   * `users.telegram_user_id`).
   */
  user_ids: string[];
}

export interface BroadcastRow {
  id: number;
  bot_id: number;
  created_by: number;
  status: BroadcastStatus;
  text: string;
  parse_mode: BroadcastParseMode | null;
  media_type: string | null;
  media_file_id: string | null;
  /** JSON-stringified `BroadcastButton[][]` (rows × buttons) or null. */
  buttons_json: string | null;
  disable_web_page_preview: number; // 0 | 1
  protect_content: number; // 0 | 1
  silent: number; // 0 | 1
  audience_json: string;
  audience_count: number;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  count_sent: number;
  count_failed: number;
  count_blocked: number;
  count_pending: number;
  created_at: string;
  updated_at: string;
}

export interface BroadcastRecipientRow {
  id: number;
  broadcast_id: number;
  user_id: number;
  telegram_user_id: string;
  status: BroadcastRecipientStatus;
  message_id: number | null;
  error_code: string | null;
  error_message: string | null;
  retry_count: number;
  next_attempt_at: string | null;
  sent_at: string | null;
  failed_at: string | null;
}
