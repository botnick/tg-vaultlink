/**
 * VaultLink Bot — Mini App `/admin/*` routes.
 *
 * Every route here is gated by {@link adminMiddleware} (mounted by the
 * factory below) AND each handler re-checks `c.var.isAdmin` for defense in
 * depth — middleware order bugs should never widen access.
 *
 * Sensitive columns continue to be stripped: managed-bot listings flow
 * through {@link toBotDto} which never carries the encrypted-token tuple,
 * file responses never carry `password_hash`.
 */

import { Hono } from 'hono';
import type { MiniAppEnv } from '../middlewares.js';
import type { AppServices, AppRepos } from '../types.js';
import { adminMiddleware } from '../middlewares.js';
import { toBotDto } from './bots.routes.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import type { ReportStatus, FileRow, CollectionRow } from '../../types/index.js';

export interface AdminRouteDeps {
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

function ensureAdmin(isAdmin: boolean): void {
  if (isAdmin !== true) {
    throw new AppError(ErrorCode.PERMISSION_DENIED, 'admin access required', { expose: true });
  }
}

function fileToAdminDto(row: FileRow): Record<string, unknown> {
  // Never expose password_hash even to admins.
  return {
    id: row.id,
    code: row.code,
    bot_id: row.bot_id,
    owner_user_id: row.owner_user_id,
    file_type: row.file_type,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    visibility: row.visibility,
    has_password: row.password_hash !== null,
    is_locked: row.is_locked === 1,
    is_deleted: row.is_deleted === 1,
    expires_at: row.expires_at,
    download_count: row.download_count,
    telegram_file_id: row.telegram_file_id,
    telegram_file_unique_id: row.telegram_file_unique_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function collectionToAdminDto(row: CollectionRow): Record<string, unknown> {
  // Never expose password_hash even to admins.
  return {
    id: row.id,
    code: row.code,
    bot_id: row.bot_id,
    owner_user_id: row.owner_user_id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    has_password: row.password_hash !== null,
    is_locked: row.is_locked,
    is_deleted: row.is_deleted,
    total_items: row.total_items,
    download_count: row.download_count,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function adminRoutes(deps: AdminRouteDeps): Hono<MiniAppEnv> {
  const app = new Hono<MiniAppEnv>();
  const { services, repos } = deps;

  // Group every admin endpoint behind the role gate.
  app.use('/admin/*', adminMiddleware({ services }));

  app.get('/admin/stats', (c) => {
    ensureAdmin(c.var.isAdmin);
    const stats = {
      users: repos.users.countAll(),
      bots: repos.bots.countAll(),
      files: repos.files.countAll(),
      activeFiles: repos.files.countActive(),
      downloads: repos.files.totalDownloads(),
      pendingReports: services.report.countPending(),
    };
    c.header('Cache-Control', 'no-store');
    return c.json({ data: stats });
  });

  app.get('/admin/reports', (c) => {
    ensureAdmin(c.var.isAdmin);
    const status = (c.req.query('status') ?? 'pending') as ReportStatus;
    if (status !== 'pending' && status !== 'reviewed' && status !== 'dismissed') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid report status', { expose: true });
    }
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const items = repos.reports.listByStatus(status, limit, offset);
    const total = repos.reports.countByStatus(status);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items, total } });
  });

  app.patch('/admin/reports/:id', async (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid report id', { expose: true });
    }
    const body = await c.req.json<{ status?: unknown }>().catch(() => ({}) as { status?: unknown });
    const status = body.status;
    if (status !== 'reviewed' && status !== 'dismissed') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'status must be reviewed or dismissed', {
        expose: true,
      });
    }
    // The report service's setStatus only needs the row's id; we pass a
    // minimal stub so we don't depend on a `findById` accessor the repo
    // doesn't currently expose. The underlying UPDATE either matches by id
    // (and returns the freshly-written row) or returns undefined, in which
    // case the service raises INTERNAL_ERROR.
    const stub = {
      id,
      file_id: null,
      reporter_user_id: null,
      reason: '',
      status: 'pending' as ReportStatus,
      created_at: '',
      updated_at: '',
    };
    const updated = services.report.setStatus(stub, status, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: updated });
  });

  app.get('/admin/audit', (c) => {
    ensureAdmin(c.var.isAdmin);
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const actorRaw = c.req.query('actorUserId');
    const action = c.req.query('action');

    const opts: { limit: number; offset: number; actorUserId?: number; action?: string } = {
      limit,
      offset,
    };
    if (actorRaw !== undefined && actorRaw.length > 0) {
      const actorId = Number.parseInt(actorRaw, 10);
      if (!Number.isFinite(actorId)) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'invalid actorUserId', { expose: true });
      }
      opts.actorUserId = actorId;
    }
    if (action !== undefined && action.length > 0) {
      opts.action = action;
    }
    const items = repos.audit.list(opts);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items } });
  });

  app.get('/admin/bots', (c) => {
    ensureAdmin(c.var.isAdmin);
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const items = repos.bots.listAll({ limit, offset }).map(toBotDto);
    const total = repos.bots.countAll();
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items, total } });
  });

  app.post('/admin/files/:id/lock', (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid file id', { expose: true });
    }
    const file = repos.files.findById(id);
    if (!file) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }
    const updated = services.file.setLocked(file, true, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: fileToAdminDto(updated) });
  });

  app.delete('/admin/files/:id/lock', (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid file id', { expose: true });
    }
    const file = repos.files.findById(id);
    if (!file) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }
    const updated = services.file.setLocked(file, false, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: fileToAdminDto(updated) });
  });

  /* ----------------------------------------------------------------------- *
   * Admin — collections
   * ----------------------------------------------------------------------- */

  app.get('/admin/collections', (c) => {
    ensureAdmin(c.var.isAdmin);
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const ownerRaw = c.req.query('owner_user_id');
    const opts: { limit: number; offset: number; ownerUserId?: number } = {
      limit,
      offset,
    };
    if (ownerRaw !== undefined && ownerRaw.length > 0) {
      const ownerId = Number.parseInt(ownerRaw, 10);
      if (!Number.isFinite(ownerId)) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'invalid owner_user_id', { expose: true });
      }
      opts.ownerUserId = ownerId;
    }
    const rows = repos.collections.listAll(opts);
    const items = rows.map(collectionToAdminDto);
    // Per-owner counts can be derived; for the unbounded query we surface
    // the global count so the UI can paginate predictably.
    const total =
      opts.ownerUserId !== undefined
        ? repos.collections.countByOwner(opts.ownerUserId)
        : repos.collections.countAll();
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items, total } });
  });

  app.post('/admin/collections/:id/lock', (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid collection id', { expose: true });
    }
    const row = repos.collections.findById(id);
    if (!row) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'collection not available', {
        expose: true,
      });
    }
    const updated = services.share.setLocked(row, true, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: collectionToAdminDto(updated) });
  });

  app.delete('/admin/collections/:id/lock', (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid collection id', { expose: true });
    }
    const row = repos.collections.findById(id);
    if (!row) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'collection not available', {
        expose: true,
      });
    }
    const updated = services.share.setLocked(row, false, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: collectionToAdminDto(updated) });
  });

  app.delete('/admin/collections/:id', (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid collection id', { expose: true });
    }
    const row = repos.collections.findById(id);
    if (!row) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'collection not available', {
        expose: true,
      });
    }
    services.share.softDeleteCollection(row, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { ok: true } });
  });

  app.post('/admin/users/:id/ban', async (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid user id', { expose: true });
    }
    const target = repos.users.findById(id);
    if (!target) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, 'user not found', { expose: true });
    }
    const body = await c.req.json<{ reason?: unknown }>().catch(() => ({}) as { reason?: unknown });
    const reason = typeof body.reason === 'string' ? body.reason : null;
    const updated = services.user.setBanned(target, true);
    services.audit.log('user.banned', {
      actorUserId: c.var.user.id,
      targetType: 'user',
      targetId: String(target.id),
      metadata: reason !== null ? { reason } : null,
    });
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        id: updated.id,
        telegram_user_id: updated.telegram_user_id,
        is_banned: updated.is_banned === 1,
      },
    });
  });

  app.delete('/admin/users/:id/ban', (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid user id', { expose: true });
    }
    const target = repos.users.findById(id);
    if (!target) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, 'user not found', { expose: true });
    }
    const updated = services.user.setBanned(target, false);
    services.audit.log('user.unbanned', {
      actorUserId: c.var.user.id,
      targetType: 'user',
      targetId: String(target.id),
    });
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        id: updated.id,
        telegram_user_id: updated.telegram_user_id,
        is_banned: updated.is_banned === 1,
      },
    });
  });

  return app;
}
