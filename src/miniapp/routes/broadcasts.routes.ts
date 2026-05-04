/**
 * VaultLink Bot — Mini App `/broadcasts/*` routes.
 *
 * The composer + status surface for announcement broadcasts. Access is NOT
 * gated by `adminMiddleware` because non-admin bot owners must be able to
 * broadcast to their own bot's users — instead, every handler defers to
 * {@link BroadcastService} which enforces the founder-or-bot-owner predicate
 * at the service layer (and an extra time at the repo for transitions).
 *
 * Authentication (Telegram initData) is provided by the parent server's
 * global `/api/*` auth middleware, so every handler can rely on
 * `c.var.user` without re-checking.
 */

import { Hono } from 'hono';
import type { MiniAppEnv } from '../middlewares.js';
import type { AppServices, AppRepos } from '../types.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import {
  parseAudience,
} from '../../repositories/broadcast.repository.js';
import type {
  BroadcastButton,
  BroadcastParseMode,
  BroadcastRecipientStatus,
  BroadcastRow,
  BroadcastStatus,
} from '../../types/index.js';
import { defaultAudience, type CreateDraftInput } from '../../services/broadcast.service.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Strip stored JSON shapes for the wire — the frontend wants buttons and
 * audience as parsed objects, not strings. */
function broadcastDto(row: BroadcastRow): Record<string, unknown> {
  let buttons: BroadcastButton[][] | null = null;
  if (row.buttons_json) {
    try {
      const v = JSON.parse(row.buttons_json);
      if (Array.isArray(v)) buttons = v as BroadcastButton[][];
    } catch {
      buttons = null;
    }
  }
  return {
    id: row.id,
    bot_id: row.bot_id,
    created_by: row.created_by,
    status: row.status,
    text: row.text,
    parse_mode: row.parse_mode,
    media_type: row.media_type,
    media_file_id: row.media_file_id,
    buttons,
    disable_web_page_preview: row.disable_web_page_preview === 1,
    protect_content: row.protect_content === 1,
    silent: row.silent === 1,
    audience: parseAudience(row.audience_json),
    audience_count: row.audience_count,
    scheduled_at: row.scheduled_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    cancelled_at: row.cancelled_at,
    count_sent: row.count_sent,
    count_failed: row.count_failed,
    count_blocked: row.count_blocked,
    count_pending: row.count_pending,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

interface ComposerBody {
  bot_id?: unknown;
  text?: unknown;
  parse_mode?: unknown;
  media_type?: unknown;
  media_file_id?: unknown;
  buttons?: unknown;
  disable_web_page_preview?: unknown;
  protect_content?: unknown;
  silent?: unknown;
  audience?: unknown;
}

/** Read a composer body and project it onto the strict `CreateDraftInput`
 * shape (without checking permissions — the service does that). */
function readComposerBody(body: ComposerBody): CreateDraftInput {
  if (typeof body.bot_id !== 'number' || !Number.isFinite(body.bot_id)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'bot_id must be a number', { expose: true });
  }
  if (typeof body.text !== 'string') {
    throw new AppError(ErrorCode.INVALID_INPUT, 'text must be a string', { expose: true });
  }

  let parse_mode: BroadcastParseMode | null = null;
  if (body.parse_mode === 'HTML' || body.parse_mode === 'MarkdownV2') {
    parse_mode = body.parse_mode;
  } else if (body.parse_mode !== null && body.parse_mode !== undefined && body.parse_mode !== 'plain') {
    throw new AppError(
      ErrorCode.INVALID_INPUT,
      'parse_mode must be HTML, MarkdownV2, or plain',
      { expose: true },
    );
  }

  let buttons: BroadcastButton[][] | null = null;
  if (Array.isArray(body.buttons)) {
    buttons = [];
    for (const row of body.buttons) {
      if (!Array.isArray(row)) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'buttons must be a 2-D array', {
          expose: true,
        });
      }
      const r: BroadcastButton[] = [];
      for (const btn of row) {
        if (
          typeof btn !== 'object' ||
          btn === null ||
          typeof (btn as { text?: unknown }).text !== 'string' ||
          typeof (btn as { url?: unknown }).url !== 'string'
        ) {
          throw new AppError(
            ErrorCode.INVALID_INPUT,
            'each button must be {text, url}',
            { expose: true },
          );
        }
        r.push({
          text: (btn as { text: string }).text,
          url: (btn as { url: string }).url,
        });
      }
      buttons.push(r);
    }
  }

  let audience = defaultAudience();
  if (body.audience !== null && body.audience !== undefined) {
    if (typeof body.audience !== 'object') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'audience must be an object', { expose: true });
    }
    const a = body.audience as Record<string, unknown>;
    audience = {
      locale: a.locale === 'en' || a.locale === 'th' ? a.locale : 'all',
      role: a.role === 'super_admin' || a.role === 'user' ? a.role : 'all',
      exclude_banned: a.exclude_banned !== false,
      exclude_unsubscribed: a.exclude_unsubscribed !== false,
      registered_within_days:
        typeof a.registered_within_days === 'number' && a.registered_within_days > 0
          ? Math.floor(a.registered_within_days)
          : null,
      user_ids: Array.isArray(a.user_ids)
        ? a.user_ids.filter((v): v is string => typeof v === 'string')
        : [],
    };
  }

  const out: CreateDraftInput = {
    bot_id: body.bot_id,
    text: body.text,
    parse_mode,
    audience,
  };
  if (typeof body.media_type === 'string') out.media_type = body.media_type;
  if (typeof body.media_file_id === 'string') out.media_file_id = body.media_file_id;
  if (buttons !== null) out.buttons = buttons;
  if (typeof body.disable_web_page_preview === 'boolean') {
    out.disable_web_page_preview = body.disable_web_page_preview;
  }
  if (typeof body.protect_content === 'boolean') {
    out.protect_content = body.protect_content;
  }
  if (typeof body.silent === 'boolean') {
    out.silent = body.silent;
  }
  return out;
}

export interface BroadcastsRouteDeps {
  services: AppServices;
  repos: AppRepos;
}

export function broadcastsRoutes(deps: BroadcastsRouteDeps): Hono<MiniAppEnv> {
  const app = new Hono<MiniAppEnv>();
  const { services, repos } = deps;

  /* ----------------------------------------------------------------------- *
   * List + create
   * ----------------------------------------------------------------------- */

  app.get('/broadcasts', (c) => {
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const statusRaw = c.req.query('status');
    const botIdRaw = c.req.query('bot_id');
    const status: BroadcastStatus | null = statusRaw
      ? validateBroadcastStatus(statusRaw)
      : null;
    const botId = botIdRaw ? Number.parseInt(botIdRaw, 10) : null;
    if (botId !== null && !Number.isFinite(botId)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid bot_id', { expose: true });
    }
    const result = services.broadcast.list(c.var.user, {
      bot_id: botId,
      status,
      limit,
      offset,
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items: result.items.map(broadcastDto), total: result.total } });
  });

  app.post('/broadcasts', async (c) => {
    const body = await c.req.json<ComposerBody>().catch(() => ({}) as ComposerBody);
    const input = readComposerBody(body);
    const row = services.broadcast.createDraft(c.var.user, input);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: broadcastDto(row) }, 201);
  });

  /* ----------------------------------------------------------------------- *
   * Detail / update / delete
   * ----------------------------------------------------------------------- */

  app.get('/broadcasts/:id', (c) => {
    const id = parseId(c.req.param('id'));
    const row = services.broadcast.getById(c.var.user, id);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: broadcastDto(row) });
  });

  app.patch('/broadcasts/:id', async (c) => {
    const id = parseId(c.req.param('id'));
    const body = await c.req.json<ComposerBody>().catch(() => ({}) as ComposerBody);
    const partial = readComposerPatch(body);
    const updated = services.broadcast.updateDraft(c.var.user, id, partial);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: broadcastDto(updated) });
  });

  app.delete('/broadcasts/:id', (c) => {
    const id = parseId(c.req.param('id'));
    services.broadcast.deleteDraft(c.var.user, id);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { ok: true } });
  });

  /* ----------------------------------------------------------------------- *
   * Audience preview + test send
   * ----------------------------------------------------------------------- */

  app.post('/broadcasts/:id/audience-preview', (c) => {
    const id = parseId(c.req.param('id'));
    const preview = services.broadcast.audiencePreview(c.var.user, id);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: preview });
  });

  /* ----------------------------------------------------------------------- *
   * State transitions
   * ----------------------------------------------------------------------- */

  app.post('/broadcasts/:id/send', async (c) => {
    const id = parseId(c.req.param('id'));
    const body = await c.req
      .json<{ confirmation?: unknown }>()
      .catch(() => ({}) as { confirmation?: unknown });
    const confirmation =
      typeof body.confirmation === 'string' ? body.confirmation : '';
    const row = services.broadcast.send(c.var.user, id, confirmation);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: broadcastDto(row) });
  });

  app.post('/broadcasts/:id/schedule', async (c) => {
    const id = parseId(c.req.param('id'));
    const body = await c.req
      .json<{ scheduled_at?: unknown }>()
      .catch(() => ({}) as { scheduled_at?: unknown });
    const scheduledAt =
      typeof body.scheduled_at === 'string' ? body.scheduled_at : '';
    if (scheduledAt.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'scheduled_at is required', {
        expose: true,
      });
    }
    const row = services.broadcast.schedule(c.var.user, id, scheduledAt);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: broadcastDto(row) });
  });

  app.post('/broadcasts/:id/cancel', (c) => {
    const id = parseId(c.req.param('id'));
    const row = services.broadcast.cancel(c.var.user, id);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: broadcastDto(row) });
  });

  /* ----------------------------------------------------------------------- *
   * Recipients
   * ----------------------------------------------------------------------- */

  app.get('/broadcasts/:id/recipients', (c) => {
    const id = parseId(c.req.param('id'));
    // Permission check is via getById — throws if caller doesn't own.
    services.broadcast.getById(c.var.user, id);
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const statusRaw = c.req.query('status');
    const status: BroadcastRecipientStatus | null = statusRaw
      ? validateRecipientStatus(statusRaw)
      : null;
    const items = repos.broadcasts.listRecipients({
      broadcast_id: id,
      status,
      limit,
      offset,
    });
    const total = repos.broadcasts.countRecipients({ broadcast_id: id, status });
    // Enrich with user profiles in a single batch round-trip.
    const seen = new Map<number, ReturnType<typeof repos.users.findById>>();
    const dtos = items.map((r) => {
      if (!seen.has(r.user_id)) seen.set(r.user_id, repos.users.findById(r.user_id));
      const u = seen.get(r.user_id);
      return {
        id: r.id,
        broadcast_id: r.broadcast_id,
        user_id: r.user_id,
        telegram_user_id: r.telegram_user_id,
        status: r.status,
        message_id: r.message_id,
        error_code: r.error_code,
        error_message: r.error_message,
        retry_count: r.retry_count,
        sent_at: r.sent_at,
        failed_at: r.failed_at,
        user: u
          ? { username: u.username, first_name: u.first_name }
          : null,
      };
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items: dtos, total } });
  });

  return app;
}

function parseId(raw: string | undefined): number {
  const id = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(id)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'invalid id', { expose: true });
  }
  return id;
}

function validateBroadcastStatus(raw: string): BroadcastStatus {
  const ok = ['draft', 'scheduled', 'sending', 'completed', 'cancelled', 'failed'] as const;
  if ((ok as readonly string[]).includes(raw)) return raw as BroadcastStatus;
  throw new AppError(ErrorCode.INVALID_INPUT, `invalid status: ${raw}`, { expose: true });
}

function validateRecipientStatus(raw: string): BroadcastRecipientStatus {
  const ok = ['pending', 'sending', 'sent', 'failed', 'blocked', 'cancelled'] as const;
  if ((ok as readonly string[]).includes(raw)) return raw as BroadcastRecipientStatus;
  throw new AppError(ErrorCode.INVALID_INPUT, `invalid status: ${raw}`, { expose: true });
}

/** Same shape projection as `readComposerBody` but every field optional. */
function readComposerPatch(body: ComposerBody): Parameters<
  AppServices['broadcast']['updateDraft']
>[2] {
  const out: Parameters<AppServices['broadcast']['updateDraft']>[2] = {};
  if (body.text !== undefined) {
    if (typeof body.text !== 'string') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'text must be a string', { expose: true });
    }
    out.text = body.text;
  }
  if (body.parse_mode !== undefined) {
    if (
      body.parse_mode === null ||
      body.parse_mode === 'plain'
    ) {
      out.parse_mode = null;
    } else if (body.parse_mode === 'HTML' || body.parse_mode === 'MarkdownV2') {
      out.parse_mode = body.parse_mode;
    } else {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        'parse_mode must be HTML, MarkdownV2, or plain',
        { expose: true },
      );
    }
  }
  if (body.media_type !== undefined) {
    if (body.media_type === null) out.media_type = null;
    else if (typeof body.media_type === 'string') out.media_type = body.media_type;
  }
  if (body.media_file_id !== undefined) {
    if (body.media_file_id === null) out.media_file_id = null;
    else if (typeof body.media_file_id === 'string') out.media_file_id = body.media_file_id;
  }
  if (body.buttons !== undefined) {
    if (body.buttons === null) {
      out.buttons = null;
    } else if (Array.isArray(body.buttons)) {
      const parsed: BroadcastButton[][] = [];
      for (const row of body.buttons) {
        if (!Array.isArray(row)) continue;
        const r: BroadcastButton[] = [];
        for (const btn of row) {
          if (
            btn &&
            typeof btn === 'object' &&
            typeof (btn as { text?: unknown }).text === 'string' &&
            typeof (btn as { url?: unknown }).url === 'string'
          ) {
            r.push({
              text: (btn as { text: string }).text,
              url: (btn as { url: string }).url,
            });
          }
        }
        parsed.push(r);
      }
      out.buttons = parsed;
    }
  }
  if (typeof body.disable_web_page_preview === 'boolean') {
    out.disable_web_page_preview = body.disable_web_page_preview;
  }
  if (typeof body.protect_content === 'boolean') {
    out.protect_content = body.protect_content;
  }
  if (typeof body.silent === 'boolean') {
    out.silent = body.silent;
  }
  if (body.audience !== undefined) {
    if (typeof body.audience !== 'object' || body.audience === null) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'audience must be an object', { expose: true });
    }
    const a = body.audience as Record<string, unknown>;
    out.audience = {
      locale: a.locale === 'en' || a.locale === 'th' ? a.locale : 'all',
      role: a.role === 'super_admin' || a.role === 'user' ? a.role : 'all',
      exclude_banned: a.exclude_banned !== false,
      exclude_unsubscribed: a.exclude_unsubscribed !== false,
      registered_within_days:
        typeof a.registered_within_days === 'number' && a.registered_within_days > 0
          ? Math.floor(a.registered_within_days)
          : null,
      user_ids: Array.isArray(a.user_ids)
        ? a.user_ids.filter((v): v is string => typeof v === 'string')
        : [],
    };
  }
  return out;
}
