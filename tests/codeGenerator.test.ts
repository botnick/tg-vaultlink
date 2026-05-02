/**
 * Tests for the share-code generator.
 */

import { describe, expect, it } from 'vitest';
import { generateCode, isValidCode } from '../src/utils/codeGenerator.js';
import { CODE_ALPHABET } from '../src/config/constants.js';

describe('generateCode', () => {
  it('returns a string of the requested length', () => {
    const code = generateCode(12);
    expect(typeof code).toBe('string');
    expect(code).toHaveLength(12);
  });

  it('uses only alphabet characters', () => {
    const code = generateCode(32);
    for (const ch of code) {
      expect(CODE_ALPHABET.includes(ch)).toBe(true);
    }
  });

  it('produces high-entropy distinct codes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) {
      seen.add(generateCode(12));
    }
    // 100 codes from 32^12 keyspace → collisions are astronomically unlikely.
    expect(seen.size).toBe(100);
  });

  it('throws RangeError when length is below the minimum', () => {
    expect(() => generateCode(3)).toThrow(RangeError);
  });

  it('throws RangeError when length is above the maximum', () => {
    expect(() => generateCode(65)).toThrow(RangeError);
  });

  it('throws RangeError when length is non-integer', () => {
    expect(() => generateCode(8.5)).toThrow(RangeError);
  });
});

describe('isValidCode', () => {
  it('accepts an all-alphabet code', () => {
    expect(isValidCode('ABCDE23456')).toBe(true);
  });

  it('rejects lowercase letters (alphabet is uppercase only)', () => {
    expect(isValidCode('LOWERcase')).toBe(false);
  });

  it('rejects ambiguous digits 0 and 1', () => {
    expect(isValidCode('1230')).toBe(false);
  });

  it('rejects ambiguous letters I, L, O', () => {
    expect(isValidCode('ILOXY')).toBe(false);
  });

  it('rejects empty strings', () => {
    expect(isValidCode('')).toBe(false);
  });
});
