/**
 * VaultLink Bot — token encryption service.
 *
 * Wraps Node's `crypto` AES-256-GCM primitives so the rest of the codebase can
 * encrypt/decrypt child-bot tokens without re-deriving the parameter set on
 * every call. Each encryption draws a fresh 12-byte nonce from `randomBytes`,
 * so callers may safely reuse the same key across the entire managed-bot
 * table — the (key, nonce, ciphertext, tag) tuple stays unique per row.
 *
 * Decryption fails closed: any auth-tag mismatch, key-length mismatch, or
 * malformed base64 component throws an {@link AppError} carrying
 * `BOT_TOKEN_INVALID` so the calling layer can degrade the bot row to the
 * `error` status without leaking internals to the requester.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError, ErrorCode } from '../utils/errors.js';
import { ENCRYPTION_KEY_BYTES, NONCE_BYTES, AUTH_TAG_BYTES } from '../config/constants.js';

/**
 * Output of a successful {@link encryptToken} call. All three components are
 * base64-encoded so they can be persisted as plain SQLite `TEXT` columns.
 */
export interface EncryptedToken {
  /** Base64-encoded AES-256-GCM ciphertext. */
  encrypted: string;
  /** Base64-encoded 12-byte initialization vector. */
  nonce: string;
  /** Base64-encoded 16-byte GCM authentication tag. */
  authTag: string;
}

const ALGORITHM = 'aes-256-gcm';

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== ENCRYPTION_KEY_BYTES) {
    throw new AppError(
      ErrorCode.CONFIG_INVALID,
      `encryption key must be ${ENCRYPTION_KEY_BYTES} bytes (got ${Buffer.isBuffer(key) ? key.length : 'non-Buffer'})`,
    );
  }
}

/**
 * Encrypt `plaintext` with AES-256-GCM under `key`.
 *
 * @throws {AppError} `CONFIG_INVALID` when `key` is not exactly
 * {@link ENCRYPTION_KEY_BYTES} bytes long.
 */
export function encryptToken(plaintext: string, key: Buffer): EncryptedToken {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    nonce: nonce.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * Decrypt the (`encrypted`, `nonce`, `authTag`) tuple produced by a previous
 * {@link encryptToken} call.
 *
 * @throws {AppError} `BOT_TOKEN_INVALID` on auth-tag mismatch, malformed
 * base64, or any other GCM failure — never re-throws the underlying crypto
 * error to avoid leaking timing/structural details.
 */
export function decryptToken(encrypted: EncryptedToken, key: Buffer): string {
  assertKey(key);

  let nonceBuf: Buffer;
  let tagBuf: Buffer;
  let cipherBuf: Buffer;
  try {
    nonceBuf = Buffer.from(encrypted.nonce, 'base64');
    tagBuf = Buffer.from(encrypted.authTag, 'base64');
    cipherBuf = Buffer.from(encrypted.encrypted, 'base64');
  } catch (cause) {
    throw new AppError(ErrorCode.BOT_TOKEN_INVALID, 'failed to decrypt token', { cause });
  }

  if (nonceBuf.length !== NONCE_BYTES || tagBuf.length !== AUTH_TAG_BYTES) {
    throw new AppError(ErrorCode.BOT_TOKEN_INVALID, 'failed to decrypt token');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, nonceBuf);
    decipher.setAuthTag(tagBuf);
    const plain = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
    return plain.toString('utf8');
  } catch (cause) {
    throw new AppError(ErrorCode.BOT_TOKEN_INVALID, 'failed to decrypt token', { cause });
  }
}
