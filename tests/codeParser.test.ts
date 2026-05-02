/**
 * Tests for the share-code input parser.
 */

import { describe, expect, it } from 'vitest';
import { parseShareCode } from '../src/utils/codeParser.js';

describe('parseShareCode', () => {
  it('parses `<bot>:<code>`', () => {
    expect(parseShareCode('vaultbot:ABCDE23456')).toEqual({
      botUsername: 'vaultbot',
      code: 'ABCDE23456',
    });
  });

  it('parses `@<bot>:<code>` and strips the leading @', () => {
    expect(parseShareCode('@vaultbot:ABCDE23456')).toEqual({
      botUsername: 'vaultbot',
      code: 'ABCDE23456',
    });
  });

  it('strips the cosmetic type-count suffix and returns the base code only', () => {
    expect(parseShareCode('vaultbot:ABCDE23456_5P_1V_1D')).toEqual({
      botUsername: 'vaultbot',
      code: 'ABCDE23456',
    });
  });

  it('strips a single-letter suffix on a bare code too', () => {
    expect(parseShareCode('ABCDE23456_1V')).toEqual({
      botUsername: null,
      code: 'ABCDE23456',
    });
  });

  it('parses a bot username that itself contains underscores', () => {
    expect(parseShareCode('my_share_bot:ABCDE23456')).toEqual({
      botUsername: 'my_share_bot',
      code: 'ABCDE23456',
    });
  });

  it('parses a bare code with no bot context', () => {
    expect(parseShareCode('ABCDE23456')).toEqual({
      botUsername: null,
      code: 'ABCDE23456',
    });
  });

  it('parses a t.me deep link', () => {
    expect(parseShareCode('https://t.me/vaultbot?start=ABCDE23456')).toEqual({
      botUsername: 'vaultbot',
      code: 'ABCDE23456',
    });
  });

  it('parses a telegram.me deep link and lowercases the username', () => {
    expect(parseShareCode('https://telegram.me/VaultBot?start=ABCDE23456')).toEqual({
      botUsername: 'vaultbot',
      code: 'ABCDE23456',
    });
  });

  it('returns null for a t.me link with no start parameter', () => {
    expect(parseShareCode('https://t.me/vaultbot')).toBeNull();
  });

  it('returns null for free-form non-code input', () => {
    expect(parseShareCode('not a code')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(parseShareCode('   ')).toBeNull();
  });

  it('trims surrounding whitespace before matching', () => {
    expect(parseShareCode('  ABCDE23456  ')).toEqual({
      botUsername: null,
      code: 'ABCDE23456',
    });
  });

  it('returns null when the bot username does not end in "bot"', () => {
    expect(parseShareCode('myservice:ABCDE23456')).toBeNull();
  });

  it('returns null when the bot username is too short', () => {
    // Telegram usernames are min 5 chars and bot usernames must end in "bot",
    // making "mybot" structurally too short for the constants regex.
    expect(parseShareCode('mybot:ABCDE23456')).toBeNull();
  });
});
