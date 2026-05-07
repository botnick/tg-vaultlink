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
  credits: number; // Wave 9 — cached balance, ledger is source of truth
  credits_initialized: number; // 0 | 1 — has the signup bonus been granted yet?
  // Wave 9.2 — Stars refund defense. ISO timestamp; spend short-circuits with
  // SPEND_LOCKED while it's in the future. Cleared by admin "clear lock".
  spend_locked_until: string | null;
  refund_count: number; // running tally — repeat-offender threshold input
  total_refunded_stars: number; // running tally — surfaced to admin dashboard
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

export type ReportTargetType = 'file' | 'collection';

export type { ReportReasonCategory } from '../config/constants.js';

export interface ReportRow {
  id: number;
  target_type: ReportTargetType;
  target_id: number;
  reporter_user_id: number | null;
  reason: string;
  /** Enum discriminator (see `REPORT_REASON_CATEGORIES`). Backfilled to
   * `'other'` for legacy rows by migration 010. */
  reason_category: import('../config/constants.js').ReportReasonCategory;
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

/* ------------------------------------------------------------------------- *
 * Wave 9 — Credits
 * ------------------------------------------------------------------------- */

/**
 * Reason enum for `credit_transactions.reason`. Stable string literals so
 * the value can be inspected in audit logs without a join.
 */
export type CreditReason =
  | 'signup_bonus'
  | 'referral_reward'
  | 'spend_decode'
  | 'spend_collection_open'
  | 'spend_collection_send'
  | 'refund'
  | 'topup'
  | 'topup_refund'
  | 'admin_writeoff'
  | 'admin_adjust'
  | 'admin_set';

export const CREDIT_REASONS: readonly CreditReason[] = [
  'signup_bonus',
  'referral_reward',
  'spend_decode',
  'spend_collection_open',
  'spend_collection_send',
  'refund',
  'topup',
  'topup_refund',
  'admin_writeoff',
  'admin_adjust',
  'admin_set',
] as const;

export interface CreditTransactionRow {
  id: number;
  user_id: number;
  delta: number;
  reason: CreditReason;
  balance_after: number;
  reference_type: string | null;
  reference_id: string | null;
  metadata_json: string | null;
  created_at: string;
}

/** A single Stars→credits topup package. */
export interface CreditTopupPackage {
  /** Telegram Stars charged at checkout. */
  stars: number;
  /** Credits granted on successful payment. */
  credits: number;
}

/* ------------------------------------------------------------------------- *
 * Wave 9.1 — Self-custodial crypto top-up
 * ------------------------------------------------------------------------- */

/**
 * Logical chain id. Adapters register against these strings; the settings
 * table stores per-chain configuration under `credits.crypto.<id>.<key>`.
 *
 * Wave 9.3 expands the matrix to four networks × two stablecoins. The legacy
 * 'ton-native' id stays in the union so already-confirmed invoices on it
 * still type-check, but it's hidden from the new-invoice picker (see
 * {@link CRYPTO_PICKER_CHAIN_IDS}).
 *
 *   - 'tron-usdt'        — USDT TRC-20 on TRON
 *   - 'tron-usdc'        — USDC TRC-20 on TRON
 *   - 'bsc-usdt'         — USDT BEP-20 on BNB Smart Chain
 *   - 'bsc-usdc'         — USDC BEP-20 on BNB Smart Chain
 *   - 'eth-usdt'         — USDT ERC-20 on Ethereum
 *   - 'eth-usdc'         — USDC ERC-20 on Ethereum
 *   - 'ton-usdt-jetton'  — USDT jetton on TON (Tether's official TON jetton)
 *   - 'ton-usdc-jetton'  — USDC jetton on TON
 *   - 'ton-native'       — TON native coin (legacy; new invoices not allowed)
 */
export type CryptoChainId =
  | 'tron-usdt'
  | 'tron-usdc'
  | 'bsc-usdt'
  | 'bsc-usdc'
  | 'eth-usdt'
  | 'eth-usdc'
  | 'ton-usdt-jetton'
  | 'ton-usdc-jetton'
  | 'ton-native';

export const CRYPTO_CHAIN_IDS: readonly CryptoChainId[] = [
  'tron-usdt',
  'tron-usdc',
  'bsc-usdt',
  'bsc-usdc',
  'eth-usdt',
  'eth-usdc',
  'ton-usdt-jetton',
  'ton-usdc-jetton',
  'ton-native',
] as const;

/**
 * Network bucket — what kind of L1 the chain id belongs to. Used by the UX
 * to render the 2-stage picker (network → token) and by the EVM adapter to
 * pick the right RPC URL.
 */
export type CryptoNetwork = 'trx' | 'bsc' | 'eth' | 'ton';

/**
 * Token bucket — what stablecoin (or native) the chain id carries. The new
 * matrix only ships USDT/USDC; 'native' is reserved for the legacy
 * 'ton-native' chain id so existing invoices keep type-checking.
 */
export type CryptoToken = 'USDT' | 'USDC' | 'native';

/** Mapping from chain id to its network bucket. */
export const CRYPTO_CHAIN_NETWORK: Readonly<Record<CryptoChainId, CryptoNetwork>> = {
  'tron-usdt': 'trx',
  'tron-usdc': 'trx',
  'bsc-usdt': 'bsc',
  'bsc-usdc': 'bsc',
  'eth-usdt': 'eth',
  'eth-usdc': 'eth',
  'ton-usdt-jetton': 'ton',
  'ton-usdc-jetton': 'ton',
  'ton-native': 'ton',
};

/** Mapping from chain id to its token bucket. */
export const CRYPTO_CHAIN_TOKEN: Readonly<Record<CryptoChainId, CryptoToken>> = {
  'tron-usdt': 'USDT',
  'tron-usdc': 'USDC',
  'bsc-usdt': 'USDT',
  'bsc-usdc': 'USDC',
  'eth-usdt': 'USDT',
  'eth-usdc': 'USDC',
  'ton-usdt-jetton': 'USDT',
  'ton-usdc-jetton': 'USDC',
  'ton-native': 'native',
};

/**
 * Chain ids visible in the user-facing picker. Excludes 'ton-native' since
 * Wave 9.3 only ships stablecoin top-up (USDT/USDC). Existing 'ton-native'
 * invoices still flow through verifyTx + worker as long as their adapter
 * is registered.
 */
export const CRYPTO_PICKER_CHAIN_IDS: readonly CryptoChainId[] = [
  'tron-usdt',
  'tron-usdc',
  'bsc-usdt',
  'bsc-usdc',
  'eth-usdt',
  'eth-usdc',
  'ton-usdt-jetton',
  'ton-usdc-jetton',
] as const;

export type CryptoInvoiceStatus =
  | 'pending'
  | 'submitted'
  | 'confirming'
  | 'confirmed'
  | 'expired'
  | 'failed';

export interface CryptoInvoiceRow {
  id: number;
  user_id: number;
  chain: CryptoChainId;
  status: CryptoInvoiceStatus;
  /** Decimal string in human units (e.g. "10.500000"). */
  amount_unit: string;
  amount_decimals: number;
  amount_label: string;
  credits_to_grant: number;
  pay_to_address: string;
  memo: string | null;
  /**
   * Wave 9.2 — wallet-deeplink / QR-payable URI frozen at creation. NULL when
   * the chain has no standard scheme (the Mini App then renders a bare-address
   * QR and shows amount/memo as separate copy tiles).
   */
  payment_uri: string | null;
  tx_hash: string | null;
  from_address: string | null;
  confirmations: number;
  required_confirmations: number;
  paid_at: string | null;
  applied_at: string | null;
  ledger_tx_id: number | null;
  expires_at: string;
  last_polled_at: string | null;
  poll_count: number;
  failure_reason: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

/** Per-chain runtime configuration sourced from the settings table. */
export interface CryptoChainConfig {
  id: CryptoChainId;
  enabled: boolean;
  address: string;
  decimals: number;
  confirmations: number;
  /** Credits granted per 1 whole unit (e.g. 100 = 1 USDT → 100 credits). */
  rate: number;
  apiKey: string | null;
  memoSupported: boolean;
  label: string;
  /** Smallest invoice amount in whole units (e.g. "1.0" USDT). */
  minAmount: string;
  /** Largest invoice amount in whole units. */
  maxAmount: string;
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
