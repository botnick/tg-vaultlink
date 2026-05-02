/**
 * VaultLink Bot — environment loader.
 *
 * Single source of truth for every runtime tunable. Values are read from
 * `process.env` only; the runtime is expected to populate it via Node 20's
 * built-in `--env-file=.env` flag (wired through the package.json scripts).
 * No `.env` is auto-loaded here so that test runners can supply their own.
 *
 * The exported {@link Config} object is deep-frozen and validated with zod.
 * Anything missing or malformed throws an {@link AppError} carrying the full
 * issue list — secret fields are replaced with `<redacted>` before they ever
 * reach an error message.
 */

import { z } from 'zod';
import type { Locale, LogLevel, NodeEnv } from '../types/index.js';
import { AppError, ErrorCode } from '../utils/errors.js';
import { ENCRYPTION_KEY_BYTES } from './constants.js';

/** Field names whose raw values must never appear in an error message. */
const SECRET_FIELDS = new Set<string>(['MAIN_BOT_TOKEN', 'TOKEN_ENCRYPTION_KEY']);

const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
const TELEGRAM_USER_ID_RE = /^\d+$/;
const ALLOWED_UPDATE_TYPES = new Set<string>([
  'message',
  'callback_query',
  'edited_message',
  'inline_query',
  'chosen_inline_result',
]);

/* ------------------------------------------------------------------------- *
 * Coercion helpers
 * ------------------------------------------------------------------------- */

const trimmed = (s: unknown): string => (typeof s === 'string' ? s.trim() : String(s ?? '').trim());

const boolFromString = z
  .string()
  .transform((raw, ctx) => {
    const v = raw.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be "true" or "false"' });
    return z.NEVER;
  });

const intFromString = (opts: { min?: number; max?: number } = {}) =>
  z
    .string()
    .transform((raw, ctx) => {
      const v = raw.trim();
      if (!/^-?\d+$/.test(v)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be an integer' });
        return z.NEVER;
      }
      const n = Number.parseInt(v, 10);
      if (!Number.isSafeInteger(n)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'integer out of safe range' });
        return z.NEVER;
      }
      const min = opts.min ?? 0;
      if (n < min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be >= ${min}` });
        return z.NEVER;
      }
      if (opts.max !== undefined && n > opts.max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must be <= ${opts.max}` });
        return z.NEVER;
      }
      return n;
    });

const csvList = (opts: { lowercase?: boolean; minItems?: number } = {}) =>
  z
    .string()
    .transform((raw, ctx) => {
      const items = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => (opts.lowercase ? s.toLowerCase() : s));
      const min = opts.minItems ?? 0;
      if (items.length < min) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `must contain at least ${min} item(s)` });
        return z.NEVER;
      }
      return items;
    });

const httpUrlNoTrailingSlash = z
  .string()
  .transform((raw, ctx) => {
    const v = raw.trim();
    let parsed: URL;
    try {
      parsed = new URL(v);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a valid URL' });
      return z.NEVER;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must use http(s)' });
      return z.NEVER;
    }
    return v.replace(/\/+$/, '');
  });

const base64Buffer = (expectedBytes: number) =>
  z
    .string()
    .transform((raw, ctx) => {
      const v = raw.trim();
      if (v.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must not be empty' });
        return z.NEVER;
      }
      // Accept standard and url-safe base64; pad if needed.
      const normalized = v.replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(padded)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be valid base64' });
        return z.NEVER;
      }
      const buf = Buffer.from(padded, 'base64');
      if (buf.length !== expectedBytes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must decode to exactly ${expectedBytes} bytes (got ${buf.length})`,
        });
        return z.NEVER;
      }
      return buf;
    });

/* ------------------------------------------------------------------------- *
 * Schema
 * ------------------------------------------------------------------------- */

const nonEmpty = (label: string) =>
  z.string().transform((s, ctx) => {
    const v = trimmed(s);
    if (v.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must not be empty` });
      return z.NEVER;
    }
    return v;
  });

const telegramToken = z
  .string()
  .transform((s, ctx) => {
    const v = trimmed(s);
    if (v.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must not be empty' });
      return z.NEVER;
    }
    if (!TELEGRAM_TOKEN_RE.test(v)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'malformed Telegram bot token' });
      return z.NEVER;
    }
    return v;
  });

const adminIds = z
  .string()
  .transform((raw, ctx) => {
    const items = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must contain at least one Telegram user ID' });
      return z.NEVER;
    }
    for (const id of items) {
      if (!TELEGRAM_USER_ID_RE.test(id)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `"${id}" is not a numeric Telegram user ID` });
        return z.NEVER;
      }
    }
    return items as readonly string[];
  });

const blockedExtensions = z
  .string()
  .transform((raw) => {
    const items = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => s.toLowerCase())
      .map((s) => (s.startsWith('.') ? s : `.${s}`));
    return items as readonly string[];
  });

const allowedUpdates = z
  .string()
  .transform((raw, ctx) => {
    const items = raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (items.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must list at least one update type' });
      return z.NEVER;
    }
    for (const it of items) {
      if (!ALLOWED_UPDATE_TYPES.has(it)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `"${it}" is not a supported update type (allowed: ${[...ALLOWED_UPDATE_TYPES].join(', ')})`,
        });
        return z.NEVER;
      }
    }
    return items as readonly string[];
  });

const nodeEnv = z.enum(['development', 'production', 'test']);
const locale = z.enum(['th', 'en']);
const logLevel = z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']);

const baseSchema = z.object({
  NODE_ENV: nodeEnv,
  APP_NAME: nonEmpty('APP_NAME'),
  APP_PUBLIC_URL: httpUrlNoTrailingSlash,
  TELEGRAM_API_BASE_URL: httpUrlNoTrailingSlash,
  TELEGRAM_DEEP_LINK_BASE: httpUrlNoTrailingSlash,
  MAIN_BOT_TOKEN: telegramToken,
  DATABASE_PATH: nonEmpty('DATABASE_PATH'),
  TOKEN_ENCRYPTION_KEY: base64Buffer(ENCRYPTION_KEY_BYTES),
  ADMIN_IDS: adminIds,
  DEFAULT_LOCALE: locale,
  LOG_LEVEL: logLevel,

  // Numeric tunables (upper bounds chosen to fence off obvious typos).
  CODE_LENGTH: intFromString({ min: 4, max: 32 }),
  MAX_FILE_SIZE_MB: intFromString({ min: 1, max: 4096 }),
  BLOCKED_EXTENSIONS: blockedExtensions,
  UPLOAD_LIMIT_PER_HOUR: intFromString({ min: 0, max: 1_000_000 }),
  DOWNLOAD_LIMIT_PER_HOUR: intFromString({ min: 0, max: 1_000_000 }),
  ADD_BOT_LIMIT_PER_DAY: intFromString({ min: 0, max: 100_000 }),
  REPORT_LIMIT_PER_HOUR: intFromString({ min: 0, max: 1_000_000 }),
  AUTO_LOCK_REPORT_THRESHOLD: intFromString({ min: 1, max: 1_000_000 }),
  DEFAULT_FILE_EXPIRY_DAYS: intFromString({ min: 0, max: 36_500 }),

  BOT_POLLING_ALLOWED_UPDATES: allowedUpdates,

  ENABLE_PASSWORD_PROTECTION: boolFromString,
  ENABLE_FILE_EXPIRY: boolFromString,
  ENABLE_REPORTS: boolFromString,
  ENABLE_CHILD_BOTS: boolFromString,
  ENABLE_ADMIN_BROADCAST: boolFromString,

  HEALTH_SERVER_ENABLED: boolFromString,
  HEALTH_SERVER_HOST: nonEmpty('HEALTH_SERVER_HOST'),
  HEALTH_SERVER_PORT: intFromString({ min: 0, max: 65_535 }),

  // Mini App (Telegram WebApp) — when enabled, the HTTP API server starts and
  // bot commands like /dashboard, /files, /bots, /admin_dashboard expose a
  // WebAppInfo button. Auth is Telegram initData HMAC; never browser cookies.
  ENABLE_MINI_APP: boolFromString,
  MINI_APP_URL: z.string().transform((s) => s.trim()),
  MINI_APP_API_BASE_URL: z.string().transform((s) => s.trim()),
  MINI_APP_ALLOWED_ORIGINS: z
    .string()
    .transform((raw) => {
      const items = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return items as readonly string[];
    }),
  MINI_APP_INITDATA_MAX_AGE_SECONDS: intFromString({ min: 60, max: 30 * 24 * 60 * 60 }),

  // Collections / media bundles. A share code can resolve to either a single
  // file or a collection of many media items.
  ENABLE_COLLECTIONS: boolFromString,
  COLLECTION_PAGE_SIZE: intFromString({ min: 1, max: 100 }),
  COLLECTION_DRAFT_TTL_MINUTES: intFromString({ min: 1, max: 24 * 60 }),
  COLLECTION_SEND_DELAY_MS: intFromString({ min: 0, max: 10_000 }),
  MAX_COLLECTION_ITEMS: intFromString({ min: 1, max: 10_000 }),
  MAX_BULK_SEND_ITEMS: intFromString({ min: 1, max: 1_000 }),

  // Telegram limits — surfaced as env knobs so operators can re-tune when
  // Telegram changes the rules without code changes. Defaults reflect the
  // current Telegram Bot API documented limits.
  TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC: intFromString({ min: 1, max: 1000 }),
  TELEGRAM_PER_CHAT_RATE_LIMIT_PER_SEC: intFromString({ min: 1, max: 100 }),
  TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN: intFromString({ min: 1, max: 600 }),
  TELEGRAM_MEDIA_GROUP_MAX_ITEMS: intFromString({ min: 2, max: 10 }),
  TELEGRAM_MESSAGE_MAX_LENGTH: intFromString({ min: 1, max: 4096 }),
  TELEGRAM_INLINE_KEYBOARD_MAX_BUTTONS: intFromString({ min: 1, max: 100 }),
  TELEGRAM_INLINE_KEYBOARD_MAX_ROW_WIDTH: intFromString({ min: 1, max: 8 }),
  TELEGRAM_CALLBACK_DATA_MAX_BYTES: intFromString({ min: 1, max: 64 }),
  TELEGRAM_LONG_POLL_TIMEOUT_SECONDS: intFromString({ min: 1, max: 50 }),
  TELEGRAM_AUTORETRY_MAX_ATTEMPTS: intFromString({ min: 0, max: 10 }),
  TELEGRAM_AUTORETRY_MAX_DELAY_SECONDS: intFromString({ min: 0, max: 600 }),
  RUNNER_CONCURRENCY: intFromString({ min: 1, max: 10_000 }),
  CHILD_BOT_MAX_PARALLEL_STARTS: intFromString({ min: 1, max: 256 }),
  BROADCAST_DELAY_MS: intFromString({ min: 0, max: 10_000 }),
});

const schema = baseSchema.superRefine((parsed, ctx) => {
  if (parsed.ENABLE_MINI_APP) {
    const isUrl = (v: string) => {
      if (!v) return false;
      try {
        const u = new URL(v);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch {
        return false;
      }
    };
    if (!isUrl(parsed.MINI_APP_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MINI_APP_URL'],
        message: 'must be a valid http(s) URL when ENABLE_MINI_APP=true',
      });
    }
    if (!isUrl(parsed.MINI_APP_API_BASE_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MINI_APP_API_BASE_URL'],
        message: 'must be a valid http(s) URL when ENABLE_MINI_APP=true',
      });
    }
    if (parsed.MINI_APP_ALLOWED_ORIGINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MINI_APP_ALLOWED_ORIGINS'],
        message: 'must list at least one origin when ENABLE_MINI_APP=true',
      });
    }
  }
});

/* ------------------------------------------------------------------------- *
 * Public API
 * ------------------------------------------------------------------------- */

export interface Config {
  NODE_ENV: NodeEnv;
  APP_NAME: string;
  APP_PUBLIC_URL: string;
  TELEGRAM_API_BASE_URL: string;
  TELEGRAM_DEEP_LINK_BASE: string;
  MAIN_BOT_TOKEN: string;
  DATABASE_PATH: string;
  TOKEN_ENCRYPTION_KEY: Buffer;
  ADMIN_IDS: readonly string[];
  DEFAULT_LOCALE: Locale;
  LOG_LEVEL: LogLevel;
  CODE_LENGTH: number;
  MAX_FILE_SIZE_MB: number;
  BLOCKED_EXTENSIONS: readonly string[];
  UPLOAD_LIMIT_PER_HOUR: number;
  DOWNLOAD_LIMIT_PER_HOUR: number;
  ADD_BOT_LIMIT_PER_DAY: number;
  REPORT_LIMIT_PER_HOUR: number;
  AUTO_LOCK_REPORT_THRESHOLD: number;
  DEFAULT_FILE_EXPIRY_DAYS: number;
  BOT_POLLING_ALLOWED_UPDATES: readonly string[];
  ENABLE_PASSWORD_PROTECTION: boolean;
  ENABLE_FILE_EXPIRY: boolean;
  ENABLE_REPORTS: boolean;
  ENABLE_CHILD_BOTS: boolean;
  ENABLE_ADMIN_BROADCAST: boolean;
  HEALTH_SERVER_ENABLED: boolean;
  HEALTH_SERVER_HOST: string;
  HEALTH_SERVER_PORT: number;
  ENABLE_MINI_APP: boolean;
  MINI_APP_URL: string;
  MINI_APP_API_BASE_URL: string;
  MINI_APP_ALLOWED_ORIGINS: readonly string[];
  MINI_APP_INITDATA_MAX_AGE_SECONDS: number;
  ENABLE_COLLECTIONS: boolean;
  COLLECTION_PAGE_SIZE: number;
  COLLECTION_DRAFT_TTL_MINUTES: number;
  COLLECTION_SEND_DELAY_MS: number;
  MAX_COLLECTION_ITEMS: number;
  MAX_BULK_SEND_ITEMS: number;
  TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC: number;
  TELEGRAM_PER_CHAT_RATE_LIMIT_PER_SEC: number;
  TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN: number;
  TELEGRAM_MEDIA_GROUP_MAX_ITEMS: number;
  TELEGRAM_MESSAGE_MAX_LENGTH: number;
  TELEGRAM_INLINE_KEYBOARD_MAX_BUTTONS: number;
  TELEGRAM_INLINE_KEYBOARD_MAX_ROW_WIDTH: number;
  TELEGRAM_CALLBACK_DATA_MAX_BYTES: number;
  TELEGRAM_LONG_POLL_TIMEOUT_SECONDS: number;
  TELEGRAM_AUTORETRY_MAX_ATTEMPTS: number;
  TELEGRAM_AUTORETRY_MAX_DELAY_SECONDS: number;
  RUNNER_CONCURRENCY: number;
  CHILD_BOT_MAX_PARALLEL_STARTS: number;
  BROADCAST_DELAY_MS: number;
}

/**
 * Parse `env` (defaulting to `process.env`) against the schema and return a
 * deep-frozen, fully-typed {@link Config}. Throws an {@link AppError} carrying
 * `ErrorCode.CONFIG_INVALID` on any validation failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // Pull only the keys we know about so unrelated env vars don't widen the input.
  const input: Record<string, string | undefined> = {};
  for (const key of Object.keys(baseSchema.shape) as Array<keyof typeof baseSchema.shape>) {
    input[key as string] = env[key as string];
  }

  const result = schema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((iss) => {
      const path = iss.path.join('.') || '<root>';
      const isSecret = iss.path.length === 1 && SECRET_FIELDS.has(String(iss.path[0]));
      const rawVal = iss.path.length === 1 ? input[String(iss.path[0])] : undefined;
      const valueRepr = isSecret
        ? '<redacted>'
        : rawVal === undefined
          ? '<missing>'
          : JSON.stringify(rawVal);
      return { path, message: iss.message, value: valueRepr };
    });

    const summary = issues.map((i) => `  - ${i.path}: ${i.message} (got: ${i.value})`).join('\n');
    throw new AppError(
      ErrorCode.CONFIG_INVALID,
      `Invalid environment configuration:\n${summary}`,
      { meta: { issues } },
    );
  }

  const parsed = result.data;
  const cfg: Config = {
    NODE_ENV: parsed.NODE_ENV,
    APP_NAME: parsed.APP_NAME,
    APP_PUBLIC_URL: parsed.APP_PUBLIC_URL,
    TELEGRAM_API_BASE_URL: parsed.TELEGRAM_API_BASE_URL,
    TELEGRAM_DEEP_LINK_BASE: parsed.TELEGRAM_DEEP_LINK_BASE,
    MAIN_BOT_TOKEN: parsed.MAIN_BOT_TOKEN,
    DATABASE_PATH: parsed.DATABASE_PATH,
    TOKEN_ENCRYPTION_KEY: parsed.TOKEN_ENCRYPTION_KEY,
    ADMIN_IDS: Object.freeze([...parsed.ADMIN_IDS]) as readonly string[],
    DEFAULT_LOCALE: parsed.DEFAULT_LOCALE,
    LOG_LEVEL: parsed.LOG_LEVEL,
    CODE_LENGTH: parsed.CODE_LENGTH,
    MAX_FILE_SIZE_MB: parsed.MAX_FILE_SIZE_MB,
    BLOCKED_EXTENSIONS: Object.freeze([...parsed.BLOCKED_EXTENSIONS]) as readonly string[],
    UPLOAD_LIMIT_PER_HOUR: parsed.UPLOAD_LIMIT_PER_HOUR,
    DOWNLOAD_LIMIT_PER_HOUR: parsed.DOWNLOAD_LIMIT_PER_HOUR,
    ADD_BOT_LIMIT_PER_DAY: parsed.ADD_BOT_LIMIT_PER_DAY,
    REPORT_LIMIT_PER_HOUR: parsed.REPORT_LIMIT_PER_HOUR,
    AUTO_LOCK_REPORT_THRESHOLD: parsed.AUTO_LOCK_REPORT_THRESHOLD,
    DEFAULT_FILE_EXPIRY_DAYS: parsed.DEFAULT_FILE_EXPIRY_DAYS,
    BOT_POLLING_ALLOWED_UPDATES: Object.freeze([...parsed.BOT_POLLING_ALLOWED_UPDATES]) as readonly string[],
    ENABLE_PASSWORD_PROTECTION: parsed.ENABLE_PASSWORD_PROTECTION,
    ENABLE_FILE_EXPIRY: parsed.ENABLE_FILE_EXPIRY,
    ENABLE_REPORTS: parsed.ENABLE_REPORTS,
    ENABLE_CHILD_BOTS: parsed.ENABLE_CHILD_BOTS,
    ENABLE_ADMIN_BROADCAST: parsed.ENABLE_ADMIN_BROADCAST,
    HEALTH_SERVER_ENABLED: parsed.HEALTH_SERVER_ENABLED,
    HEALTH_SERVER_HOST: parsed.HEALTH_SERVER_HOST,
    HEALTH_SERVER_PORT: parsed.HEALTH_SERVER_PORT,
    ENABLE_MINI_APP: parsed.ENABLE_MINI_APP,
    MINI_APP_URL: parsed.MINI_APP_URL,
    MINI_APP_API_BASE_URL: parsed.MINI_APP_API_BASE_URL,
    MINI_APP_ALLOWED_ORIGINS: Object.freeze([...parsed.MINI_APP_ALLOWED_ORIGINS]) as readonly string[],
    MINI_APP_INITDATA_MAX_AGE_SECONDS: parsed.MINI_APP_INITDATA_MAX_AGE_SECONDS,
    ENABLE_COLLECTIONS: parsed.ENABLE_COLLECTIONS,
    COLLECTION_PAGE_SIZE: parsed.COLLECTION_PAGE_SIZE,
    COLLECTION_DRAFT_TTL_MINUTES: parsed.COLLECTION_DRAFT_TTL_MINUTES,
    COLLECTION_SEND_DELAY_MS: parsed.COLLECTION_SEND_DELAY_MS,
    MAX_COLLECTION_ITEMS: parsed.MAX_COLLECTION_ITEMS,
    MAX_BULK_SEND_ITEMS: parsed.MAX_BULK_SEND_ITEMS,
    TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC: parsed.TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC,
    TELEGRAM_PER_CHAT_RATE_LIMIT_PER_SEC: parsed.TELEGRAM_PER_CHAT_RATE_LIMIT_PER_SEC,
    TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN: parsed.TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN,
    TELEGRAM_MEDIA_GROUP_MAX_ITEMS: parsed.TELEGRAM_MEDIA_GROUP_MAX_ITEMS,
    TELEGRAM_MESSAGE_MAX_LENGTH: parsed.TELEGRAM_MESSAGE_MAX_LENGTH,
    TELEGRAM_INLINE_KEYBOARD_MAX_BUTTONS: parsed.TELEGRAM_INLINE_KEYBOARD_MAX_BUTTONS,
    TELEGRAM_INLINE_KEYBOARD_MAX_ROW_WIDTH: parsed.TELEGRAM_INLINE_KEYBOARD_MAX_ROW_WIDTH,
    TELEGRAM_CALLBACK_DATA_MAX_BYTES: parsed.TELEGRAM_CALLBACK_DATA_MAX_BYTES,
    TELEGRAM_LONG_POLL_TIMEOUT_SECONDS: parsed.TELEGRAM_LONG_POLL_TIMEOUT_SECONDS,
    TELEGRAM_AUTORETRY_MAX_ATTEMPTS: parsed.TELEGRAM_AUTORETRY_MAX_ATTEMPTS,
    TELEGRAM_AUTORETRY_MAX_DELAY_SECONDS: parsed.TELEGRAM_AUTORETRY_MAX_DELAY_SECONDS,
    RUNNER_CONCURRENCY: parsed.RUNNER_CONCURRENCY,
    CHILD_BOT_MAX_PARALLEL_STARTS: parsed.CHILD_BOT_MAX_PARALLEL_STARTS,
    BROADCAST_DELAY_MS: parsed.BROADCAST_DELAY_MS,
  };

  return Object.freeze(cfg);
}

let cached: Config | undefined;

/** Lazily load and memoize the configuration. */
export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

/**
 * Test-only hook that drops the cached singleton so the next {@link getConfig}
 * call re-runs validation against the (possibly mutated) `process.env`.
 */
export function resetConfigForTests(): void {
  cached = undefined;
}
