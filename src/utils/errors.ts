/**
 * VaultLink Bot — typed error model.
 *
 * Every domain failure raised by the bot funnels through {@link AppError} so that
 * higher layers (handlers, middlewares, the global error boundary) can branch on
 * a small, exhaustive {@link ErrorCode} set instead of pattern-matching messages.
 *
 * `expose === true` marks errors whose `message` is safe to surface verbatim to
 * the requesting Telegram user. Anything else is logged with full context and
 * replaced with a generic localized response.
 */

export const ErrorCode = {
  CONFIG_INVALID: 'CONFIG_INVALID',
  DB_OPEN_FAILED: 'DB_OPEN_FAILED',
  DB_MIGRATION_FAILED: 'DB_MIGRATION_FAILED',
  BOT_TOKEN_INVALID: 'BOT_TOKEN_INVALID',
  BOT_ALREADY_EXISTS: 'BOT_ALREADY_EXISTS',
  BOT_START_FAILED: 'BOT_START_FAILED',
  BOT_NOT_FOUND: 'BOT_NOT_FOUND',
  USER_BANNED: 'USER_BANNED',
  USER_NOT_FOUND: 'USER_NOT_FOUND',
  RATE_LIMITED: 'RATE_LIMITED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FILE_TYPE_BLOCKED: 'FILE_TYPE_BLOCKED',
  FILE_NOT_AVAILABLE: 'FILE_NOT_AVAILABLE',
  FILE_LOCKED: 'FILE_LOCKED',
  FILE_EXPIRED: 'FILE_EXPIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  PASSWORD_REQUIRED: 'PASSWORD_REQUIRED',
  PASSWORD_INCORRECT: 'PASSWORD_INCORRECT',
  REPORT_FAILED: 'REPORT_FAILED',
  FEATURE_DISABLED: 'FEATURE_DISABLED',
  INVALID_INPUT: 'INVALID_INPUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface AppErrorOptions {
  expose?: boolean;
  cause?: unknown;
  meta?: Record<string, unknown>;
}

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly expose: boolean;
  public readonly meta: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, opts?: AppErrorOptions) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.expose = opts?.expose ?? false;
    this.meta = opts?.meta;
    // Preserve stack across V8 / non-V8 engines.
    if (
      typeof (Error as unknown as { captureStackTrace?: unknown }).captureStackTrace === 'function'
    ) {
      (
        Error as unknown as {
          captureStackTrace: (t: object, c?: new (...args: never[]) => unknown) => void;
        }
      ).captureStackTrace(this, AppError);
    }
  }

  static is(e: unknown): e is AppError {
    return e instanceof AppError;
  }
}
