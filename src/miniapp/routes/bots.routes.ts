/**
 * VaultLink Bot — Mini App `/bots` routes.
 *
 * Owner-scoped management of registered child bots. Tokens (the encrypted
 * tuple `encrypted_token`/`token_nonce`/`token_auth_tag`) are stripped from
 * every response by passing rows through {@link toBotDto} — the type system
 * enforces this since {@link BotDto} simply does not declare those fields.
 */

import { Hono } from 'hono';
import type { MiniAppEnv } from '../middlewares.js';
import type { AppServices, AppRepos, BotDto } from '../types.js';
import type { BotMode, ManagedBotRow } from '../../types/index.js';
import { AppError, ErrorCode } from '../../utils/errors.js';

export interface BotsRouteDeps {
  services: AppServices;
  repos: AppRepos;
}

/**
 * Strip secret token columns from a managed-bot row before returning it to
 * the frontend. Centralizing this here means every route automatically
 * benefits — there's no code path that hands a raw `ManagedBotRow` to the
 * caller.
 */
export function toBotDto(row: ManagedBotRow): BotDto {
  return {
    id: row.id,
    owner_user_id: row.owner_user_id,
    telegram_bot_id: row.telegram_bot_id,
    username: row.username,
    display_name: row.display_name,
    mode: row.mode,
    status: row.status,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function botsRoutes(deps: BotsRouteDeps): Hono<MiniAppEnv> {
  const app = new Hono<MiniAppEnv>();
  const { services, repos } = deps;

  app.get('/bots', (c) => {
    const items = services.bot.listForOwner(c.var.user).map(toBotDto);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items } });
  });

  app.get('/bots/:id', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid bot id', { expose: true });
    }
    const bot = repos.bots.findById(id);
    if (!bot) {
      throw new AppError(ErrorCode.BOT_NOT_FOUND, 'bot not found', { expose: true });
    }
    const decision = services.permission.canManageBot(c.var.user, bot);
    if (!decision.allowed) {
      throw new AppError(ErrorCode.BOT_NOT_FOUND, 'bot not found', { expose: true });
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toBotDto(bot) });
  });

  app.post('/bots/:id/mode', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid bot id', { expose: true });
    }
    const body = await c.req.json<{ mode?: unknown }>().catch(() => ({}) as { mode?: unknown });
    const mode = body.mode;
    if (mode !== 'personal_public' && mode !== 'personal_private') {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        'mode must be personal_public or personal_private',
        { expose: true },
      );
    }
    const bot = repos.bots.findById(id);
    if (!bot) {
      throw new AppError(ErrorCode.BOT_NOT_FOUND, 'bot not found', { expose: true });
    }
    const decision = services.permission.canManageBot(c.var.user, bot);
    if (!decision.allowed) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'not your bot', { expose: true });
    }
    const updated = services.bot.setMode(bot, mode as BotMode, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toBotDto(updated) });
  });

  app.delete('/bots/:id', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid bot id', { expose: true });
    }
    const bot = repos.bots.findById(id);
    if (!bot) {
      throw new AppError(ErrorCode.BOT_NOT_FOUND, 'bot not found', { expose: true });
    }
    const decision = services.permission.canManageBot(c.var.user, bot);
    if (!decision.allowed) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'not your bot', { expose: true });
    }
    const updated = services.bot.remove(bot, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toBotDto(updated) });
  });

  return app;
}
