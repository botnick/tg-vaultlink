/**
 * VaultLink Bot — Mini App backend middlewares.
 *
 * Three pieces:
 *
 *   - {@link corsMiddleware}: echoes the request `Origin` back when (and only
 *     when) it appears in `MINI_APP_ALLOWED_ORIGINS`. We never emit a
 *     wildcard — credentials-bearing requests must come from a known origin.
 *   - {@link authMiddleware}: verifies `Authorization: tma <initData>`,
 *     resolves the local user row via {@link UserService.ensureUser}, refuses
 *     banned accounts, and stashes both the parsed payload and the
 *     {@link UserRow} on `c.var` for downstream handlers.
 *   - {@link adminMiddleware}: denies non-admins. Must come *after*
 *     {@link authMiddleware} since it reads the `isAdmin` variable that the
 *     auth step computes.
 */

import type { Context, MiddlewareHandler } from 'hono';
import type { Config } from '../config/env.js';
import type { ParsedInitData } from './initData.js';
import { verifyInitDataOrThrow } from './initData.js';
import type { AppServices } from './types.js';
import type { UserRow } from '../types/index.js';
import { AppError } from '../utils/errors.js';
import { getLogger } from '../logger/logger.js';

/** Hono variable typings exposed by the Mini App middlewares. */
export interface MiniAppEnv {
  Variables: {
    /** Short random id stamped onto every request for log correlation. */
    reqId: string;
    initData: ParsedInitData;
    user: UserRow;
    /** True for super_admin (role) OR ADMIN_IDS (env). */
    isAdmin: boolean;
    /** Strict — true ONLY for ADMIN_IDS env members. Founders are the only
     * tier that can promote / demote other super admins. */
    isFounder: boolean;
  };
}

const AUTH_PREFIX = 'tma ';

/**
 * Render a JSON error response with `Cache-Control: no-store`. Status codes
 * follow the Mini App contract: 401 for auth failures, 403 for banned users
 * + admin-only routes, anything else routed via the global error handler.
 */
function jsonError(c: Context, status: number, code: string, message: string): Response {
  c.header('Cache-Control', 'no-store');
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/**
 * Verify the Telegram `initData` carried in `Authorization: tma <...>`,
 * upsert the local user row, and attach context for downstream handlers.
 */
export function authMiddleware(deps: {
  config: Config;
  services: AppServices;
}): MiddlewareHandler<MiniAppEnv> {
  const { config, services } = deps;
  return async (c, next) => {
    const header = c.req.header('Authorization') ?? c.req.header('authorization') ?? '';
    if (!header || !header.startsWith(AUTH_PREFIX)) {
      return jsonError(c, 401, 'unauthorized', 'Authorization header missing or malformed');
    }
    const initDataRaw = header.slice(AUTH_PREFIX.length).trim();
    if (initDataRaw.length === 0) {
      return jsonError(c, 401, 'unauthorized', 'empty initData');
    }

    let parsed: ParsedInitData;
    try {
      parsed = verifyInitDataOrThrow(
        initDataRaw,
        config.MAIN_BOT_TOKEN,
        config.MINI_APP_INITDATA_MAX_AGE_SECONDS,
      );
    } catch (err) {
      if (AppError.is(err)) {
        return jsonError(c, 401, 'unauthorized', 'invalid Telegram initData');
      }
      // Logger access is best-effort — `getLogger()` may throw in test
      // contexts that don't populate the env-driven config singleton.
      try {
        getLogger().error({ err }, 'mini app auth: unexpected verify failure');
      } catch {
        // Swallow; the caller still gets the 401 below.
      }
      return jsonError(c, 401, 'unauthorized', 'invalid Telegram initData');
    }

    // Trust ONLY the verified user blob — never honor IDs from request bodies.
    const userRow = services.user.ensureUser({
      telegram_user_id: String(parsed.user.id),
      username: parsed.user.username ?? null,
      first_name: parsed.user.first_name ?? null,
      last_name: parsed.user.last_name ?? null,
      language_code: parsed.user.language_code ?? null,
    });

    if (userRow.is_banned === 1) {
      return jsonError(c, 403, 'banned', 'this account is banned');
    }

    c.set('initData', parsed);
    c.set('user', userRow);
    c.set('isAdmin', services.permission.isAdmin(userRow));
    c.set('isFounder', services.permission.isFounder(userRow));

    await next();
    return;
  };
}

/**
 * Gate downstream handlers behind admin role. Re-checks `c.var.isAdmin`
 * even though `authMiddleware` already populated it — defense in depth.
 */
export function adminMiddleware(_deps: { services: AppServices }): MiddlewareHandler<MiniAppEnv> {
  return async (c, next) => {
    if (c.var.isAdmin !== true) {
      return jsonError(c, 403, 'forbidden', 'admin access required');
    }
    await next();
    return;
  };
}

/**
 * Permissive CORS for the Mini App. Echoes back the request `Origin` when
 * (and only when) it matches the configured allowlist. We never emit `*`
 * because the API is credentialed (the `Authorization` header carries the
 * caller's session).
 */
export function corsMiddleware(deps: { config: Config }): MiddlewareHandler {
  const allowed = new Set<string>(deps.config.MINI_APP_ALLOWED_ORIGINS);
  return async (c, next) => {
    const origin = c.req.header('Origin') ?? c.req.header('origin') ?? '';
    if (origin.length > 0 && allowed.has(origin)) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
      c.header('Access-Control-Allow-Credentials', 'true');
    }
    c.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Max-Age', '600');

    if (c.req.method === 'OPTIONS') {
      // Short-circuit pre-flight; no body needed.
      return new Response(null, {
        status: 204,
        headers: c.res.headers,
      });
    }

    await next();
    return;
  };
}
