/**
 * VaultLink Mini App — typed fetch wrapper.
 *
 * Every call:
 *   1. Reads the base URL from `VITE_API_BASE_URL`.
 *   2. Attaches `Authorization: tma <initData>` so the backend can
 *      verify the call is coming from a real Telegram session.
 *   3. Unwraps the `{ data: T }` envelope on success.
 *   4. Throws a typed {@link ApiError} on any non-2xx response,
 *      lifting `error.code` / `error.message` from the body when
 *      the server returns the standard envelope.
 */

import { ApiError, type ApiErrorBody } from '../types/api.js';
import { getInitData } from './telegram.js';

const BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

interface ApiSuccessEnvelope<T> {
  data: T;
}

function isEnvelope<T>(v: unknown): v is ApiSuccessEnvelope<T> {
  return typeof v === 'object' && v !== null && 'data' in (v as Record<string, unknown>);
}

interface RequestOpts {
  body?: unknown;
  signal?: AbortSignal;
  /** Some endpoints (e.g. error fallbacks) return raw JSON without `data`. */
  rawEnvelope?: boolean;
}

async function request<T>(method: string, path: string, opts: RequestOpts = {}): Promise<T> {
  const initData = getInitData();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `tma ${initData}`,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const url = path.startsWith('http') ? path : `${BASE_URL}${path}`;
  let res: Response;
  try {
    const init: RequestInit = { method, headers, credentials: 'omit' };
    if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
    if (opts.signal !== undefined) init.signal = opts.signal;
    res = await fetch(url, init);
  } catch (err) {
    // Network failure (offline, CORS preflight rejected, etc).
    throw new ApiError(0, 'network_error', err instanceof Error ? err.message : 'network error');
  }

  if (res.status === 204) {
    return undefined as unknown as T;
  }

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // Server returned non-JSON; we'll handle below.
  }

  if (!res.ok) {
    const body = parsed as ApiErrorBody | null;
    const code = body?.error?.code ?? `http_${res.status}`;
    const message = body?.error?.message ?? `request failed (${res.status})`;
    throw new ApiError(res.status, code, message);
  }

  if (opts.rawEnvelope === true) return parsed as T;
  if (isEnvelope<T>(parsed)) return parsed.data;
  // Some endpoints (PATCH /settings, POST /reports) return `{ data: {...} }`
  // — but defensively also support flat returns.
  return parsed as T;
}

export const apiGet = <T>(path: string, signal?: AbortSignal): Promise<T> =>
  request<T>('GET', path, signal !== undefined ? { signal } : {});

export const apiPost = <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
  const opts: RequestOpts = {};
  if (body !== undefined) opts.body = body;
  if (signal !== undefined) opts.signal = signal;
  return request<T>('POST', path, opts);
};

export const apiPatch = <T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> => {
  const opts: RequestOpts = {};
  if (body !== undefined) opts.body = body;
  if (signal !== undefined) opts.signal = signal;
  return request<T>('PATCH', path, opts);
};

export const apiDelete = <T>(path: string, signal?: AbortSignal): Promise<T> =>
  request<T>('DELETE', path, signal !== undefined ? { signal } : {});

/** Re-export for ergonomic catch blocks: `if (e instanceof ApiError) ...` */
export { ApiError };
