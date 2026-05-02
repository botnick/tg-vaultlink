/**
 * VaultLink Bot — Mini App `/reports` routes.
 *
 * Lets a signed-in user flag a file for moderator review. The route only
 * exposes submission; pending-queue and status mutations are admin-only and
 * live under `/admin/reports`.
 */

import { Hono } from 'hono';
import type { MiniAppEnv } from '../middlewares.js';
import type { AppServices, AppRepos } from '../types.js';
import { AppError, ErrorCode } from '../../utils/errors.js';

export interface ReportsRouteDeps {
  services: AppServices;
  repos: AppRepos;
}

export function reportsRoutes(deps: ReportsRouteDeps): Hono<MiniAppEnv> {
  const app = new Hono<MiniAppEnv>();
  const { services, repos } = deps;

  app.post('/reports', async (c) => {
    const body = await c.req
      .json<{ file_id?: unknown; reason?: unknown }>()
      .catch(() => ({}) as { file_id?: unknown; reason?: unknown });

    const fileId = body.file_id;
    if (
      typeof fileId !== 'number' ||
      !Number.isFinite(fileId) ||
      !Number.isInteger(fileId) ||
      fileId <= 0
    ) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'file_id must be a positive integer', {
        expose: true,
      });
    }
    if (typeof body.reason !== 'string' || body.reason.trim().length === 0) {
      throw new AppError(ErrorCode.INVALID_INPUT, 'reason is required', { expose: true });
    }

    const file = repos.files.findById(fileId);
    if (!file) {
      throw new AppError(ErrorCode.FILE_NOT_AVAILABLE, 'file not available', { expose: true });
    }

    const result = services.report.submit({
      reporter: c.var.user,
      file,
      reason: body.reason,
    });

    c.header('Cache-Control', 'no-store');
    return c.json({
      data: {
        report: {
          id: result.report.id,
          status: result.report.status,
          created_at: result.report.created_at,
        },
        autoLocked: result.autoLocked,
      },
    });
  });

  return app;
}
