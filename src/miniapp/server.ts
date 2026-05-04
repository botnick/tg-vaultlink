/**
 * VaultLink Bot — Mini App backend HTTP server.
 *
 * Builds a `Hono<MiniAppEnv>` instance with:
 *
 *   1. CORS middleware  (allowlist-driven; never `*`).
 *   2. `GET /healthz`  (unauthenticated; for upstream load balancers).
 *   3. Auth middleware  (Telegram initData verification).
 *   4. Sub-routers mounted under `/api/v1`:
 *      - settings + `/me`
 *      - files
 *      - bots
 *      - reports
 *      - admin (admin gate applied inside the sub-router)
 *
 * The HTTP listener is wired through `@hono/node-server`. `start()` returns
 * after the listener is bound; `stop()` shuts it down idempotently.
 *
 * Port resolution: we honor `MINI_APP_API_BASE_URL`'s `:port` if it carries
 * one, otherwise fall back to 8081 (the documented default for local
 * development). The hostname always binds to `0.0.0.0` since this server
 * typically sits behind a reverse proxy.
 */

import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import type { Config } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { getLogger } from '../logger/logger.js';
import type { Logger } from 'pino';
import type { AppServices, AppRepos } from './types.js';
import { authMiddleware, corsMiddleware, type MiniAppEnv } from './middlewares.js';
import { settingsRoutes } from './routes/settings.routes.js';
import { filesRoutes } from './routes/files.routes.js';
import { botsRoutes } from './routes/bots.routes.js';
import { reportsRoutes } from './routes/reports.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { collectionsRoutes } from './routes/collections.routes.js';

const DEFAULT_PORT = 8081;

/** Map an `AppError` onto an HTTP status. Exposed errors → 400, else 500. */
function statusForAppError(err: AppError): number {
  return err.expose ? 400 : 500;
}

/**
 * Resolve the bind port from `MINI_APP_API_BASE_URL`. Public-facing servers
 * are typically behind a proxy so the URL might point at port 443/80, but
 * for the purpose of *binding* we want a non-privileged dev-friendly port.
 * Behavior:
 *   - URL has explicit port → use it.
 *   - URL has no port → fall back to {@link DEFAULT_PORT}.
 *   - URL is malformed/empty → fall back to {@link DEFAULT_PORT}.
 */
export function derivePort(apiBaseUrl: string): number {
  if (!apiBaseUrl) return DEFAULT_PORT;
  try {
    const u = new URL(apiBaseUrl);
    if (u.port) {
      const n = Number.parseInt(u.port, 10);
      if (Number.isFinite(n) && n > 0 && n < 65_536) return n;
    }
    return DEFAULT_PORT;
  } catch {
    return DEFAULT_PORT;
  }
}

export interface MiniAppServerOptions {
  config: Config;
  services: AppServices;
  repos: AppRepos;
  /** Override the bind port (useful in tests). */
  port?: number;
  /** Override the bind hostname (defaults to `0.0.0.0`). */
  hostname?: string;
}

export interface MiniAppServer {
  /** Underlying Hono instance — exposed for in-process testing via `app.fetch`. */
  readonly app: Hono<MiniAppEnv>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Build the Mini App backend. The factory wires every middleware and route
 * but does not actually open a socket — call `start()` for that.
 */
export function createMiniAppServer(opts: MiniAppServerOptions): MiniAppServer {
  const { config, services, repos } = opts;
  // Resolve the logger lazily so tests that bypass `getConfig()` (and supply
  // a hand-rolled config object directly) don't trigger the env-loader's
  // strict validation when the server is built.
  let cachedLogger: Logger | undefined;
  const log: Pick<Logger, 'info' | 'warn' | 'error'> = {
    info: (...args: unknown[]) => {
      try {
        cachedLogger ??= getLogger();
        (cachedLogger.info as (...a: unknown[]) => void)(...args);
      } catch {
        // Logger unavailable in this environment — drop the line silently.
      }
    },
    warn: (...args: unknown[]) => {
      try {
        cachedLogger ??= getLogger();
        (cachedLogger.warn as (...a: unknown[]) => void)(...args);
      } catch {
        // Logger unavailable in this environment — drop the line silently.
      }
    },
    error: (...args: unknown[]) => {
      try {
        cachedLogger ??= getLogger();
        (cachedLogger.error as (...a: unknown[]) => void)(...args);
      } catch {
        // Logger unavailable in this environment — drop the line silently.
      }
    },
  };

  const app = new Hono<MiniAppEnv>();

  // CORS first, on every route, so preflights short-circuit before auth.
  app.use('*', corsMiddleware({ config }));

  // Request-id + diagnostic envelope. Stamps a short id onto every request
  // and surfaces it on every error log line and response header so a 500
  // can be matched 1:1 to its server-side stack. The id is also returned
  // to the client in the `X-Request-Id` response header so users can
  // forward it when reporting issues.
  app.use('*', async (c, next) => {
    const id = Math.random().toString(36).slice(2, 10);
    c.set('reqId', id);
    c.header('X-Request-Id', id);
    const start = Date.now();
    try {
      await next();
    } finally {
      // 5xx are real bugs → error. 4xx are expected (auth expiring,
      // permission denied, not-found probes, etc.) → warn so the error
      // log isn't flooded with normal traffic. 2xx stays quiet.
      const status = c.res.status;
      if (status >= 500) {
        log.error(
          {
            reqId: id,
            method: c.req.method,
            path: c.req.path,
            status,
            durationMs: Date.now() - start,
          },
          'mini app: request finished with 5xx',
        );
      } else if (status >= 400) {
        log.warn(
          {
            reqId: id,
            method: c.req.method,
            path: c.req.path,
            status,
            durationMs: Date.now() - start,
          },
          'mini app: request finished with 4xx',
        );
      }
    }
  });

  // Unauthenticated health check. Returning quickly here keeps platform
  // liveness probes from waiting on signature verification.
  app.get('/healthz', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ status: 'ok' });
  });

  // Authenticated API surface. The middleware short-circuits with a 401
  // response on any auth failure so the sub-routers can assume `c.var.user`.
  app.use('/api/*', authMiddleware({ config, services }));

  app.route('/api/v1', settingsRoutes({ config, services, repos }));
  app.route('/api/v1', filesRoutes({ services, repos }));
  app.route('/api/v1', collectionsRoutes({ config, services, repos }));
  app.route('/api/v1', botsRoutes({ services, repos }));
  app.route('/api/v1', reportsRoutes({ services, repos }));
  app.route('/api/v1', adminRoutes({ services, repos }));

  app.notFound((c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ error: { code: 'not_found', message: 'route not found' } }, 404);
  });

  app.onError((err, c) => {
    c.header('Cache-Control', 'no-store');
    const reqId = (c.var as { reqId?: string }).reqId ?? '-';
    const path = c.req.path;
    const method = c.req.method;

    if (AppError.is(err)) {
      const status = statusForAppError(err);
      const body = {
        error: {
          code: err.code,
          message: err.expose ? err.message : 'internal error',
          // Surface the request id to the client so users can quote it when
          // reporting an issue. Safe — it's already in the response header.
          requestId: reqId,
        },
      };
      // ALWAYS log AppErrors (even 400s) at error-level for now so we get a
      // full picture of what the Mini App is throwing. Easy to dial back
      // once 500 hunting is over.
      log.error(
        {
          reqId,
          method,
          path,
          status,
          code: err.code,
          expose: err.expose,
          meta: err.meta,
          stack: err.stack,
          cause: (err as { cause?: unknown }).cause,
        },
        `mini app: app error (${err.code})`,
      );
      return c.json(body, status as 400 | 500);
    }

    // Truly unexpected — log everything we can extract. This is the path
    // we expect the user's "500 on Telegram-related stuff" complaint to
    // hit; with reqId the next reproduction will pinpoint the route +
    // stack in one go.
    const e = err as Error & { cause?: unknown };
    log.error(
      {
        reqId,
        method,
        path,
        errMessage: e.message,
        errName: e.name,
        stack: e.stack,
        cause: e.cause,
      },
      'mini app: unhandled error',
    );
    return c.json(
      {
        error: { code: 'internal_error', message: 'internal error', requestId: reqId },
      },
      500,
    );
  });

  let server: ServerType | undefined;
  const port = opts.port ?? derivePort(config.MINI_APP_API_BASE_URL);
  const hostname = opts.hostname ?? '0.0.0.0';

  return {
    app,
    async start(): Promise<void> {
      if (server !== undefined) return;
      await new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, port, hostname }, () => {
          log.info({ port, hostname }, `mini app api listening on :${port}`);
          resolve();
        });
      });
    },
    async stop(): Promise<void> {
      const s = server;
      if (s === undefined) return;
      server = undefined;
      await new Promise<void>((resolve) => {
        s.close(() => {
          resolve();
        });
      });
    },
  };
}
