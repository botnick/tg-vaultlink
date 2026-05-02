/**
 * VaultLink Bot — Telegram Mini App initData verification.
 *
 * Implements the HMAC-SHA256 protocol described at
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app:
 *
 *   1. Parse the `?key=value&...` query string the front-end captures from
 *      `Telegram.WebApp.initData`.
 *   2. Strip out the `hash` parameter (the value the client signed).
 *   3. Sort the remaining pairs alphabetically by key, format each as
 *      `key=value`, and join them with `\n` to form the `data_check_string`.
 *   4. Derive the secret key as `HMAC-SHA256("WebAppData", BOT_TOKEN)` — the
 *      literal string `"WebAppData"` is the HMAC key, the bot token is the
 *      message.
 *   5. Compute `HMAC-SHA256(secret_key, data_check_string)` and compare it
 *      to the supplied `hash` in constant time.
 *   6. Reject anything older than `MINI_APP_INITDATA_MAX_AGE_SECONDS`.
 *   7. Parse the embedded `user` JSON blob — that is the trusted identity
 *      attached to the request. Front-end-supplied IDs in the request body
 *      are NEVER trusted.
 *
 * Errors collapse into a small, fixed reason set so the caller can map them
 * onto a generic 401 without leaking the failure mode (timing-safe compare,
 * "did the signature match" vs. "did the signature even have the right
 * length", etc.).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError, ErrorCode } from '../utils/errors.js';

/** Telegram-defined `WebAppUser` shape (subset that we actually consume). */
export interface ParsedInitDataUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

/**
 * Successfully verified `initData` payload. `raw` is the original query
 * string (handy for debugging / re-emitting); the rest are the canonical
 * decoded fields.
 */
export interface ParsedInitData {
  raw: string;
  user: ParsedInitDataUser;
  auth_date: number;
  query_id?: string;
  start_param?: string;
  hash: string;
  chat_type?: string;
  chat_instance?: string;
  receiver?: object;
  chat?: object;
  signature?: string;
}

export interface InitDataVerifyResult {
  ok: true;
  data: ParsedInitData;
}

export interface InitDataVerifyError {
  ok: false;
  reason: 'malformed' | 'missing_hash' | 'bad_signature' | 'expired' | 'missing_user' | 'no_token';
}

/**
 * Verify `initData` against `botToken`. Returns a discriminated union so the
 * caller can decide whether to surface a generic 401 or to log a structured
 * reason. A `now` override is accepted to keep the freshness check
 * deterministic in unit tests.
 */
export function verifyInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  now?: Date,
): InitDataVerifyResult | InitDataVerifyError {
  if (!botToken || botToken.length === 0) {
    return { ok: false, reason: 'no_token' };
  }
  if (typeof initData !== 'string' || initData.length === 0) {
    return { ok: false, reason: 'malformed' };
  }

  let params: URLSearchParams;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const hash = params.get('hash');
  if (hash === null || hash.length === 0) {
    return { ok: false, reason: 'missing_hash' };
  }
  if (!/^[0-9a-f]+$/i.test(hash)) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Build the canonical data-check string: every pair other than `hash`,
  // sorted alphabetically by key, formatted as `key=value`, joined by `\n`.
  const pairs: Array<[string, string]> = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

  // Telegram secret key derivation: HMAC-SHA256(key="WebAppData", msg=token).
  const secretKey = createHmac('sha256', Buffer.from('WebAppData'))
    .update(Buffer.from(botToken))
    .digest();
  const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // timingSafeEqual requires equal-length buffers; if the supplied hash is the
  // wrong length we treat it as a bad signature without leaking that fact.
  let signatureValid = false;
  try {
    const a = Buffer.from(computedHash, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length === b.length && a.length > 0) {
      signatureValid = timingSafeEqual(a, b);
    }
  } catch {
    signatureValid = false;
  }
  if (!signatureValid) {
    return { ok: false, reason: 'bad_signature' };
  }

  // Freshness: `auth_date` is a unix-seconds integer.
  const authDateRaw = params.get('auth_date');
  const authDate = authDateRaw === null ? Number.NaN : Number(authDateRaw);
  if (!Number.isFinite(authDate) || !Number.isInteger(authDate) || authDate <= 0) {
    return { ok: false, reason: 'malformed' };
  }
  const nowSeconds = Math.floor((now ?? new Date()).getTime() / 1000);
  if (nowSeconds - authDate > maxAgeSeconds) {
    return { ok: false, reason: 'expired' };
  }

  // Trusted identity: parse the `user` blob.
  const userRaw = params.get('user');
  if (userRaw === null || userRaw.length === 0) {
    return { ok: false, reason: 'missing_user' };
  }
  let user: ParsedInitDataUser;
  try {
    const parsed = JSON.parse(userRaw) as Partial<ParsedInitDataUser> & { id?: unknown };
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      typeof parsed.id !== 'number' ||
      !Number.isFinite(parsed.id) ||
      typeof parsed.first_name !== 'string'
    ) {
      return { ok: false, reason: 'missing_user' };
    }
    user = parsed as ParsedInitDataUser;
  } catch {
    return { ok: false, reason: 'missing_user' };
  }

  // Optional fields — pass through verbatim so the caller can use them.
  const queryId = params.get('query_id');
  const startParam = params.get('start_param');
  const chatType = params.get('chat_type');
  const chatInstance = params.get('chat_instance');
  const signature = params.get('signature');
  const receiverRaw = params.get('receiver');
  const chatRaw = params.get('chat');

  const data: ParsedInitData = {
    raw: initData,
    user,
    auth_date: authDate,
    hash,
  };
  if (queryId !== null) data.query_id = queryId;
  if (startParam !== null) data.start_param = startParam;
  if (chatType !== null) data.chat_type = chatType;
  if (chatInstance !== null) data.chat_instance = chatInstance;
  if (signature !== null) data.signature = signature;
  if (receiverRaw !== null) {
    try {
      const r = JSON.parse(receiverRaw) as unknown;
      if (r !== null && typeof r === 'object') data.receiver = r as object;
    } catch {
      // The signature already covered this raw value; ignore parse errors and
      // simply omit the optional field.
    }
  }
  if (chatRaw !== null) {
    try {
      const c = JSON.parse(chatRaw) as unknown;
      if (c !== null && typeof c === 'object') data.chat = c as object;
    } catch {
      // See note above on `receiver`.
    }
  }

  return { ok: true, data };
}

/**
 * Convenience wrapper that throws an {@link AppError} with `PERMISSION_DENIED`
 * on any failure. The middleware uses this so it can rely on a single catch
 * site while still mapping every failure to a generic 401 response.
 */
export function verifyInitDataOrThrow(
  initData: string,
  botToken: string,
  maxAgeSeconds: number,
  now?: Date,
): ParsedInitData {
  const result = verifyInitData(initData, botToken, maxAgeSeconds, now);
  if (!result.ok) {
    throw new AppError(ErrorCode.PERMISSION_DENIED, 'invalid Telegram initData', {
      meta: { reason: result.reason },
    });
  }
  return result.data;
}
