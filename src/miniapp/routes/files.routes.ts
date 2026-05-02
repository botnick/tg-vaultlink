/**
 * VaultLink Bot — Mini App `/files` routes.
 *
 * Owner-scoped CRUD over the caller's vault items. Ownership is checked
 * against `c.var.user.id` (the verified Telegram identity) — admins are
 * allowed to inspect any file but the routes here intentionally do not
 * widen the listing for them; admin tooling lives under `/admin/*`.
 *
 * The list response trims sensitive / redundant columns; the detail
 * response adds the Telegram file id (so the frontend can offer a "send
 * me the file" action) but never `password_hash`.
 */

import { Hono } from 'hono';
import type { MiniAppEnv } from '../middlewares.js';
import type { AppServices, AppRepos, FileSummaryDto, FileDetailDto } from '../types.js';
import type { FileRow } from '../../types/index.js';
import { AppError, ErrorCode } from '../../utils/errors.js';

export interface FilesRouteDeps {
  services: AppServices;
  repos: AppRepos;
}

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

function toSummary(row: FileRow): FileSummaryDto {
  return {
    id: row.id,
    code: row.code,
    file_type: row.file_type,
    file_name: row.file_name,
    size_bytes: row.size_bytes,
    has_password: row.password_hash !== null,
    is_locked: row.is_locked === 1,
    is_deleted: row.is_deleted === 1,
    expires_at: row.expires_at,
    download_count: row.download_count,
    created_at: row.created_at,
  };
}

function toDetail(row: FileRow): FileDetailDto {
  return {
    ...toSummary(row),
    bot_id: row.bot_id,
    visibility: row.visibility,
    caption: row.caption,
    mime_type: row.mime_type,
    telegram_file_id: row.telegram_file_id,
    telegram_file_unique_id: row.telegram_file_unique_id,
    updated_at: row.updated_at,
  };
}

export function filesRoutes(deps: FilesRouteDeps): Hono<MiniAppEnv> {
  const app = new Hono<MiniAppEnv>();
  const { services, repos } = deps;

  app.get('/files', (c) => {
    const user = c.var.user;
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

    const items = services.file.listByOwner(user, { limit, offset }).map(toSummary);
    const total = services.file.countByOwner(user);

    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items, total } });
  });

  app.get('/files/:id', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid file id', { expose: true });
    }
    const file = repos.files.findById(id);
    if (!file) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }
    const decision = services.permission.canManageFile(c.var.user, file);
    if (!decision.allowed) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toDetail(file) });
  });

  app.delete('/files/:id', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid file id', { expose: true });
    }
    const file = repos.files.findById(id);
    if (!file) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }
    const decision = services.permission.canManageFile(c.var.user, file);
    if (!decision.allowed) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'not your file', { expose: true });
    }
    services.file.softDelete(file, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { ok: true } });
  });

  app.post('/files/:id/password', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid file id', { expose: true });
    }
    const body = await c.req
      .json<{ password?: unknown }>()
      .catch(() => ({}) as { password?: unknown });
    if (typeof body.password !== 'string' || body.password.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'password is required', { expose: true });
    }
    const file = repos.files.findById(id);
    if (!file) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }
    const decision = services.permission.canManageFile(c.var.user, file);
    if (!decision.allowed) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'not your file', { expose: true });
    }
    const updated = await services.file.setPassword(file, body.password, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toDetail(updated) });
  });

  app.delete('/files/:id/password', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid file id', { expose: true });
    }
    const file = repos.files.findById(id);
    if (!file) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }
    const decision = services.permission.canManageFile(c.var.user, file);
    if (!decision.allowed) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'not your file', { expose: true });
    }
    const updated = services.file.removePassword(file, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toDetail(updated) });
  });

  app.post('/files/:id/expiry', async (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid file id', { expose: true });
    }
    const body = await c.req.json<{ days?: unknown }>().catch(() => ({}) as { days?: unknown });
    let days: number | null;
    if (body.days === null || body.days === undefined) {
      days = null;
    } else if (
      typeof body.days === 'number' &&
      Number.isFinite(body.days) &&
      Number.isInteger(body.days) &&
      body.days >= 0
    ) {
      days = body.days;
    } else {
      throw new AppError(ErrorCode.INVALID_INPUT, 'days must be a non-negative integer or null', {
        expose: true,
      });
    }
    const file = repos.files.findById(id);
    if (!file) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }
    const decision = services.permission.canManageFile(c.var.user, file);
    if (!decision.allowed) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'not your file', { expose: true });
    }
    const updated = services.file.setExpiry(file, days, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toDetail(updated) });
  });

  return app;
}
