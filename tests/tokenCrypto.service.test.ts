/**
 * Tests for `tokenCrypto.service` — covers happy-path round-tripping plus the
 * three failure modes that map to `BOT_TOKEN_INVALID`: wrong key, tampered
 * ciphertext, tampered auth tag. Also asserts that nonce uniqueness is
 * driven by `randomBytes` (so two encryptions of the same plaintext under the
 * same key produce different nonces) and that key-length validation runs on
 * every encrypt call.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptToken, decryptToken } from '../src/services/tokenCrypto.service.js';
import { ENCRYPTION_KEY_BYTES } from '../src/config/constants.js';
import { AppError } from '../src/utils/errors.js';

const PLAINTEXT = '123456789:AAEhBP0av3pQVhQy7nF4cPm0H_dummy_bot_token';

function makeKey(): Buffer {
  return randomBytes(ENCRYPTION_KEY_BYTES);
}

describe('tokenCrypto.service', () => {
  it('round-trips a token through encrypt + decrypt', () => {
    const key = makeKey();
    const enc = encryptToken(PLAINTEXT, key);
    expect(typeof enc.encrypted).toBe('string');
    expect(typeof enc.nonce).toBe('string');
    expect(typeof enc.authTag).toBe('string');
    const decoded = decryptToken(enc, key);
    expect(decoded).toBe(PLAINTEXT);
  });

  it('produces a fresh nonce on every call', () => {
    const key = makeKey();
    const a = encryptToken(PLAINTEXT, key);
    const b = encryptToken(PLAINTEXT, key);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.encrypted).not.toBe(b.encrypted);
  });

  it('throws BOT_TOKEN_INVALID when decrypted with the wrong key', () => {
    const enc = encryptToken(PLAINTEXT, makeKey());
    const wrongKey = makeKey();
    let caught: unknown;
    try {
      decryptToken(enc, wrongKey);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe('BOT_TOKEN_INVALID');
    expect((caught as AppError).expose).toBe(false);
  });

  it('throws BOT_TOKEN_INVALID when ciphertext is tampered', () => {
    const key = makeKey();
    const enc = encryptToken(PLAINTEXT, key);
    const cipherBuf = Buffer.from(enc.encrypted, 'base64');
    // Flip the last byte of the ciphertext.
    cipherBuf[cipherBuf.length - 1] = cipherBuf[cipherBuf.length - 1]! ^ 0x01;
    const tampered = { ...enc, encrypted: cipherBuf.toString('base64') };
    expect(() => decryptToken(tampered, key)).toThrowError(AppError);
    try {
      decryptToken(tampered, key);
    } catch (e) {
      expect((e as AppError).code).toBe('BOT_TOKEN_INVALID');
    }
  });

  it('throws BOT_TOKEN_INVALID when auth tag is tampered', () => {
    const key = makeKey();
    const enc = encryptToken(PLAINTEXT, key);
    const tagBuf = Buffer.from(enc.authTag, 'base64');
    tagBuf[0] = tagBuf[0]! ^ 0xff;
    const tampered = { ...enc, authTag: tagBuf.toString('base64') };
    try {
      decryptToken(tampered, key);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AppError);
      expect((e as AppError).code).toBe('BOT_TOKEN_INVALID');
    }
  });

  it('rejects keys that are not exactly 32 bytes on encrypt', () => {
    const shortKey = randomBytes(16);
    expect(() => encryptToken(PLAINTEXT, shortKey)).toThrowError(AppError);
    const longKey = randomBytes(64);
    expect(() => encryptToken(PLAINTEXT, longKey)).toThrowError(AppError);
  });

  it('rejects keys that are not exactly 32 bytes on decrypt', () => {
    const enc = encryptToken(PLAINTEXT, makeKey());
    expect(() => decryptToken(enc, randomBytes(16))).toThrowError(AppError);
  });
});
