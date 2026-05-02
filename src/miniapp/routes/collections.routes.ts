/**
 * VaultLink Bot — Mini App `/collections` routes.
 *
 * Owner-scoped CRUD over the caller's multi-file shares. All mutations
 * route through {@link ShareService} so audit logs and feature-flag
 * gates remain centralized.
 *
 * Sensitive columns (`password_hash`) are intentionally absent from
 * every response. Items expose their `telegram_file_id` since the
 * frontend needs it to render a "send me this" affordance the same way
 * the file detail page does.
 *
 * Ownership: a collection row is visible to its owner OR any admin
 * (`c.var.isAdmin`). Anyone else gets a 404-shaped response so the
 * existence of unrelated collections never leaks.
 */

import { Hono } from 'hono';
import type { MiniAppEnv } from '../middlewares.js';
import type { AppServices, AppRepos } from '../types.js';
import type { Config } from '../../config/env.js';
import type {
  CollectionRow,
  CollectionItemRow,
  FileType,
  FileVisibility,
} from '../../types/index.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { formatShareCode } from '../../utils/shareCodeFormat.js';

export interface CollectionsRouteDeps {
  config: Config;
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

interface CollectionSummaryDto {
  id: number;
  code: string;
  /** Canonical display form `botname:CODE_<n>P_<m>V_<k>D` — what the user copies. */
  share_code: string;
  bot_id: number;
  title: string | null;
  description: string | null;
  visibility: FileVisibility;
  has_password: boolean;
  expires_at: string | null;
  is_locked: number;
  is_deleted: number;
  total_items: number;
  download_count: number;
  created_at: string;
  updated_at: string;
}

interface CollectionItemDto {
  id: number;
  telegram_file_id: string;
  file_type: FileType;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  caption: string | null;
  sort_order: number;
}

interface CollectionDetailDto extends CollectionSummaryDto {
  items: CollectionItemDto[];
  counts_by_type: Partial<Record<FileType, number>>;
}

/**
 * Resolve the canonical `botname:CODE_<n>P_<m>V_<k>D` form for a collection
 * row, looking up the owning bot to get its username and counting items by
 * type. Falls back to the bare code if either lookup somehow misses.
 */
function shareCodeForCollection(repos: AppRepos, row: CollectionRow): string {
  const bot = repos.bots.findById(row.bot_id);
  if (!bot) return row.code;
  const counts = repos.collections.countItemsByType(row.id);
  return formatShareCode(bot.username, row.code, counts);
}

function toSummary(repos: AppRepos, row: CollectionRow): CollectionSummaryDto {
  return {
    id: row.id,
    code: row.code,
    share_code: shareCodeForCollection(repos, row),
    bot_id: row.bot_id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    has_password: row.password_hash !== null,
    expires_at: row.expires_at,
    is_locked: row.is_locked,
    is_deleted: row.is_deleted,
    total_items: row.total_items,
    download_count: row.download_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function toItemDto(row: CollectionItemRow): CollectionItemDto {
  return {
    id: row.id,
    telegram_file_id: row.telegram_file_id,
    file_type: row.file_type,
    file_name: row.file_name,
    mime_type: row.mime_type,
    size_bytes: row.size_bytes,
    caption: row.caption,
    sort_order: row.sort_order,
  };
}

/**
 * Resolve the collection by id, enforcing visibility rules:
 *   - row must exist
 *   - row must not be soft-deleted
 *   - caller must be owner OR admin
 *
 * On any failure, throws `FILE_NOT_AVAILABLE` so the caller can't
 * distinguish "didn't exist" from "didn't belong to you".
 */
function loadOwned(
  deps: CollectionsRouteDeps,
  callerUserId: number,
  isAdmin: boolean,
  rawId: string,
): CollectionRow {
  const id = Number.parseInt(rawId, 10);
  if (!Number.isFinite(id)) {
    throw new AppError(ErrorCode.INVALID_INPUT, 'invalid collection id', { expose: true });
  }
  const row = deps.repos.collections.findById(id);
  if (!row || row.is_deleted === 1) {
    throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'collection not available', {
      expose: true,
    });
  }
  if (row.owner_user_id !== callerUserId && !isAdmin) {
    // Same opaque error so we never leak existence.
    throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'collection not available', {
      expose: true,
    });
  }
  return row;
}

export function collectionsRoutes(deps: CollectionsRouteDeps): Hono<MiniAppEnv> {
  const app = new Hono<MiniAppEnv>();
  const { services, repos } = deps;

  app.get('/collections', (c) => {
    const user = c.var.user;
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);

    const rows = services.share.listOwnerCollections(user, { limit, offset });
    const items = rows.map((row) => toSummary(repos, row));
    // Mirror the list filter (active-only) so the paging UI doesn't render
    // ghost pages composed entirely of soft-deleted rows.
    const total = repos.collections.countActiveByOwner(user.id);

    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items, total } });
  });

  app.get('/collections/:id', (c) => {
    const row = loadOwned(deps, c.var.user.id, c.var.isAdmin, c.req.param('id'));
    const limit = DEFAULT_LIMIT;
    const items = repos.collections.listItems(row.id, { limit, offset: 0 }).map(toItemDto);
    const counts = repos.collections.countItemsByType(row.id);
    const counts_by_type: Partial<Record<FileType, number>> = {};
    for (const [k, v] of Object.entries(counts)) {
      if (v > 0) counts_by_type[k as FileType] = v;
    }
    const detail: CollectionDetailDto = {
      ...toSummary(repos, row),
      items,
      counts_by_type,
    };
    c.header('Cache-Control', 'no-store');
    return c.json({ data: detail });
  });

  app.get('/collections/:id/items', (c) => {
    const row = loadOwned(deps, c.var.user.id, c.var.isAdmin, c.req.param('id'));
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const items = repos.collections.listItems(row.id, { limit, offset }).map(toItemDto);
    const total = repos.collections.countItems(row.id);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items, total } });
  });

  app.patch('/collections/:id', async (c) => {
    const row = loadOwned(deps, c.var.user.id, c.var.isAdmin, c.req.param('id'));
    const body = await c.req
      .json<{ title?: unknown; description?: unknown }>()
      .catch(() => ({}) as { title?: unknown; description?: unknown });

    const fields: { title?: string | null; description?: string | null } = {};
    if (Object.prototype.hasOwnProperty.call(body, 'title')) {
      const v = body.title;
      if (v !== null && typeof v !== 'string') {
        throw new AppError(ErrorCode.INVALID_INPUT, 'title must be a string or null', {
          expose: true,
        });
      }
      fields.title = v;
    }
    if (Object.prototype.hasOwnProperty.call(body, 'description')) {
      const v = body.description;
      if (v !== null && typeof v !== 'string') {
        throw new AppError(ErrorCode.INVALID_INPUT, 'description must be a string or null', {
          expose: true,
        });
      }
      fields.description = v;
    }
    if (fields.title === undefined && fields.description === undefined) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'no metadata fields to update', { expose: true });
    }
    const updated = services.share.setMetadata(row, fields, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toSummary(repos, updated) });
  });

  app.delete('/collections/:id', (c) => {
    const row = loadOwned(deps, c.var.user.id, c.var.isAdmin, c.req.param('id'));
    services.share.softDeleteCollection(row, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { ok: true } });
  });

  app.post('/collections/:id/password', async (c) => {
    const row = loadOwned(deps, c.var.user.id, c.var.isAdmin, c.req.param('id'));
    const body = await c.req
      .json<{ password?: unknown }>()
      .catch(() => ({}) as { password?: unknown });
    if (typeof body.password !== 'string' || body.password.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'password is required', { expose: true });
    }
    const updated = await services.share.setPassword(row, body.password, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toSummary(repos, updated) });
  });

  app.delete('/collections/:id/password', (c) => {
    const row = loadOwned(deps, c.var.user.id, c.var.isAdmin, c.req.param('id'));
    const updated = services.share.removePassword(row, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toSummary(repos, updated) });
  });

  app.post('/collections/:id/expiry', async (c) => {
    const row = loadOwned(deps, c.var.user.id, c.var.isAdmin, c.req.param('id'));
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
    const updated = services.share.setExpiry(row, days, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toSummary(repos, updated) });
  });

  app.post('/collections/:id/visibility', async (c) => {
    const row = loadOwned(deps, c.var.user.id, c.var.isAdmin, c.req.param('id'));
    const body = await c.req
      .json<{ visibility?: unknown }>()
      .catch(() => ({}) as { visibility?: unknown });
    if (body.visibility !== 'public' && body.visibility !== 'private') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'visibility must be "public" or "private"', {
        expose: true,
      });
    }
    const updated = services.share.setVisibility(row, body.visibility, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: toSummary(repos, updated) });
  });

  app.post('/collections/:id/items/reorder', async (c) => {
    const row = loadOwned(deps, c.var.user.id, c.var.isAdmin, c.req.param('id'));
    const body = await c.req
      .json<{ ordered_ids?: unknown }>()
      .catch(() => ({}) as { ordered_ids?: unknown });
    const raw = body.ordered_ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'ordered_ids must be a non-empty array', {
        expose: true,
      });
    }
    const orderedIds: number[] = [];
    for (const v of raw) {
      if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
        throw new AppError(ErrorCode.INVALID_INPUT, 'ordered_ids entries must be integers', {
          expose: true,
        });
      }
      orderedIds.push(v);
    }

    // Validate every id belongs to this collection BEFORE issuing the
    // transactional update so we can reject the whole request cleanly.
    const existing = repos.collections.listItems(row.id);
    const validIds = new Set(existing.map((it) => it.id));
    if (orderedIds.length !== existing.length) {
      throw new AppError(
        ErrorCode.INVALID_INPUT,
        'ordered_ids length must match the collection item count',
        { expose: true },
      );
    }
    for (const id of orderedIds) {
      if (!validIds.has(id)) {
        throw new AppError(ErrorCode.INVALID_INPUT, `unknown item id ${id}`, { expose: true });
      }
    }
    services.share.reorderItems(row, orderedIds, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { ok: true } });
  });

  app.delete('/collections/:id/items/:itemId', (c) => {
    const row = loadOwned(deps, c.var.user.id, c.var.isAdmin, c.req.param('id'));
    const itemId = Number.parseInt(c.req.param('itemId'), 10);
    if (!Number.isFinite(itemId)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid item id', { expose: true });
    }
    const items = repos.collections.listItems(row.id);
    const target = items.find((it) => it.id === itemId);
    if (!target) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'item not in this collection', {
        expose: true,
      });
    }
    services.share.removeItem(row, itemId, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { ok: true } });
  });

  return app;
}
