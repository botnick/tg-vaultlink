/**
 * Tests for {@link verifyInitData} — the Telegram Mini App HMAC validator.
 *
 * Each test builds a query-string payload with a known bot token, signs it
 * the same way the Telegram client does, and runs the result through
 * {@link verifyInitData}. The negative paths exercise every reason the
 * verifier can return so a regression in any of those branches is loud.
 */

import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';

import { verifyInitData } from '../src/miniapp/initData.js';

const TOKEN = '123456:AAAA-test-token-AAAA-test-token-AAAA';
const MAX_AGE = 86_400; // 1 day

/** Sign `payload` and emit a `URLSearchParams`-encoded string with `hash`. */
function buildInitData(payload: Record<string, string>, token: string): string {
  const sorted = Object.keys(payload)
    .sort()
    .map((k) => `${k}=${payload[k]}`)
    .join('\n');
  const secret = createHmac('sha256', Buffer.from('WebAppData'))
    .update(Buffer.from(token))
    .digest();
  const hash = createHmac('sha256', secret).update(sorted).digest('hex');
  const params = new URLSearchParams({ ...payload, hash });
  return params.toString();
}

function fixedNow(authDate: number, ageSeconds = 30): Date {
  return new Date((authDate + ageSeconds) * 1000);
}

describe('verifyInitData', () => {
  it('accepts a correctly signed initData and parses the user', () => {
    const authDate = 1_700_000_000;
    const userJson = JSON.stringify({
      id: 42,
      first_name: 'Ada',
      username: 'ada_l',
      language_code: 'en',
    });
    const initData = buildInitData(
      { auth_date: String(authDate), query_id: 'q1', user: userJson },
      TOKEN,
    );

    const result = verifyInitData(initData, TOKEN, MAX_AGE, fixedNow(authDate));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.user.id).toBe(42);
      expect(result.data.user.first_name).toBe('Ada');
      expect(result.data.user.username).toBe('ada_l');
      expect(result.data.auth_date).toBe(authDate);
      expect(result.data.query_id).toBe('q1');
      expect(result.data.raw).toBe(initData);
    }
  });

  it('rejects a tampered hash with bad_signature', () => {
    const authDate = 1_700_000_000;
    const userJson = JSON.stringify({ id: 7, first_name: 'Eve' });
    const initData = buildInitData(
      { auth_date: String(authDate), user: userJson },
      TOKEN,
    );
    // Flip a single hex char in the trailing hash.
    const flipped = initData.replace(/hash=([0-9a-f]+)/i, (_m, h: string) => {
      const last = h[h.length - 1] ?? '0';
      const replaced = last === '0' ? '1' : '0';
      return 'hash=' + h.slice(0, -1) + replaced;
    });
    const result = verifyInitData(flipped, TOKEN, MAX_AGE, fixedNow(authDate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects expired initData with reason=expired', () => {
    const authDate = 1_700_000_000;
    const userJson = JSON.stringify({ id: 9, first_name: 'Old' });
    const initData = buildInitData(
      { auth_date: String(authDate), user: userJson },
      TOKEN,
    );
    // Two days after auth_date with a one-day max age → expired.
    const result = verifyInitData(initData, TOKEN, MAX_AGE, fixedNow(authDate, 2 * MAX_AGE));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('rejects payloads missing the hash field', () => {
    // Sign manually but drop the `hash` from the result.
    const authDate = 1_700_000_000;
    const userJson = JSON.stringify({ id: 1, first_name: 'NoHash' });
    const params = new URLSearchParams({
      auth_date: String(authDate),
      user: userJson,
    });
    const result = verifyInitData(params.toString(), TOKEN, MAX_AGE, fixedNow(authDate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_hash');
  });

  it('rejects payloads missing the user field', () => {
    const authDate = 1_700_000_000;
    const initData = buildInitData({ auth_date: String(authDate) }, TOKEN);
    const result = verifyInitData(initData, TOKEN, MAX_AGE, fixedNow(authDate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_user');
  });

  it('rejects an empty token with reason=no_token', () => {
    const result = verifyInitData('foo=bar&hash=00', '', MAX_AGE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('no_token');
  });

  it('rejects an empty initData string with reason=malformed', () => {
    const result = verifyInitData('', TOKEN, MAX_AGE);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('rejects a hash whose length is wrong (treated as bad_signature)', () => {
    const authDate = 1_700_000_000;
    const userJson = JSON.stringify({ id: 1, first_name: 'Trunc' });
    const initData = buildInitData(
      { auth_date: String(authDate), user: userJson },
      TOKEN,
    );
    // Truncate the hash so the buffer length no longer matches.
    const truncated = initData.replace(/hash=([0-9a-f]+)/i, 'hash=deadbeef');
    const result = verifyInitData(truncated, TOKEN, MAX_AGE, fixedNow(authDate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
  });

  it('rejects a non-JSON user field with reason=missing_user', () => {
    const authDate = 1_700_000_000;
    const initData = buildInitData(
      { auth_date: String(authDate), user: 'not-json' },
      TOKEN,
    );
    const result = verifyInitData(initData, TOKEN, MAX_AGE, fixedNow(authDate));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_user');
  });
});
