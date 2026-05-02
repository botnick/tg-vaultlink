/**
 * Tests for the Telegram bot token helpers.
 */

import { describe, expect, it } from 'vitest';
import {
  isValidTelegramToken,
  parseTelegramBotId,
  maskToken,
} from '../src/utils/telegramToken.js';
import { AppError, ErrorCode } from '../src/utils/errors.js';

const VALID = '12345:abcdefghijklmnopqrstuvwxyz0123456';

describe('isValidTelegramToken', () => {
  it('accepts a well-formed token', () => {
    expect(isValidTelegramToken(VALID)).toBe(true);
  });

  it('rejects a token whose auth tail is too short', () => {
    expect(isValidTelegramToken('12345:short')).toBe(false);
  });

  it('rejects free-form text', () => {
    expect(isValidTelegramToken('not a token')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isValidTelegramToken(null as unknown as string)).toBe(false);
    expect(isValidTelegramToken(12345 as unknown as string)).toBe(false);
  });
});

describe('parseTelegramBotId', () => {
  it('returns the numeric prefix of a valid token', () => {
    expect(parseTelegramBotId(VALID)).toBe('12345');
  });

  it('throws AppError(BOT_TOKEN_INVALID) on malformed input', () => {
    let caught: unknown;
    try {
      parseTelegramBotId('not a token');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).code).toBe(ErrorCode.BOT_TOKEN_INVALID);
  });
});

describe('maskToken', () => {
  it('hides the auth tail while preserving the bot id', () => {
    const masked = maskToken(VALID);
    expect(masked.startsWith('12345:')).toBe(true);
    // Must NOT contain the full secret tail.
    expect(masked.includes('abcdefghijklmnopqrstuvwxyz0123456')).toBe(false);
    // Should contain the literal masking marker.
    expect(masked).toContain('***');
  });

  it('reduces malformed tokens to <redacted>', () => {
    expect(maskToken('not a token')).toBe('<redacted>');
  });
});
