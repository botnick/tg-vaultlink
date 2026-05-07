/**
 * VaultLink Bot — internal constants.
 *
 * Values defined here are NOT user-configurable: they describe invariants of
 * the system (encoding alphabets, token regexes, AES-GCM byte sizes, message
 * length caps) rather than tunable knobs. Anything operators may reasonably
 * want to override at runtime lives in `env.ts` instead.
 */

/**
 * Crockford-style alphabet for short share codes. Excludes `0`, `1`, `I`, `L`,
 * `O` to remove human/OCR ambiguity. Exactly 32 symbols so each character
 * encodes 5 bits of entropy.
 */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Telegram bot token format: `<bot_id>:<auth_part>`. */
export const TELEGRAM_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{30,}$/;

/** Telegram numeric user IDs. */
export const TELEGRAM_USER_ID_REGEX = /^\d+$/;

/**
 * Telegram bot username rule: 5–32 chars, starts with a letter, ends with
 * `bot`/`Bot`/`BOT` (case-insensitive). The capture is greedy on the leading
 * segment to allow the trailing suffix to be checked.
 */
export const TELEGRAM_BOT_USERNAME_REGEX = /^[A-Za-z][A-Za-z0-9_]{2,28}[Bb][Oo][Tt]$/;

export const SUPPORTED_LOCALES = ['th', 'en'] as const;

/**
 * Sliding-window durations (milliseconds) used by the rate limiter table. Keys
 * mirror the `scope` column values stored in `rate_limits`.
 */
export const RATE_LIMIT_WINDOWS = {
  upload: 60 * 60 * 1000,
  download: 60 * 60 * 1000,
  add_bot: 24 * 60 * 60 * 1000,
  report: 60 * 60 * 1000,
  // Wave 9.3 — crypto invoice creation. 1-minute window so a misbehaving
  // client gets unblocked quickly while still preventing enumeration.
  crypto_invoice: 60 * 1000,
} as const;

/** AES-256-GCM parameters for encrypting child-bot tokens at rest. */
export const ENCRYPTION_KEY_BYTES = 32;
export const NONCE_BYTES = 12;
export const AUTH_TAG_BYTES = 16;

/** Bounds for optional file passwords (Argon2id-hashed at rest). */
export const PASSWORD_MIN_LENGTH = 4;
export const PASSWORD_MAX_LENGTH = 128;

/** Bound for free-form report reasons stored on the `reports` row. */
export const REPORT_REASON_MAX_LENGTH = 500;

/**
 * Allowed values for `reports.reason_category`. The DB column has no CHECK
 * constraint (see migration 010) so the application layer is the single
 * source of truth for the enum: any value submitted from the bot or Mini App
 * is normalized through this list, falling back to `'other'`.
 */
export const REPORT_REASON_CATEGORIES = [
  'spam',
  'illegal',
  'copyright',
  'malware',
  'scam',
  'other',
] as const;
export type ReportReasonCategory = (typeof REPORT_REASON_CATEGORIES)[number];

export function normalizeReportReasonCategory(input: unknown): ReportReasonCategory {
  if (typeof input !== 'string') return 'other';
  const lowered = input.trim().toLowerCase();
  return (REPORT_REASON_CATEGORIES as readonly string[]).includes(lowered)
    ? (lowered as ReportReasonCategory)
    : 'other';
}

/** Telegram-imposed caption ceiling. */
export const CAPTION_MAX_LENGTH = 1024;

/** Maximum stored `file_name`. Telegram itself allows 256 bytes. */
export const FILENAME_MAX_LENGTH = 256;

/** Path segment under `data/` and table name used by the migration runner. */
export const MIGRATIONS_DIR_NAME = 'migrations';
export const SCHEMA_MIGRATIONS_TABLE = 'schema_migrations';
