/**
 * VaultLink Bot — webhook listener (HTTP endpoint Telegram POSTs into).
 *
 * One Hono server hosts every bot we manage in webhook mode. Each bot is
 * routed by its numeric Telegram bot id at `/webhook/<bot_id>`. grammY's
 * `webhookCallback(bot, 'hono')` wraps the bot's update dispatcher so we
 * just plug it in — secret_token verification, body parsing, and 200/4xx
 * responses are handled there.
 *
 * The router is intentionally permissive on missing botIds (`404`) so an
 * attacker probing random paths can't tell which bot ids exist on the host.
 */

import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { webhookCallback, type Bot } from 'grammy';
import type { AppContext } from './context.js';
import { getLogger } from '../logger/logger.js';

export interface WebhookServer {
  /**
   * Wire `bot` so updates posted to `/webhook/<botId>` flow into it. Replaces
   * any prior registration for the same id (a token-regen happy path).
   */
  register(botId: string, bot: Bot<AppContext>, secretToken: string | null): void;
  /** Drop a previous registration. Idempotent. */
  unregister(botId: string): void;
  /** Bind the HTTP listener. Idempotent. */
  start(): Promise<void>;
  /** Close the HTTP listener. Idempotent. */
  stop(): Promise<void>;
  /** Snapshot of registered bot ids. */
  list(): string[];
}

export interface WebhookServerOptions {
  /** TCP port to bind. */
  port: number;
  /** Bind hostname. Defaults to `0.0.0.0` so a reverse proxy can reach it. */
  hostname?: string;
}

type HonoHandler = (c: Context) => Promise<Response> | Response;

/** Build a new webhook listener. Call {@link WebhookServer.start} to bind. */
export function createWebhookServer(opts: WebhookServerOptions): WebhookServer {
  const handlers = new Map<string, HonoHandler>();
  const app = new Hono();

  // Health probe — unauthenticated, no secret_token required, mirrors the
  // Mini App `/healthz` so reverse proxies can use one liveness rule.
  app.get('/healthz', (c) => {
    c.header('Cache-Control', 'no-store');
    return c.json({ status: 'ok' });
  });

  app.post('/webhook/:botId', (async (c: Context) => {
    const botId = c.req.param('botId');
    const handler = botId ? handlers.get(botId) : undefined;
    if (!handler) {
      // Don't leak whether the id exists.
      return c.json({ error: 'not found' }, 404);
    }
    return handler(c);
  }) satisfies MiddlewareHandler);

  app.notFound((c) => c.json({ error: 'not found' }, 404));

  let server: ServerType | undefined;
  const port = opts.port;
  const hostname = opts.hostname ?? '0.0.0.0';
  const log = getLogger();

  return {
    register(botId, bot, secretToken) {
      const cb = webhookCallback(bot, 'hono', {
        ...(secretToken !== null && secretToken.length > 0 ? { secretToken } : {}),
      }) as unknown as HonoHandler;
      handlers.set(botId, cb);
    },
    unregister(botId) {
      handlers.delete(botId);
    },
    list() {
      return [...handlers.keys()];
    },
    async start() {
      if (server !== undefined) return;
      await new Promise<void>((resolve) => {
        server = serve({ fetch: app.fetch, port, hostname }, () => {
          log.info({ port, hostname }, `webhook server listening on :${port}`);
          resolve();
        });
      });
    },
    async stop() {
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
