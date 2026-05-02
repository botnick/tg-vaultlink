/**
 * VaultLink Bot — share-code input parser.
 *
 * The bot accepts share-code references in several user-facing forms:
 *
 *   • Bare code:                `ABCDE23456`
 *   • Bot-namespaced code:      `mybot:ABCDE23456` or `@mybot:ABCDE23456`
 *   • With type-count suffix:   `mybot:ABCDE23456_3P_1V_1D`
 *     (the trailing `_<n><L>` chunks are display-only — they tell the
 *      reader at a glance how many photos/videos/etc. the share holds.
 *      The base code `ABCDE23456` is what's stored and looked up.)
 *   • Telegram deep link:       `https://t.me/mybot?start=ABCDE23456`
 *                               `https://telegram.me/mybot?start=ABCDE23456`
 *
 * This module is pure: it does not consult the database or the env. Code
 * validity is checked structurally (alphabet + length 4–64). Username casing
 * is normalised to lowercase for canonical lookup; codes are returned as
 * received (the share-code alphabet is uppercase by convention). Any suffix
 * present in the input is parsed off and discarded — the resolver only
 * needs the base code.
 */

import { TELEGRAM_BOT_USERNAME_REGEX } from '../config/constants.js';

export interface ParsedShareCode {
  /** Canonical lowercase bot username, or `null` for bare codes. */
  botUsername: string | null;
  /** The base share code (suffix-stripped), returned verbatim. */
  code: string;
}

/** Structural code validity used by the parser. */
const CODE_RE = /^[A-Za-z2-9]{4,64}$/;

/**
 * Trailing display-only suffix: zero or more `_<digits><single-letter>`
 * chunks (e.g. `_3P_1V_1D`). Only used for stripping during parse.
 */
const SUFFIX_RE = /(?:_\d+[A-Za-z])+$/;

/** Match a deep link of the form `https://t.me/<bot>?start=<code>`. */
const DEEP_LINK_RE =
  /^https?:\/\/(?:t\.me|telegram\.me)\/([A-Za-z][A-Za-z0-9_]{2,28}[Bb][Oo][Tt])\?start=([A-Za-z2-9]{4,64})$/;

/**
 * Match `<botUsername>:<code>` with an optional leading `@`. Any trailing
 * type-count suffix is stripped before this regex runs (see {@link parseShareCode}).
 */
const NAMESPACED_RE = /^@?([A-Za-z][A-Za-z0-9_]{2,28}[Bb][Oo][Tt]):([A-Za-z2-9]{4,64})$/;

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

  // 1) Deep link. Deep-link payloads cannot carry the display suffix.
  const dl = DEEP_LINK_RE.exec(trimmed);
  if (dl) {
    const username = (dl[1] as string).toLowerCase();
    const code = dl[2] as string;
    if (isValidUsername(username) && isValidCodeShape(code)) {
      return { botUsername: username, code };
    }
    return null;
  }

  // Strip any trailing type-count suffix (`_3P_1V_1D`) before the namespaced
  // and bare matchers run. The suffix is purely cosmetic: the resolver only
  // ever needs the base code.
  const stripped = trimmed.replace(SUFFIX_RE, '');

  // 2) Namespaced (`@bot:CODE` or `bot:CODE`).
  const ns = NAMESPACED_RE.exec(stripped);
  if (ns) {
    const username = (ns[1] as string).toLowerCase();
    const code = ns[2] as string;
    if (isValidUsername(username) && isValidCodeShape(code)) {
      return { botUsername: username, code };
    }
    return null;
  }

  // 3) Bare code.
  if (isValidCodeShape(stripped)) {
    return { botUsername: null, code: stripped };
  }

  return null;
}
