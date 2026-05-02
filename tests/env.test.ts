/**
 * Tests for the environment-config loader.
 *
 * Each test builds a full `validEnv` record and overrides the field under
 * test, so the suite double-checks both happy-path parsing and every
 * individual rejection rule. `resetConfigForTests()` runs before each test to
 * drop the memoized singleton in case another test (or import side-effect)
 * cached a Config instance.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, resetConfigForTests, type Config } from '../src/config/env.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';

function validEnv(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    APP_NAME: 'VaultLink Bot',
    APP_PUBLIC_URL: 'https://example.com',
    TELEGRAM_API_BASE_URL: 'https://api.telegram.org',
    TELEGRAM_DEEP_LINK_BASE: 'https://t.me',
    MAIN_BOT_TOKEN: '12345:abcdefghijklmnopqrstuvwxyz0123456',
    DATABASE_PATH: ':memory:',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    ADMIN_IDS: '111,222',
    DEFAULT_LOCALE: 'th',
    LOG_LEVEL: 'info',
    CODE_LENGTH: '12',
    MAX_FILE_SIZE_MB: '50',
    BLOCKED_EXTENSIONS: '.exe,.bat',
    UPLOAD_LIMIT_PER_HOUR: '20',
    DOWNLOAD_LIMIT_PER_HOUR: '100',
    ADD_BOT_LIMIT_PER_DAY: '5',
    REPORT_LIMIT_PER_HOUR: '10',
    AUTO_LOCK_REPORT_THRESHOLD: '3',
    DEFAULT_FILE_EXPIRY_DAYS: '0',
    BOT_POLLING_ALLOWED_UPDATES: 'message,callback_query',
    TELEGRAM_UPDATE_MODE: 'long_poll',
    WEBHOOK_BASE_URL: '',
    WEBHOOK_PORT: '8443',
    WEBHOOK_SECRET_TOKEN: '',
    ENABLE_PASSWORD_PROTECTION: 'true',
    ENABLE_FILE_EXPIRY: 'true',
    ENABLE_REPORTS: 'true',
    ENABLE_CHILD_BOTS: 'true',
    ENABLE_ADMIN_BROADCAST: 'false',
    HEALTH_SERVER_ENABLED: 'false',
    HEALTH_SERVER_HOST: '127.0.0.1',
    HEALTH_SERVER_PORT: '8080',
    ENABLE_MINI_APP: 'false',
    MINI_APP_URL: '',
    MINI_APP_API_BASE_URL: '',
    MINI_APP_ALLOWED_ORIGINS: '',
    MINI_APP_INITDATA_MAX_AGE_SECONDS: '86400',
    ENABLE_COLLECTIONS: 'true',
    COLLECTION_PAGE_SIZE: '10',
    COLLECTION_DRAFT_TTL_MINUTES: '60',
    COLLECTION_SEND_DELAY_MS: '700',
    MAX_COLLECTION_ITEMS: '100',
    MAX_BULK_SEND_ITEMS: '50',
    TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC: '30',
    TELEGRAM_PER_CHAT_RATE_LIMIT_PER_SEC: '1',
    TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN: '20',
    TELEGRAM_MEDIA_GROUP_MAX_ITEMS: '10',
    TELEGRAM_MESSAGE_MAX_LENGTH: '4096',
    TELEGRAM_INLINE_KEYBOARD_MAX_BUTTONS: '100',
    TELEGRAM_INLINE_KEYBOARD_MAX_ROW_WIDTH: '8',
    TELEGRAM_CALLBACK_DATA_MAX_BYTES: '64',
    TELEGRAM_LONG_POLL_TIMEOUT_SECONDS: '50',
    TELEGRAM_AUTORETRY_MAX_ATTEMPTS: '5',
    TELEGRAM_AUTORETRY_MAX_DELAY_SECONDS: '60',
    RUNNER_CONCURRENCY: '200',
    CHILD_BOT_MAX_PARALLEL_STARTS: '16',
    BROADCAST_DELAY_MS: '50',
    ...overrides,
  };
}

function expectAppError(fn: () => unknown, code: ErrorCode): AppError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).code).toBe(code);
  return caught as AppError;
}

beforeEach(() => {
  resetConfigForTests();
});

describe('loadConfig — happy path', () => {
  it('returns a frozen Config with parsed values', () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.MAIN_BOT_TOKEN).toBe('12345:abcdefghijklmnopqrstuvwxyz0123456');
    expect(Buffer.isBuffer(cfg.TOKEN_ENCRYPTION_KEY)).toBe(true);
    expect(cfg.TOKEN_ENCRYPTION_KEY.length).toBe(32);
    expect(Object.isFrozen(cfg)).toBe(true);
  });

  it('parses CSV fields into normalized arrays', () => {
    const cfg = loadConfig(validEnv({ BLOCKED_EXTENSIONS: '.exe,bat' }));
    expect(cfg.BLOCKED_EXTENSIONS).toEqual(['.exe', '.bat']);
  });

  it('parses ADMIN_IDS into a list of numeric strings', () => {
    const cfg = loadConfig(validEnv());
    expect(cfg.ADMIN_IDS).toEqual(['111', '222']);
  });

  it('cannot be mutated (frozen object rejects assignment in strict mode)', () => {
    const cfg = loadConfig(validEnv());
    expect(() => {
      (cfg as unknown as { MAIN_BOT_TOKEN: string }).MAIN_BOT_TOKEN = 'x';
    }).toThrow(TypeError);
  });
});

describe('loadConfig — secret redaction', () => {
  it('redacts MAIN_BOT_TOKEN raw value when invalid', () => {
    const env = validEnv({ MAIN_BOT_TOKEN: 'totally-bogus-token' });
    const err = expectAppError(() => loadConfig(env), ErrorCode.CONFIG_INVALID);
    expect(err.message).toContain('<redacted>');
    expect(err.message).not.toContain('totally-bogus-token');
  });

  it('throws CONFIG_INVALID when MAIN_BOT_TOKEN is missing', () => {
    const env = validEnv();
    delete (env as Record<string, string | undefined>).MAIN_BOT_TOKEN;
    const err = expectAppError(() => loadConfig(env), ErrorCode.CONFIG_INVALID);
    // No raw token to leak in the missing case, but the message must not
    // accidentally embed the placeholder pattern as a real value.
    expect(err.message).toContain('MAIN_BOT_TOKEN');
  });
});

describe('loadConfig — encryption key', () => {
  it('rejects a 24-byte key with a clear length-mismatch message', () => {
    const env = validEnv({ TOKEN_ENCRYPTION_KEY: Buffer.alloc(24, 1).toString('base64') });
    const err = expectAppError(() => loadConfig(env), ErrorCode.CONFIG_INVALID);
    expect(err.message).toContain('must decode to exactly 32 bytes');
  });
});

describe('loadConfig — admin ids', () => {
  it('throws when ADMIN_IDS is empty', () => {
    expectAppError(() => loadConfig(validEnv({ ADMIN_IDS: '' })), ErrorCode.CONFIG_INVALID);
  });

  it('throws when ADMIN_IDS contains non-numeric entries', () => {
    expectAppError(() => loadConfig(validEnv({ ADMIN_IDS: 'abc' })), ErrorCode.CONFIG_INVALID);
  });
});

describe('loadConfig — boolean flags', () => {
  it('throws when a feature flag is not a recognized boolean', () => {
    expectAppError(
      () => loadConfig(validEnv({ ENABLE_REPORTS: 'maybe' })),
      ErrorCode.CONFIG_INVALID,
    );
  });
});

describe('loadConfig — Config typing sanity', () => {
  it('produces a Config compatible with type assertions', () => {
    const cfg: Config = loadConfig(validEnv());
    expect(cfg.NODE_ENV).toBe('test');
    expect(cfg.DEFAULT_LOCALE).toBe('th');
    expect(cfg.HEALTH_SERVER_PORT).toBe(8080);
  });
});
