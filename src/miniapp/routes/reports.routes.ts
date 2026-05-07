/**
 * VaultLink Bot — Mini App `/reports` routes.
 *
 * Lets a signed-in user flag a file or a collection for moderator review and
 * inspect / withdraw their own pending submissions. Pending-queue and status
 * mutations remain admin-only and live under `/admin/reports`.
 */

import { Hono } from 'hono';
import type { MiniAppEnv } from '../middlewares.js';
import type { AppServices, AppRepos } from '../types.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import type { ReportTarget } from '../../services/report.service.js';
import type { ReportStatus } from '../../types/index.js';
import { normalizeReportReasonCategory } from '../../config/constants.js';
import { buildReportTargetSummary } from '../lib/reportEnrich.js';

export interface ReportsRouteDeps {
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

export function reportsRoutes(deps: ReportsRouteDeps): Hono<MiniAppEnv> {
  const app = new Hono<MiniAppEnv>();
  const { services, repos } = deps;

  app.post('/reports', async (c) => {
    const body = await c.req
      .json<{
        target_type?: unknown;
        target_id?: unknown;
        reason?: unknown;
        reason_category?: unknown;
      }>()
      .catch(
        () =>
          ({}) as {
            target_type?: unknown;
            target_id?: unknown;
            reason?: unknown;
            reason_category?: unknown;
          },
      );

    const targetType = body.target_type;
    if (targetType !== 'file' && targetType !== 'collection') {
      throw new AppError(ErrorCode.INVALID_INPUT, 'target_type must be "file" or "collection"', {
        expose: true,
      });
    }
    const targetId = body.target_id;
    if (
      typeof targetId !== 'number' ||
      !Number.isFinite(targetId) ||
      !Number.isInteger(targetId) ||
      targetId <= 0
    ) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'target_id must be a positive integer', {
        expose: true,
      });
    }
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'reason is required', { expose: true });
    }

    let target: ReportTarget;
    if (targetType === 'file') {
      const file = repos.files.findById(targetId);
      if (!file || file.is_deleted === 1) {
        throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
      }
      target = { type: 'file', file };
    } else {
      const collection = repos.collections.findById(targetId);
      if (!collection || collection.is_deleted === 1) {
        throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'collection not available', {
          expose: true,
        });
      }
      target = { type: 'collection', collection };
    }

    const result = services.report.submit({
      reporter: c.var.user,
      target,
      reason: body.reason,
      reason_category: normalizeReportReasonCategory(body.reason_category),
    });

    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        report: {
          id: result.report.id,
          status: result.report.status,
          reason_category: result.report.reason_category,
          created_at: result.report.created_at,
        },
        autoLocked: result.autoLocked,
      },
    });
  });

  /**
   * Reporter's own report history. Optional `?status=pending|reviewed|dismissed`
   * filter. Each row carries a target summary so the UI can show "what was
   * reported" without fanning out per-row file lookups.
   */
  app.get('/reports/mine', (c) => {
    const statusRaw = c.req.query('status');
    let status: ReportStatus | null = null;
    if (statusRaw !== undefined && statusRaw.length > 0) {
      if (statusRaw !== 'pending' && statusRaw !== 'reviewed' && statusRaw !== 'dismissed') {
        throw new AppError(ErrorCode.INVALID_INPUT, 'invalid status', { expose: true });
      }
      status = statusRaw;
    }
    const limit = clampInt(c.req.query('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(c.req.query('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
    const rows = services.report.listByReporter(c.var.user, status, limit, offset);
    const total = services.report.countByReporter(c.var.user, status);
    const items = rows.map((r) => ({
      id: r.id,
      status: r.status,
      reason: r.reason,
      reason_category: r.reason_category,
      created_at: r.created_at,
      updated_at: r.updated_at,
      target: buildReportTargetSummary(repos, r),
    }));
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { items, total } });
  });

  app.get('/reports/mine/count', (c) => {
    const pending = services.report.countByReporter(c.var.user, 'pending');
    const total = services.report.countByReporter(c.var.user, null);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { pending, total } });
  });

  /**
   * Reporter withdraws one of their own pending reports. 404 for foreign or
   * missing rows; 400 if the row is no longer pending (the moderator already
   * acted on it — preserving the audit trail).
   */
  app.delete('/reports/mine/:id', (c) => {
    const id = Number.parseInt(c.req.param('id'), 10);
    if (!Number.isFinite(id)) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'invalid report id', { expose: true });
    }
    const report = services.report.findById(id);
    if (!report || report.reporter_user_id !== c.var.user.id) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'report not found', { expose: true });
    }
    services.report.withdraw(report, c.var.user);
    c.header('Cache-Control', 'no-store');
    return c.json({ data: { ok: true } });
  });

  return app;
}
