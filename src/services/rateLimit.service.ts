/**
 * VaultLink Bot — rate limiter service.
 *
 * Bridges the per-scope env tunables with the `rate_limits` SQLite table.
 * Each `check()` increments the counter and returns a structured decision
 * the caller can render to the user; the underlying repo is responsible for
 * window roll-over (when `now > window_start + windowMs`, it resets the
 * counter and reports `newWindow: true`).
 *
 * A `limit === 0` scope short-circuits the check entirely — the repository
 * is never touched, which lets admins disable rate-limiting for a scope
 * without paying any DB round-trips.
 */

import type { Config } from '../config/env.js';
import type { RateLimitRow } from '../types/index.js';
import { RATE_LIMIT_WINDOWS } from '../config/constants.js';

export interface IRateLimitRepository {
  hit(
    scope: string,
    key: string,
    windowMs: number,
    now?: Date,
  ): { row: RateLimitRow; newWindow: boolean };
  reset(scope: string, key: string): void;
}

/** Supported rate-limit scopes; mirrors the `scope` column. */
export type RateLimitScope =
  | 'upload'
  | 'download'
  | 'add_bot'
  | 'report'
  | 'crypto_invoice';

export interface RateLimitDecision {
  /** `true` when this hit is within the per-window quota. */
  allowed: boolean;
  /** Hits remaining in the current window after this call. */
  remaining: number;
  /** Wall-clock instant when the next window begins. `null` when allowed. */
  retryAt: Date | null;
  scope: string;
  key: string;
}

export class RateLimitService {
  private readonly repo: IRateLimitRepository;
  private readonly config: Config;

  constructor(repo: IRateLimitRepository, config: Config) {
    this.repo = repo;
    this.config = config;
  }

  /**
   * Atomically increment the counter for `(scope, telegramUserId)` and
   * return a {@link RateLimitDecision}. When the configured limit is `0`,
   * skips the repo call and returns an `allowed=true` decision.
   */
  check(scope: RateLimitScope, telegramUserId: string, now?: Date): RateLimitDecision {
    const { limit, windowMs } = this.resolveScope(scope);

    if (limit === 0) {
      return {
        allowed: true,
        remaining: Number.POSITIVE_INFINITY,
        retryAt: null,
        scope,
        key: telegramUserId,
      };
    }

    const { row } = this.repo.hit(scope, telegramUserId, windowMs, now);
    const allowed = row.count <= limit;
    const remaining = Math.max(0, limit - row.count);
    let retryAt: Date | null = null;
    if (!allowed) {
      const windowStartMs = Date.parse(row.window_start);
      retryAt = Number.isFinite(windowStartMs) ? new Date(windowStartMs + windowMs) : null;
    }

    return { allowed, remaining, retryAt, scope, key: telegramUserId };
  }

  private resolveScope(scope: RateLimitScope): { limit: number; windowMs: number } {
    switch (scope) {
      case 'upload':
        return { limit: this.config.UPLOAD_LIMIT_PER_HOUR, windowMs: RATE_LIMIT_WINDOWS.upload };
      case 'download':
        return {
          limit: this.config.DOWNLOAD_LIMIT_PER_HOUR,
          windowMs: RATE_LIMIT_WINDOWS.download,
        };
      case 'add_bot':
        return { limit: this.config.ADD_BOT_LIMIT_PER_DAY, windowMs: RATE_LIMIT_WINDOWS.add_bot };
      case 'report':
        return { limit: this.config.REPORT_LIMIT_PER_HOUR, windowMs: RATE_LIMIT_WINDOWS.report };
      case 'crypto_invoice':
        return {
          limit: this.config.CRYPTO_INVOICE_RATELIMIT_PER_MIN,
          windowMs: RATE_LIMIT_WINDOWS.crypto_invoice,
        };
    }
  }
}
