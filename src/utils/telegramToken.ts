/**
 * VaultLink Bot — Telegram bot token helpers.
 *
 * Tokens follow the shape `<bot_id>:<auth_part>` where `bot_id` is numeric and
 * `auth_part` is at least 30 URL-safe characters. The `bot_id` prefix is the
 * primary key Telegram uses to address the bot; the auth tail is the secret
 * we must never log. {@link maskToken} is used wherever a token might end up
 * in human-readable output.
 */

import { TELEGRAM_TOKEN_REGEX } from '../config/constants.js';
import { AppError, ErrorCode } from './errors.js';

/** Validate a Telegram bot token by structural shape only. */
export function isValidTelegramToken(token: unknown): boolean {
  if (typeof token !== 'string') return false;
  return TELEGRAM_TOKEN_REGEX.test(token.trim());
}

/**
 * Return the numeric `bot_id` prefix of a Telegram bot token.
 *
 * @throws AppError with {@link ErrorCode.BOT_TOKEN_INVALID} when the token is
 *         malformed.
 */
export function parseTelegramBotId(token: string): string {
  if (!isValidTelegramToken(token)) {
    throw new AppError(ErrorCode.BOT_TOKEN_INVALID, 'invalid telegram bot token');
  }
  const trimmed = token.trim();
  const colon = trimmed.indexOf(':');
  return trimmed.slice(0, colon);
}

/**
 * Mask the secret portion of a token for log/UI surfaces. Preserves the
 * `bot_id`, plus a short prefix and suffix of the auth tail to ease debugging.
 *
 * Example: `12345:abcdefghijklmnopqrstuvwxyz0123456` →
 *          `12345:abc***456`.
 *
 * Any input that does not look like a valid token is reduced to the literal
 * string `<redacted>` rather than echoing it back.
 */
export function maskToken(token: string): string {
  if (!isValidTelegramToken(token)) return '<redacted>';
  const trimmed = token.trim();
  const colon = trimmed.indexOf(':');
  const id = trimmed.slice(0, colon);
  const auth = trimmed.slice(colon + 1);
  const head = auth.slice(0, 3);
  const tail = auth.slice(-3);
  return `${id}:${head}***${tail}`;
}
