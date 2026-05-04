/**
 * VaultLink Bot — global error boundary.
 *
 * Installed via `bot.catch(...)` for every grammY instance the app builds.
 * The handler logs the failure (with pino-redacted secret paths) and replies
 * with a localized message: known {@link AppError} codes map to specific
 * keys, anything else collapses to the generic `common.error.internal`. We
 * never echo a raw exception text to the user.
 */

import type { Bot } from 'grammy';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { getLogger } from '../../logger/logger.js';
import { t as translate, isSupportedLocale } from '../../utils/i18n.js';
import type { Locale } from '../../types/index.js';
import type { AppContext } from '../context.js';
import type { Config } from '../../config/env.js';
import { formatBytes } from '../../utils/formatBytes.js';
import { isUnreachableChatError } from '../../utils/telegramErrors.js';

/**
 * Map an `AppError` code to a localized message. Returns `null` when the code
 * has no specific user-facing translation; the caller falls back to
 * `common.error.internal`.
 */
function localizedMessageFor(err: AppError, locale: Locale, config: Config): string | null {
  const tr = (key: string, params?: Record<string, string | number>): string =>
    translate(locale, key, params);

  switch (err.code) {
    case ErrorCode.RATE_LIMITED:
      return tr('common.error.rate_limited');
    case ErrorCode.USER_BANNED:
      return tr('common.error.banned');
    case ErrorCode.PERMISSION_DENIED:
      return tr('common.error.permission_denied');
    case ErrorCode.FEATURE_DISABLED:
      return tr('common.error.feature_disabled');
    case ErrorCode.INVALID_INPUT:
      return tr('common.error.invalid_input');
    case ErrorCode.BOT_TOKEN_INVALID:
      return tr('bot.add.invalid_token');
    case ErrorCode.BOT_ALREADY_EXISTS:
      return tr('bot.add.duplicate');
    case ErrorCode.FILE_TOO_LARGE:
      return tr('upload.too_large', {
        maxSize: formatBytes(config.MAX_FILE_SIZE_MB * 1024 * 1024),
      });
    case ErrorCode.FILE_TYPE_BLOCKED:
      return tr('upload.type_blocked');
    case ErrorCode.FILE_NOT_AVAILABLE:
      return tr('decode.not_found');
    case ErrorCode.FILE_LOCKED:
      return tr('decode.locked');
    case ErrorCode.FILE_EXPIRED:
      return tr('decode.expired');
    case ErrorCode.PASSWORD_REQUIRED:
      // Password flow is handled inline by the decode router (it knows the
      // share code so it can suggest the `<code>:<password>` form). The
      // generic prompt is safe as a fallback when the error escapes here.
      return translate(locale, 'decode.password_required', { shareCode: '…' });
    case ErrorCode.PASSWORD_INCORRECT:
      return tr('decode.password_incorrect');
    default:
      return null;
  }
}

/**
 * Install a global error handler on `bot`. The closure captures `config` so
 * the handler can resolve a fallback locale and format byte-size hints.
 */
export function installErrorHandler(bot: Bot<AppContext>, config: Config): void {
  const log = getLogger();

  bot.catch((err) => {
    const ctx = err.ctx;
    const updateId = ctx?.update?.update_id;
    const cause = err.error;

    // Resolve locale: ctx.locale wins, falling back to user.locale, then env.
    let locale: Locale = config.DEFAULT_LOCALE;
    const ctxLocale = ctx?.locale;
    if (ctxLocale && isSupportedLocale(ctxLocale)) {
      locale = ctxLocale;
    } else {
      const ul = ctx?.user?.locale;
      if (ul && isSupportedLocale(ul)) locale = ul;
    }

    if (cause instanceof AppError) {
      // `expose: true` AppErrors are user-input rejections (invalid token,
      // file too large, password incorrect, …) — log them at warn so the
      // error log isn't flooded with what is, operationally, normal traffic.
      // Anything else is a real surprise → log at error.
      const logLevel = cause.expose ? 'warn' : 'error';
      log[logLevel](
        {
          err: cause,
          code: cause.code,
          expose: cause.expose,
          meta: cause.meta,
          updateId,
        },
        'bot handler raised AppError',
      );
      const msg =
        localizedMessageFor(cause, locale, config) ?? translate(locale, 'common.error.internal');
      void ctx?.reply(msg, { parse_mode: 'HTML' }).catch(() => undefined);
      return;
    }

    // Telegram-side "bot can't reach this chat" errors (user blocked, kicked,
    // deactivated). These are normal user behaviour; logging them at error
    // pollutes the alerting feed AND attempting to reply would just hit the
    // same wall and produce another error log line.
    if (isUnreachableChatError(cause)) {
      log.warn(
        { err: cause, updateId },
        'bot handler: chat unreachable (user blocked / deactivated / kicked)',
      );
      return;
    }

    log.error({ err: cause, updateId }, 'unhandled bot error');
    void ctx
      ?.reply(translate(locale, 'common.error.internal'), { parse_mode: 'HTML' })
      .catch(() => undefined);
  });
}
