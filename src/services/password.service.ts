/**
 * VaultLink Bot — file-password service.
 *
 * Thin Argon2id wrapper used when the uploader marks a file with an optional
 * "share password". The hash is persisted in `files.password_hash`; the raw
 * password is never logged or echoed back. Length validation is exposed as a
 * standalone function so command parsers can reject obviously-too-short or
 * absurdly-long input *before* paying the Argon2 cost.
 */

import argon2 from 'argon2';
import { AppError, ErrorCode } from '../utils/errors.js';
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../config/constants.js';

/**
 * Reject `plaintext` whose length is outside
 * `[PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]`.
 *
 * @throws {AppError} `INVALID_INPUT` — the message is exposable so handlers
 * can forward it directly to the user.
 */
export function validatePasswordLength(plaintext: string): void {
  if (typeof plaintext !== 'string') {
    throw new AppError(ErrorCode.INVALID_INPUT, 'password must be a string', { expose: true });
  }
  if (plaintext.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(
      ErrorCode.INVALID_INPUT,
      `password must be at least ${PASSWORD_MIN_LENGTH} characters`,
      { expose: true },
    );
  }
  if (plaintext.length > PASSWORD_MAX_LENGTH) {
    throw new AppError(
      ErrorCode.INVALID_INPUT,
      `password must be at most ${PASSWORD_MAX_LENGTH} characters`,
      { expose: true },
    );
  }
}

/**
 * Hash `plaintext` with Argon2id using the library defaults. Length is
 * validated first, so callers don't need a separate guard.
 */
export async function hashPassword(plaintext: string): Promise<string> {
  validatePasswordLength(plaintext);
  return argon2.hash(plaintext, { type: argon2.argon2id });
}

/**
 * Verify `plaintext` against the stored Argon2 `hash`.
 *
 * Returns `false` for both an explicit mismatch and any thrown error (e.g.
 * malformed hash string). Errors are intentionally swallowed because the
 * caller cannot distinguish a tampered hash from a wrong password without
 * leaking that distinction back to the user.
 */
export async function verifyPassword(hash: string, plaintext: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plaintext);
  } catch {
    return false;
  }
}
