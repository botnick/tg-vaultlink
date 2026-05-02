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
  const log: Pick<Logger, 'info' | 'error'> = {
    info: (...args: unknown[]) => {
      try {
        cachedLogger ??= getLogger();
        (cachedLogger.info as (...a: unknown[]) => void)(...args);
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
    if (AppError.is(err)) {
      const status = statusForAppError(err);
      const body = {
        error: {
          code: err.code,
          message: err.expose ? err.message : 'internal error',
        },
      };
      if (status >= 500) {
        log.error({ err, code: err.code, meta: err.meta }, 'mini app: app error');
      }
      return c.json(body, status as 400 | 500);
    }
    log.error({ err }, 'mini app: unhandled error');
    return c.json({ error: { code: 'internal_error', message: 'internal error' } }, 500);
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
