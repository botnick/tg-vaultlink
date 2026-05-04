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
    const rows = repos.audit.list(opts);

    // Enrich each row with the actor's profile so the UI can show
    // `@username` / "Boat" instead of just `actor_user_id: 197`. Cache the
    // user lookup to avoid one query per row of the same actor.
    const userCache = new Map<number, { username: string | null; first_name: string | null }>();
    const items = rows.map((r) => {
      let actor: {
        id: number;
        telegram_user_id: string;
        username: string | null;
        first_name: string | null;
      } | null = null;
      if (r.actor_user_id !== null) {
        let cached = userCache.get(r.actor_user_id);
        if (cached === undefined) {
          const u = repos.users.findById(r.actor_user_id);
          cached = u
            ? { username: u.username, first_name: u.first_name }
            : { username: null, first_name: null };
          userCache.set(r.actor_user_id, cached);
        }
        const u = repos.users.findById(r.actor_user_id);
        if (u) {
          actor = {
            id: u.id,
            telegram_user_id: u.telegram_user_id,
            username: u.username,
            first_name: u.first_name,
          };
        }
      }
      return { ...r, actor };
    });

    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items } });
  });

  /* ----------------------------------------------------------------------- *
   * Admin — files (system-wide listing)
   * ----------------------------------------------------------------------- */

  app.get('/admin/files', (c) => {
    ensureAdmin(c.var.isAdmin);
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = repos.files.listAll({ limit, offset });

    // Enrich rows with owner + bot context so the admin UI can show
    // "@username's photo on @qqpptbot" without a chatty per-row lookup
    // round-trip from the frontend.
    const userCache = new Map<number, ReturnType<typeof repos.users.findById>>();
    const botCache = new Map<number, ReturnType<typeof repos.bots.findById>>();
    const items = rows.map((row) => {
      if (!userCache.has(row.owner_user_id)) {
        userCache.set(row.owner_user_id, repos.users.findById(row.owner_user_id));
      }
      if (!botCache.has(row.bot_id)) {
        botCache.set(row.bot_id, repos.bots.findById(row.bot_id));
      }
      const owner = userCache.get(row.owner_user_id);
      const bot = botCache.get(row.bot_id);
      return {
        ...fileToAdminDto(row),
        owner: owner
          ? {
              id: owner.id,
              telegram_user_id: owner.telegram_user_id,
              username: owner.username,
              first_name: owner.first_name,
            }
          : null,
        bot: bot ? { id: bot.id, username: bot.username, mode: bot.mode } : null,
      };
    });
    const total = repos.files.countAll();
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items, total } });
  });

  /* ----------------------------------------------------------------------- *
   * Admin — users (system-wide listing)
   * ----------------------------------------------------------------------- */

  app.get('/admin/users', (c) => {
    ensureAdmin(c.var.isAdmin);
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const q = (c.req.query('q') ?? '').trim();
    const rows =
      q.length > 0 ? repos.users.search(q, limit, offset) : repos.users.list(limit, offset);
    const total = q.length > 0 ? repos.users.countSearch(q) : repos.users.countAll();
    const items = rows.map((u) => ({
      id: u.id,
      telegram_user_id: u.telegram_user_id,
      username: u.username,
      first_name: u.first_name,
      last_name: u.last_name,
      locale: u.locale,
      role: u.role,
      is_banned: u.is_banned === 1,
      // Surfaced so the UI can decorate founder rows with the 🔑 pill and
      // hide the promote/demote affordance when the operator is looking
      // at one of their fellow founders.
      is_founder: services.permission.isFounder(u),
      created_at: u.created_at,
      updated_at: u.updated_at,
    }));
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items, total } });
  });

  /**
   * Founder-only: change a user's role. The body shape mirrors the bot
   * `/promote` / `/demote` commands: `{ role: 'super_admin' | 'user' }`.
   *
   * The auth gate is in TWO layers:
   *   1. `adminMiddleware` — already mounted on `/admin/*`.
   *   2. `permission.isFounder(c.var.user)` — strict ADMIN_IDS check.
   * Plus `userService.setRole` re-checks the same predicate server-side
   * so a missing middleware on a future endpoint can't open this path.
   */
  app.post('/admin/users/:id/role', async (c) => {
    ensureAdmin(c.var.isAdmin);
    if (!services.permission.isFounder(c.var.user)) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'founder only', { expose: true });
    }
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid user id', { expose: true });
    }
    const target = repos.users.findById(id);
    if (!target) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, 'user not found', { expose: true });
    }
    const body = await c.req.json<{ role?: unknown }>().catch(() => ({}) as { role?: unknown });
    const role = body.role;
    if (role !== 'super_admin' && role !== 'user') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'role must be super_admin or user', {
        expose: true,
      });
    }
    let updated;
    try {
      updated = services.user.setRole(target, role, c.var.user);
    } catch (err) {
      // Service layer raises AppError with `expose: true` for the user-input
      // failures (self-mutation, banned-promote, founder-demote). Forward
      // them as 400 so the frontend can surface the message verbatim.
      throw err;
    }
    services.audit.log(
      role === 'super_admin' ? 'user.promoted_to_super_admin' : 'user.demoted_from_super_admin',
      {
        actorUserId: c.var.user.id,
        targetType: 'user',
        targetId: String(target.id),
        metadata: { telegram_user_id: target.telegram_user_id, new_role: role },
      },
    );
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        id: updated.id,
        telegram_user_id: updated.telegram_user_id,
        username: updated.username,
        first_name: updated.first_name,
        role: updated.role,
        is_banned: updated.is_banned === 1,
        is_founder: services.permission.isFounder(updated),
      },
    });
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
