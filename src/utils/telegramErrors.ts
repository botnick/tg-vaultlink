/**
 * VaultLink Bot — Telegram-side error classifiers.
 *
 * Every retry-or-skip decision the bot makes against a `GrammyError` flows
 * through these helpers so the broadcast worker, the global error boundary,
 * and any other call site agree on what counts as "permanently unreachable",
 * "temporarily rate-limited", or "server hiccup, retry-able".
 *
 * Telegram's API does not expose a stable status taxonomy beyond the bare
 * `error_code`, so the unreachable check matches the human-readable
 * `description` against a small allowlist. The list mirrors what Telegram
 * returns today; new variants surface as warnings in the unhandled path
 * rather than silently retrying forever.
 */

import { GrammyError } from 'grammy';

/**
 * True when a Telegram error indicates the bot can no longer reach this chat
 * (user blocked, deactivated, kicked, chat deleted). These are terminal —
 * future retries will hit the same wall.
 */
export function isUnreachableChatError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const code = (err as { error_code?: number }).error_code;
  if (code !== 403 && code !== 400) return false;
  const desc = ((err as { description?: string }).description ?? err.message ?? '').toLowerCase();
  return (
    desc.includes('bot was blocked by the user') ||
    desc.includes("bot can't initiate conversation") ||
    desc.includes('user is deactivated') ||
    desc.includes('chat not found') ||
    desc.includes('bot was kicked') ||
    desc.includes('peer_id_invalid')
  );
}

/**
 * Pull the `retry_after` hint out of a 429 GrammyError (seconds), or null
 * when the error is not a 429 or the field is missing.
 */
export function getRetryAfterSeconds(err: unknown): number | null {
  if (!(err instanceof GrammyError)) return null;
  const code = (err as { error_code?: number }).error_code;
  if (code !== 429) return null;
  const params = (err as { parameters?: { retry_after?: number } }).parameters;
  const ra = params?.retry_after;
  return typeof ra === 'number' && ra >= 0 ? ra : null;
}

/**
 * True when the error is a transient Telegram-side hiccup worth retrying
 * (5xx). 4xx (other than 429) is treated as permanent.
 */
export function isTelegramServerError(err: unknown): boolean {
  if (!(err instanceof GrammyError)) return false;
  const code = (err as { error_code?: number }).error_code;
  return typeof code === 'number' && code >= 500 && code < 600;
}
