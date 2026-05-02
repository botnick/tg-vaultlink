/**
 * Tests for `rateLimit.service` — exercises the decision logic against an
 * in-memory fake repository that mirrors the contract specified for the real
 * SQLite-backed implementation: `hit()` increments a (scope, key) counter,
 * resetting it whenever the current time has crossed the previous window
 * boundary. The fake lets us drive synthetic clocks deterministically without
 * touching the database.
 */

import { describe, it, expect, vi } from 'vitest';
import type { Config } from '../src/config/env.js';
import type { RateLimitRow } from '../src/types/index.js';
import { RATE_LIMIT_WINDOWS } from '../src/config/constants.js';
import {
  RateLimitService,
  type IRateLimitRepository,
} from '../src/services/rateLimit.service.js';

/* ------------------------------------------------------------------ helpers */

function validConfig(overrides: Partial<Config> = {}): Config {
  const base: Config = {
    NODE_ENV: 'test',
    APP_NAME: 'vaultlink-bot',
    APP_PUBLIC_URL: 'https://example.test',
    TELEGRAM_API_BASE_URL: 'https://api.telegram.org',
    TELEGRAM_DEEP_LINK_BASE: 'https://t.me',
    MAIN_BOT_TOKEN: '123456:AAAA-test-token-AAAA-test-token-AAAA',
    DATABASE_PATH: ':memory:',
    TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 0),
    ADMIN_IDS: ['111'] as readonly string[],
    DEFAULT_LOCALE: 'en',
    LOG_LEVEL: 'info',
    CODE_LENGTH: 8,
    MAX_FILE_SIZE_MB: 50,
    BLOCKED_EXTENSIONS: [] as readonly string[],
    UPLOAD_LIMIT_PER_HOUR: 5,
    DOWNLOAD_LIMIT_PER_HOUR: 10,
    ADD_BOT_LIMIT_PER_DAY: 3,
    REPORT_LIMIT_PER_HOUR: 5,
    AUTO_LOCK_REPORT_THRESHOLD: 3,
    DEFAULT_FILE_EXPIRY_DAYS: 30,
    BOT_POLLING_ALLOWED_UPDATES: ['message', 'callback_query'] as readonly string[],
    ENABLE_PASSWORD_PROTECTION: true,
    ENABLE_FILE_EXPIRY: true,
    ENABLE_REPORTS: true,
    ENABLE_CHILD_BOTS: true,
    ENABLE_ADMIN_BROADCAST: true,
    HEALTH_SERVER_ENABLED: false,
    HEALTH_SERVER_HOST: '127.0.0.1',
    HEALTH_SERVER_PORT: 0,
    ENABLE_MINI_APP: false,
    MINI_APP_URL: '',
    MINI_APP_API_BASE_URL: '',
    MINI_APP_ALLOWED_ORIGINS: [] as readonly string[],
    MINI_APP_INITDATA_MAX_AGE_SECONDS: 86400,
    ENABLE_COLLECTIONS: true,
    COLLECTION_PAGE_SIZE: 10,
    COLLECTION_DRAFT_TTL_MINUTES: 60,
    COLLECTION_SEND_DELAY_MS: 700,
    MAX_COLLECTION_ITEMS: 100,
    MAX_BULK_SEND_ITEMS: 50,
    TELEGRAM_GLOBAL_RATE_LIMIT_PER_SEC: 30,
    TELEGRAM_PER_CHAT_RATE_LIMIT_PER_SEC: 1,
    TELEGRAM_PER_GROUP_RATE_LIMIT_PER_MIN: 20,
    TELEGRAM_MEDIA_GROUP_MAX_ITEMS: 10,
    TELEGRAM_MESSAGE_MAX_LENGTH: 4096,
    TELEGRAM_INLINE_KEYBOARD_MAX_BUTTONS: 100,
    TELEGRAM_INLINE_KEYBOARD_MAX_ROW_WIDTH: 8,
    TELEGRAM_CALLBACK_DATA_MAX_BYTES: 64,
    TELEGRAM_LONG_POLL_TIMEOUT_SECONDS: 50,
    TELEGRAM_AUTORETRY_MAX_ATTEMPTS: 5,
    TELEGRAM_AUTORETRY_MAX_DELAY_SECONDS: 60,
    RUNNER_CONCURRENCY: 200,
    CHILD_BOT_MAX_PARALLEL_STARTS: 16,
    BROADCAST_DELAY_MS: 50,
  };
  return { ...base, ...overrides } as Config;
}

interface FakeState {
  count: number;
  windowStart: Date;
}

/**
 * In-memory repository fake. `hit()` follows the documented contract:
 * - on first hit, or once `now >= windowStart + windowMs`, reset to count=1
 *   and report `newWindow: true`,
 * - otherwise increment count and report `newWindow: false`.
 */
function makeFakeRepo(): IRateLimitRepository & {
  state: Map<string, FakeState>;
  hit: ReturnType<typeof vi.fn>;
} {
  const state = new Map<string, FakeState>();
  const hit = vi.fn(
    (scope: string, key: string, windowMs: number, now?: Date) => {
      const composite = `${scope}|${key}`;
      const ts = now ?? new Date();
      const prev = state.get(composite);
      let newWindow = false;
      let nextCount: number;
      let nextStart: Date;
      if (!prev || ts.getTime() >= prev.windowStart.getTime() + windowMs) {
        nextCount = 1;
        nextStart = ts;
        newWindow = true;
      } else {
        nextCount = prev.count + 1;
        nextStart = prev.windowStart;
      }
      state.set(composite, { count: nextCount, windowStart: nextStart });
      const row: RateLimitRow = {
        id: 1,
        scope,
        key,
        count: nextCount,
        window_start: nextStart.toISOString(),
      };
      return { row, newWindow };
    },
  );
  const reset = vi.fn((scope: string, key: string) => {
    state.delete(`${scope}|${key}`);
  });
  return { state, hit, reset } as unknown as IRateLimitRepository & {
    state: Map<string, FakeState>;
    hit: ReturnType<typeof vi.fn>;
  };
}

/* -------------------------------------------------------------------- specs */

describe('rateLimit.service', () => {
  it('allows hits up to the configured limit', () => {
    const repo = makeFakeRepo();
    const svc = new RateLimitService(repo, validConfig({ UPLOAD_LIMIT_PER_HOUR: 3 }));
    const t0 = new Date('2026-01-01T00:00:00.000Z');

    const r1 = svc.check('upload', '111', t0);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
    expect(r1.retryAt).toBeNull();

    const r2 = svc.check('upload', '111', t0);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = svc.check('upload', '111', t0);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it('blocks the call that exceeds the limit and reports retryAt', () => {
    const repo = makeFakeRepo();
    const svc = new RateLimitService(repo, validConfig({ UPLOAD_LIMIT_PER_HOUR: 2 }));
    const t0 = new Date('2026-01-01T00:00:00.000Z');

    svc.check('upload', '111', t0);
    svc.check('upload', '111', t0);
    const blocked = svc.check('upload', '111', t0);

    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAt).not.toBeNull();
    expect(blocked.retryAt!.getTime()).toBe(t0.getTime() + RATE_LIMIT_WINDOWS.upload);
    expect(blocked.scope).toBe('upload');
    expect(blocked.key).toBe('111');
  });

  it('resets the counter after the window elapses', () => {
    const repo = makeFakeRepo();
    const svc = new RateLimitService(repo, validConfig({ UPLOAD_LIMIT_PER_HOUR: 1 }));
    const t0 = new Date('2026-01-01T00:00:00.000Z');

    const first = svc.check('upload', '222', t0);
    expect(first.allowed).toBe(true);

    const second = svc.check('upload', '222', t0);
    expect(second.allowed).toBe(false);

    const tNext = new Date(t0.getTime() + RATE_LIMIT_WINDOWS.upload + 1);
    const third = svc.check('upload', '222', tNext);
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);
    expect(third.retryAt).toBeNull();
  });

  it('short-circuits when the configured limit is 0 (admin-disabled scope)', () => {
    const repo = makeFakeRepo();
    const svc = new RateLimitService(repo, validConfig({ DOWNLOAD_LIMIT_PER_HOUR: 0 }));

    const decision = svc.check('download', '333');

    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(Number.POSITIVE_INFINITY);
    expect(decision.retryAt).toBeNull();
    expect(repo.hit).not.toHaveBeenCalled();
  });

  it('tracks scopes independently of one another', () => {
    const repo = makeFakeRepo();
    const svc = new RateLimitService(
      repo,
      validConfig({ UPLOAD_LIMIT_PER_HOUR: 1, DOWNLOAD_LIMIT_PER_HOUR: 1 }),
    );
    const t0 = new Date('2026-01-01T00:00:00.000Z');

    expect(svc.check('upload', '444', t0).allowed).toBe(true);
    // Different scope, same user — must still be allowed.
    expect(svc.check('download', '444', t0).allowed).toBe(true);
    // Re-hitting upload now blocks.
    expect(svc.check('upload', '444', t0).allowed).toBe(false);
  });
});
