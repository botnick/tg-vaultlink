/**
 * VaultLink Bot — share-code generator.
 *
 * Produces short, human-friendly share codes drawn from a 32-symbol
 * Crockford-style alphabet (5 bits of entropy per character). Randomness comes
 * from `node:crypto`'s `randomInt`, which rejects modulo bias by re-rolling
 * inside a uniform integer range — no manual bit-twiddling required.
 */

import { randomInt } from 'node:crypto';
import { CODE_ALPHABET } from '../config/constants.js';

const MIN_LENGTH = 4;
const MAX_LENGTH = 64;

/**
 * Generate a cryptographically random share code of the given length using
 * the Crockford-style alphabet defined in constants. Each character carries
 * 5 bits of entropy.
 *
 * @throws RangeError when `length` is not an integer in `[4, 64]`.
 */
export function generateCode(length: number): string {
  if (!Number.isInteger(length) || length < MIN_LENGTH || length > MAX_LENGTH) {
    throw new RangeError(`generateCode length must be ${MIN_LENGTH}–${MAX_LENGTH}, got ${length}`);
  }
  const out = new Array<string>(length);
  for (let i = 0; i < length; i++) {
    out[i] = CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)] as string;
  }
  return out.join('');
}

/**
 * Validate that every character of `code` is in the share-code alphabet.
 * Returns `false` for empty strings.
 */
export function isValidCode(code: string): boolean {
  if (typeof code !== 'string' || code.length === 0) return false;
  for (let i = 0; i < code.length; i++) {
    if (!CODE_ALPHABET.includes(code[i] as string)) return false;
  }
  return true;
}
