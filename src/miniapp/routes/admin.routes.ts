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
import type {
  ReportStatus,
  FileRow,
  CollectionRow,
  ReportRow,
  FileType,
} from '../../types/index.js';
import {
  buildReportTargetSummary,
  buildReporterChip,
  createReportEnrichCache,
} from '../lib/reportEnrich.js';
import type { BotResolver } from '../../services/broadcast.worker.js';

export interface AdminRouteDeps {
  services: AppServices;
  repos: AppRepos;
  /** Resolves a managed bot id to its running grammY instance. When
   * undefined (e.g. tests), the `send-to-me` endpoint short-circuits with
   * SERVICE_UNAVAILABLE rather than crashing. */
  resolveBot?: BotResolver;
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

/**
 * Dispatch a single Telegram send call by file_type. The caller has already
 * resolved the bot instance; this helper just routes the file id to the
 * right `bot.api.send*` method. Returns 1 on success so the caller can
 * accumulate `sent_count` across multiple items.
 */
type ResolvedBot = NonNullable<ReturnType<BotResolver>>;
async function sendOneByType(
  bot: ResolvedBot,
  chatId: string,
  fileType: FileType,
  fileId: string,
  caption: string | null,
): Promise<number> {
  const opts = caption ? { caption } : undefined;
  switch (fileType) {
    case 'photo':
      await bot.api.sendPhoto(chatId, fileId, opts);
      return 1;
    case 'video':
      await bot.api.sendVideo(chatId, fileId, opts);
      return 1;
    case 'audio':
      await bot.api.sendAudio(chatId, fileId, opts);
      return 1;
    case 'voice':
      await bot.api.sendVoice(chatId, fileId, opts);
      return 1;
    case 'animation':
      await bot.api.sendAnimation(chatId, fileId, opts);
      return 1;
    case 'sticker':
      await bot.api.sendSticker(chatId, fileId);
      return 1;
    case 'document':
    default:
      await bot.api.sendDocument(chatId, fileId, opts);
      return 1;
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
  const { services, repos, resolveBot } = deps;

  // Group every admin endpoint behind the role gate.
  app.use('/admin/*', adminMiddleware({ services }));

  app.get('/admin/stats', (c) => {
    ensureAdmin(c.var.isAdmin);
    const nowIso = new Date().toISOString();
    const stats = {
      users: repos.users.countAll(),
      bots: repos.bots.countAll(),
      files: repos.files.countAll(),
      activeFiles: repos.files.countActive(),
      downloads: repos.files.totalDownloads(),
      pendingReports: services.report.countPending(),
      // Wave 9.2 — health tiles for the Mini App admin dashboard.
      bannedUsers: repos.users.countBanned(),
      superAdmins: repos.users.countByRole('super_admin'),
      spendLockedUsers: repos.users.countSpendLockedAt(nowIso),
      pendingCryptoInvoices: repos.cryptoInvoices.countPending(),
    };
    c.header('Cache-Control', 'no-store');
    return c.json({ data: stats });
  });

  /* ----------------------------- Wave 9.2 — admin dashboard sub-stats --- */

  /**
   * Aggregates by `credit_transactions.reason` — total + 24h + 7d windows.
   * Single SQL per reason (3 short queries) so the page renders quickly
   * even on a busy ledger.
   */
  app.get('/admin/stats/credits', (c) => {
    ensureAdmin(c.var.isAdmin);
    const reasons: ReadonlyArray<
      | 'signup_bonus'
      | 'referral_reward'
      | 'spend_decode'
      | 'spend_collection_open'
      | 'spend_collection_send'
      | 'refund'
      | 'topup'
      | 'topup_refund'
      | 'admin_writeoff'
      | 'admin_adjust'
      | 'admin_set'
    > = [
      'signup_bonus',
      'referral_reward',
      'spend_decode',
      'spend_collection_open',
      'spend_collection_send',
      'refund',
      'topup',
      'topup_refund',
      'admin_writeoff',
      'admin_adjust',
      'admin_set',
    ];
    const dayMs = 24 * 3600 * 1000;
    const since24h = new Date(Date.now() - dayMs).toISOString();
    const since7d = new Date(Date.now() - 7 * dayMs).toISOString();
    const out: Record<string, { lifetime: number; last24h: number; last7d: number; count: number }> = {};
    for (const r of reasons) {
      const lifetime = repos.credits.aggregateByReason(r);
      const day = repos.credits.aggregateByReasonSince(r, since24h);
      const week = repos.credits.aggregateByReasonSince(r, since7d);
      out[r] = {
        lifetime: lifetime.total,
        last24h: day.total,
        last7d: week.total,
        count: lifetime.count,
      };
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { reasons: out } });
  });

  /**
   * Stars top-up funnel + 7-day timeseries. Drives the revenue card and the
   * sparkline on the admin dashboard. Refunds reported separately as a
   * lifetime + 7-day pair, plus loss = sum(stars refunded) - sum(stars
   * recovered) (currently always equal — Stars are atomic).
   */
  app.get('/admin/stats/payments', (c) => {
    ensureAdmin(c.var.isAdmin);
    const dayMs = 24 * 3600 * 1000;
    const since7d = new Date(Date.now() - 7 * dayMs).toISOString();
    const topupLifetime = repos.credits.aggregateByReason('topup');
    const topup7d = repos.credits.aggregateByReasonSince('topup', since7d);
    const refundLifetime = repos.credits.aggregateByReason('topup_refund');
    const refund7d = repos.credits.aggregateByReasonSince('topup_refund', since7d);
    // Build a stable 7-bar timeseries even when some days have zero topups.
    const seriesRows = repos.credits.topupTimeseriesSince('topup', since7d);
    const byDay = new Map<string, { credits: number; count: number }>();
    for (const row of seriesRows) byDay.set(row.day, { credits: row.credits, count: row.count });
    const series: Array<{ day: string; credits: number; count: number }> = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * dayMs);
      const day = d.toISOString().slice(0, 10);
      const cell = byDay.get(day);
      series.push({
        day,
        credits: cell?.credits ?? 0,
        count: cell?.count ?? 0,
      });
    }
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        topup: {
          lifetimeCredits: topupLifetime.total,
          lifetimeCount: topupLifetime.count,
          last7dCredits: topup7d.total,
          last7dCount: topup7d.count,
        },
        refunds: {
          // delta on `topup_refund` rows is negative (clawback). Surface as
          // an absolute number for the dashboard.
          lifetimeCreditsClawedBack: -refundLifetime.total,
          lifetimeCount: refundLifetime.count,
          last7dCreditsClawedBack: -refund7d.total,
          last7dCount: refund7d.count,
        },
        series,
      },
    });
  });

  /**
   * Crypto invoice mix: counts grouped by (chain, status) + last-7d
   * confirmed-credit value.
   */
  app.get('/admin/stats/crypto', (c) => {
    ensureAdmin(c.var.isAdmin);
    const dayMs = 24 * 3600 * 1000;
    const since7d = new Date(Date.now() - 7 * dayMs).toISOString();
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        grouped: repos.cryptoInvoices.groupedCounts(),
        last7dConfirmedCredits: repos.cryptoInvoices.sumConfirmedCreditsSince(since7d),
        pending: repos.cryptoInvoices.countByStatuses([
          'pending',
          'submitted',
          'confirming',
        ]),
        expired: repos.cryptoInvoices.countByStatuses(['expired']),
        failed: repos.cryptoInvoices.countByStatuses(['failed']),
        confirmed: repos.cryptoInvoices.countByStatuses(['confirmed']),
      },
    });
  });

  /**
   * Recent audit-log activity for the dashboard's "Recent activity" card.
   * Up to `limit` rows enriched with actor's display name. Same enrichment
   * pattern as `/admin/audit` but capped tightly so the dashboard load
   * stays cheap.
   */
  app.get('/admin/stats/recent', (c) => {
    ensureAdmin(c.var.isAdmin);
    const limit = clampInt(c.req.query('limit'), 20, 1, 50);
    const rows = repos.audit.list({ limit, offset: 0 });
    const userCache = new Map<number, { username: string | null; first_name: string | null }>();
    const items = rows.map((r) => {
      let actor: { username: string | null; first_name: string | null } | null = null;
      if (r.actor_user_id !== null) {
        let cached = userCache.get(r.actor_user_id);
        if (cached === undefined) {
          const u = repos.users.findById(r.actor_user_id);
          cached = u
            ? { username: u.username, first_name: u.first_name }
            : { username: null, first_name: null };
          userCache.set(r.actor_user_id, cached);
        }
        actor = cached;
      }
      return {
        id: r.id,
        action: r.action,
        target_type: r.target_type,
        target_id: r.target_id,
        actor_user_id: r.actor_user_id,
        actor,
        created_at: r.created_at,
      };
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items } });
  });

  /**
   * Build the enriched DTO the moderator UI consumes. Cache is shared across
   * the items in one paginated batch so a single page that lists 20 reports
   * against the same file or owner only hits the DB once per id.
   */
  function enrichReportRow(report: ReportRow, cache = createReportEnrichCache()) {
    const target = buildReportTargetSummary(repos, report, cache);
    const reporter = buildReporterChip(repos, report.reporter_user_id, cache);
    const pending_count_for_target = repos.reports.countPendingForTarget(
      report.target_type,
      report.target_id,
    );
    const other_reports_count = repos.reports.countOtherForTarget(
      report.target_type,
      report.target_id,
      report.id,
    );
    return {
      id: report.id,
      target_type: report.target_type,
      target_id: report.target_id,
      reporter_user_id: report.reporter_user_id,
      reason: report.reason,
      reason_category: report.reason_category,
      status: report.status,
      created_at: report.created_at,
      updated_at: report.updated_at,
      target,
      reporter,
      pending_count_for_target,
      other_reports_count,
    };
  }

  app.get('/admin/reports', (c) => {
    ensureAdmin(c.var.isAdmin);
    const status = (c.req.query('status') ?? 'pending') as ReportStatus;
    if (status !== 'pending' && status !== 'reviewed' && status !== 'dismissed') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid report status', { expose: true });
    }
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = repos.reports.listByStatus(status, limit, offset);
    const cache = createReportEnrichCache();
    const items = rows.map((r) => enrichReportRow(r, cache));
    const total = repos.reports.countByStatus(status);
    // Status counts power the tab badges in the admin UI without an extra
    // round-trip per tab change.
    const counts = {
      pending: repos.reports.countByStatus('pending'),
      reviewed: repos.reports.countByStatus('reviewed'),
      dismissed: repos.reports.countByStatus('dismissed'),
    };
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items, total, counts } });
  });

  app.get('/admin/reports/:id', (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid report id', { expose: true });
    }
    const report = services.report.findById(id);
    if (!report) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'report not found', { expose: true });
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ data: enrichReportRow(report) });
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
    const report = services.report.findById(id);
    if (!report) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'report not found', { expose: true });
    }
    services.report.setStatus(report, status, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: enrichReportRow({ ...report, status }) });
  });

  /**
   * Bulk update a list of report ids. Body: `{ ids: number[], status:
   * 'reviewed' | 'dismissed' }`. Caps at 50 ids per call so the transaction
   * stays small. Unknown ids are silently skipped — the response counts
   * report how many rows actually transitioned.
   */
  app.post('/admin/reports/bulk', async (c) => {
    ensureAdmin(c.var.isAdmin);
    const body = await c.req
      .json<{ ids?: unknown; status?: unknown }>()
      .catch(() => ({}) as { ids?: unknown; status?: unknown });
    const status = body.status;
    if (status !== 'reviewed' && status !== 'dismissed') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'status must be reviewed or dismissed', {
        expose: true,
      });
    }
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'ids must be a non-empty array', {
        expose: true,
      });
    }
    if (body.ids.length > 50) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'too many ids (max 50)', { expose: true });
    }
    const ids: number[] = [];
    for (const raw of body.ids) {
      if (typeof raw === 'number' && Number.isFinite(raw) && Number.isInteger(raw) && raw > 0) {
        ids.push(raw);
      }
    }
    let updated = 0;
    let skipped = 0;
    for (const id of ids) {
      const r = services.report.findById(id);
      if (!r) {
        skipped += 1;
        continue;
      }
      services.report.setStatus(r, status, c.var.user);
      updated += 1;
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { updated, skipped, status } });
  });

  /* --------------------------------------------------------------------- *
   * Per-report moderation actions.
   *
   * These all require the underlying file/collection to still exist; if it
   * has been hard-deleted (which the system does not currently do) the
   * action 404s. Audit logs reference both the report id and the target id
   * so the trail is searchable from either side.
   * --------------------------------------------------------------------- */

  app.post('/admin/reports/:id/lock', (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid report id', { expose: true });
    }
    const report = services.report.findById(id);
    if (!report) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'report not found', { expose: true });
    }
    if (report.target_type === 'file') {
      const file = repos.files.findById(report.target_id);
      if (!file) {
        throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
      }
      services.file.setLocked(file, true, c.var.user);
    } else {
      const col = repos.collections.findById(report.target_id);
      if (!col) {
        throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'collection not available', {
          expose: true,
        });
      }
      services.share.setLocked(col, true, c.var.user);
    }
    services.audit.log('report.target_locked', {
      actorUserId: c.var.user.id,
      targetType: 'report',
      targetId: String(report.id),
      metadata: { target_type: report.target_type, target_id: report.target_id },
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ data: enrichReportRow(report) });
  });

  app.delete('/admin/reports/:id/lock', (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid report id', { expose: true });
    }
    const report = services.report.findById(id);
    if (!report) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'report not found', { expose: true });
    }
    if (report.target_type === 'file') {
      const file = repos.files.findById(report.target_id);
      if (!file) {
        throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
      }
      services.file.setLocked(file, false, c.var.user);
    } else {
      const col = repos.collections.findById(report.target_id);
      if (!col) {
        throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'collection not available', {
          expose: true,
        });
      }
      services.share.setLocked(col, false, c.var.user);
    }
    services.audit.log('report.target_unlocked', {
      actorUserId: c.var.user.id,
      targetType: 'report',
      targetId: String(report.id),
      metadata: { target_type: report.target_type, target_id: report.target_id },
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ data: enrichReportRow(report) });
  });

  app.delete('/admin/reports/:id/target', (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid report id', { expose: true });
    }
    const report = services.report.findById(id);
    if (!report) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'report not found', { expose: true });
    }
    if (report.target_type === 'file') {
      const file = repos.files.findById(report.target_id);
      if (!file) {
        throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
      }
      services.file.softDelete(file, c.var.user);
    } else {
      const col = repos.collections.findById(report.target_id);
      if (!col) {
        throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'collection not available', {
          expose: true,
        });
      }
      services.share.softDeleteCollection(col, c.var.user);
    }
    // Auto-mark the originating report reviewed since the target is gone.
    services.report.setStatus(report, 'reviewed', c.var.user);
    services.audit.log('report.target_deleted', {
      actorUserId: c.var.user.id,
      targetType: 'report',
      targetId: String(report.id),
      metadata: { target_type: report.target_type, target_id: report.target_id },
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { ok: true } });
  });

  /**
   * Ban the owner of the reported target. 404 if owner / target missing,
   * 400 if the owner is a founder (env ADMIN_IDS) — those have to be
   * removed at the env layer first. Caller's role check is the same gate
   * that protects `/admin/users/:id/ban`.
   */
  app.post('/admin/reports/:id/ban-owner', async (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid report id', { expose: true });
    }
    const report = services.report.findById(id);
    if (!report) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'report not found', { expose: true });
    }
    let ownerId: number | null = null;
    if (report.target_type === 'file') {
      const file = repos.files.findById(report.target_id);
      if (file) ownerId = file.owner_user_id;
    } else {
      const col = repos.collections.findById(report.target_id);
      if (col) ownerId = col.owner_user_id;
    }
    if (ownerId === null) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, 'owner not found', { expose: true });
    }
    const target = repos.users.findById(ownerId);
    if (!target) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, 'owner not found', { expose: true });
    }
    if (services.permission.isFounder(target)) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'cannot ban a founder', { expose: true });
    }
    const body = await c.req
      .json<{ reason?: unknown }>()
      .catch(() => ({}) as { reason?: unknown });
    const reason = typeof body.reason === 'string' ? body.reason : null;
    services.user.setBanned(target, true);
    services.audit.log('user.banned', {
      actorUserId: c.var.user.id,
      targetType: 'user',
      targetId: String(target.id),
      metadata: { reason, via_report_id: report.id, role: 'owner' },
    });
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        id: target.id,
        telegram_user_id: target.telegram_user_id,
        is_banned: true,
      },
    });
  });

  /**
   * Ban the reporter — used when someone is filing false / abusive reports.
   * Same shape as ban-owner but resolves the user via reporter_user_id.
   */
  app.post('/admin/reports/:id/ban-reporter', async (c) => {
    ensureAdmin(c.var.isAdmin);
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid report id', { expose: true });
    }
    const report = services.report.findById(id);
    if (!report) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'report not found', { expose: true });
    }
    if (report.reporter_user_id === null) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, 'reporter not retained on this row', {
        expose: true,
      });
    }
    const target = repos.users.findById(report.reporter_user_id);
    if (!target) {
      throw new AppError(ErrorCode.USER_NOT_FOUND, 'reporter not found', { expose: true });
    }
    if (services.permission.isFounder(target)) {
      throw new AppError(ErrorCode.PERMISSION_DENIED, 'cannot ban a founder', { expose: true });
    }
    const body = await c.req
      .json<{ reason?: unknown }>()
      .catch(() => ({}) as { reason?: unknown });
    const reason = typeof body.reason === 'string' ? body.reason : null;
    services.user.setBanned(target, true);
    services.audit.log('user.banned', {
      actorUserId: c.var.user.id,
      targetType: 'user',
      targetId: String(target.id),
      metadata: { reason, via_report_id: report.id, role: 'reporter' },
    });
    // Also dismiss the originating report — the reporter has been actioned.
    services.report.setStatus(report, 'dismissed', c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        id: target.id,
        telegram_user_id: target.telegram_user_id,
        is_banned: true,
      },
    });
  });

  /**
   * Forward the reported content to the moderator's Telegram chat. The send
   * is performed by the OWNING bot (so the moderator can see exactly what a
   * downloader would receive). Implementation choices:
   *
   *   - We dispatch by `file_type` rather than relying on a generic
   *     `copyMessage`, because Telegram's `copyMessage` requires a
   *     `from_chat_id` we don't have — only a `telegram_file_id`. The
   *     `sendDocument`/`sendPhoto`/etc family accepts file ids directly.
   *   - For collections we send up to 10 items; groupable types (photo +
   *     video) are batched via `sendMediaGroup`, the rest are sent
   *     one-by-one. The cap mirrors Telegram's media-group ceiling.
   *   - All errors from the Telegram API are caught and surfaced as
   *     `EXTERNAL_SERVICE_ERROR` so the UI can render a clean message.
   */
  app.post('/admin/reports/:id/send-to-me', async (c) => {
    ensureAdmin(c.var.isAdmin);
    if (!resolveBot) {
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        'preview delivery is not available in this deployment',
        { expose: true },
      );
    }
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid report id', { expose: true });
    }
    const report = services.report.findById(id);
    if (!report) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'report not found', { expose: true });
    }

    const moderatorChatId = c.var.user.telegram_user_id;

    let botId: number;
    type Payload =
      | { kind: 'single'; file_type: FileType; telegram_file_id: string; caption: string | null }
      | {
          kind: 'collection';
          items: Array<{
            file_type: FileType;
            telegram_file_id: string;
            caption: string | null;
          }>;
          title: string | null;
        };
    let payload: Payload;

    if (report.target_type === 'file') {
      const file = repos.files.findById(report.target_id);
      if (!file) {
        throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
      }
      botId = file.bot_id;
      payload = {
        kind: 'single',
        file_type: file.file_type,
        telegram_file_id: file.telegram_file_id,
        caption: file.caption,
      };
    } else {
      const collection = repos.collections.findById(report.target_id);
      if (!collection) {
        throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'collection not available', {
          expose: true,
        });
      }
      botId = collection.bot_id;
      const items = repos.collections
        .listItems(collection.id, { limit: 10, offset: 0 })
        .map((it) => ({
          file_type: it.file_type,
          telegram_file_id: it.telegram_file_id,
          caption: it.caption,
        }));
      payload = { kind: 'collection', items, title: collection.title };
    }

    const bot = resolveBot(botId);
    if (!bot) {
      throw new AppError(
        ErrorCode.SERVICE_UNAVAILABLE,
        'owning bot is offline; try again later',
        { expose: true },
      );
    }

    const headerLines = [
      `🚩 Report #${report.id} preview`,
      `target: ${report.target_type} #${report.target_id}`,
      `reason: ${report.reason_category} — ${report.reason}`,
    ];
    let sentCount = 0;
    try {
      // Header text first so the moderator has context above the media.
      await bot.api.sendMessage(moderatorChatId, headerLines.join('\n'));

      if (payload.kind === 'single') {
        sentCount = await sendOneByType(
          bot,
          moderatorChatId,
          payload.file_type,
          payload.telegram_file_id,
          payload.caption,
        );
      } else {
        // Group photos + videos into a single sendMediaGroup call where
        // possible; everything else falls through to per-item sends.
        // Loose shape compatible with grammy's `InputMediaPhoto |
        // InputMediaVideo`; we cast at the call site so we don't need to
        // import the full Telegram media-input types just to splice
        // captions in.
        const groupable: Array<{ type: 'photo' | 'video'; media: string; caption?: string }> = [];
        const others: Array<{
          file_type: FileType;
          telegram_file_id: string;
          caption: string | null;
        }> = [];
        for (const it of payload.items) {
          if (it.file_type === 'photo' || it.file_type === 'video') {
            // exactOptionalPropertyTypes forbids `caption: undefined`, so
            // only spread the caption when it's actually a string.
            if (it.caption) {
              groupable.push({
                type: it.file_type,
                media: it.telegram_file_id,
                caption: it.caption,
              });
            } else {
              groupable.push({ type: it.file_type, media: it.telegram_file_id });
            }
          } else {
            others.push(it);
          }
        }
        if (groupable.length > 0) {
          // Telegram requires 2..10 items for sendMediaGroup; one-item
          // groups fall through to the per-item path.
          if (groupable.length === 1) {
            const only = groupable[0]!;
            others.push({
              file_type: only.type,
              telegram_file_id: only.media,
              caption: only.caption ?? null,
            });
          } else {
            await bot.api.sendMediaGroup(
              moderatorChatId,
              groupable as Parameters<typeof bot.api.sendMediaGroup>[1],
            );
            sentCount += groupable.length;
          }
        }
        for (const it of others) {
          sentCount += await sendOneByType(
            bot,
            moderatorChatId,
            it.file_type,
            it.telegram_file_id,
            it.caption,
          );
        }
      }
    } catch (cause) {
      throw new AppError(ErrorCode.EXTERNAL_SERVICE_ERROR, 'failed to forward content', {
        expose: true,
        cause,
        meta: { report_id: report.id },
      });
    }

    services.audit.log('report.previewed_by_admin', {
      actorUserId: c.var.user.id,
      targetType: 'report',
      targetId: String(report.id),
      metadata: {
        target_type: report.target_type,
        target_id: report.target_id,
        sent_count: sentCount,
      },
    });
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { ok: true, sent_count: sentCount } });
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
