/**
 * VaultLink Bot — share-code input parser.
 *
 * The bot accepts share-code references in several user-facing forms:
 *
 *   • Bare code:                `ABCDE23456`
 *   • Bot-namespaced code:      `mybot_ABCDE23456` or `@mybot_ABCDE23456`
 *                               (legacy `mybot:ABCDE23456` is still accepted)
 *   • Telegram deep link:       `https://t.me/mybot?start=ABCDE23456`
 *                               `https://telegram.me/mybot?start=ABCDE23456`
 *
 * The namespaced form's separator switched from `:` to `_` because Telegram
 * clients now treat `botname:code` strings as deep links to a non-existent
 * bot's tag, breaking copy-paste UX. `_` survives the round-trip through
 * Telegram's auto-linker. The grammar is unambiguous because share codes
 * can never contain `_` (the alphabet is `[A-Za-z2-9]` only) and bot
 * usernames must end with `bot` — the regex anchors on that boundary.
 *
 * This module is pure: it does not consult the database or the env. Code
 * validity is checked structurally (alphabet + length 4–64). Username casing
 * is normalised to lowercase for canonical lookup; codes are returned as
 * received (the share-code alphabet is uppercase by convention).
 */

import { TELEGRAM_BOT_USERNAME_REGEX } from '../config/constants.js';

export interface ParsedShareCode {
  /** Canonical lowercase bot username, or `null` for bare codes. */
  botUsername: string | null;
  /** The share code itself, returned verbatim. */
  code: string;
}

/** Structural code validity used by the parser. */
const CODE_RE = /^[A-Za-z2-9]{4,64}$/;

/** Match a deep link of the form `https://t.me/<bot>?start=<code>`. */
const DEEP_LINK_RE =
  /^https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{2,28}[Bb][Oo][Tt])\?start=([A-Za-z2-9]{4,64})$/;

/**
 * Match `<botUsername>_<code>` (current) or `<botUsername>:<code>` (legacy)
 * with an optional leading `@`. The username segment is greedy and the code
 * segment cannot contain `_`, so even bot names that themselves contain
 * underscores parse unambiguously — the LAST `_` is always the separator.
 */
const NAMESPACED_RE = /^@?([A-Za-z][A-Za-z0-9_]{2,28}[Bb][Oo][Tt])[_:]([A-Za-z2-9]{4,64})$/;

function isValidUsername(name: string): boolean {
  return TELEGRAM_BOT_USERNAME_REGEX.test(name);
}

function isValidCodeShape(code: string): boolean {
  return CODE_RE.test(code);
}

/**
 * Parse share-code input. Returns `null` when the input cannot be interpreted
 * as a share-code reference.
 *
 * Username casing is lowercased for canonical lookup; code casing is
 * preserved.
 */
export function parseShareCode(input: string): ParsedShareCode | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // 1) Deep link.
  const dl = DEEP_LINK_RE.exec(trimmed);
  if (dl) {
    const username = (dl[1] as string).toLowerCase();
    const code = dl[2] as string;
    if (isValidUsername(username) && isValidCodeShape(code)) {
      return { botUsername: username, code };
    }
    return null;
  }

  // 2) Namespaced (`@bot:CODE` or `bot:CODE`).
  const ns = NAMESPACED_RE.exec(trimmed);
  if (ns) {
    const username = (ns[1] as string).toLowerCase();
    const code = ns[2] as string;
    if (isValidUsername(username) && isValidCodeShape(code)) {
      return { botUsername: username, code };
    }
    return null;
  }

  // 3) Bare code.
  if (isValidCodeShape(trimmed)) {
    return { botUsername: null, code: trimmed };
  }

  return null;
}
