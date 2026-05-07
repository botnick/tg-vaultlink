/**
 * Reports router — `/report <code> [category] <reason>` and `/my_reports`.
 *
 * The `/report` command resolves the share code through
 * {@link ShareService.resolveShareCode} so both single-file shares and
 * collection shares can be reported through the same command. The
 * resolver walks every bot when the input is a bare code, which keeps
 * `/report` reachable through any deep link.
 *
 * Categories: when the second whitespace-separated token matches one of
 * the {@link REPORT_REASON_CATEGORIES} values (case-insensitive) we treat
 * it as the category and use the rest of the line as the free-text note.
 * If it doesn't match, we fall back to the legacy "everything-after-code
 * is the reason" parse so older deep links keep working.
 */

import { Composer } from 'grammy';
import type { AppContext } from '../context.js';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware.js';
import type { ReportTarget } from '../../services/report.service.js';
import {
  REPORT_REASON_CATEGORIES,
  type ReportReasonCategory,
} from '../../config/constants.js';

const MY_REPORTS_PAGE_SIZE = 10;

function parseCategory(token: string): ReportReasonCategory | null {
  const lowered = token.trim().toLowerCase();
  return (REPORT_REASON_CATEGORIES as readonly string[]).includes(lowered)
    ? (lowered as ReportReasonCategory)
    : null;
}

export function registerReportsRouter(composer: Composer<AppContext>): void {
  composer.command('report', rateLimitMiddleware('report'), async (ctx) => {
    if (!ctx.config.ENABLE_REPORTS) {
      await ctx.reply(ctx.t('common.error.feature_disabled'));
      return;
    }

    const arg = (ctx.match ?? '').toString().trim();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('report.usage'), { parse_mode: 'HTML' });
      return;
    }

    // Tokenize: first token is the code, optional second token is the
    // category, the rest is the free-text note.
    const parts = arg.split(/\s+/);
    const codeArg = parts[0] ?? '';
    let reason_category: ReportReasonCategory = 'other';
    let reasonStart = 1;
    if (parts.length >= 2) {
      const maybeCat = parseCategory(parts[1]!);
      if (maybeCat !== null) {
        reason_category = maybeCat;
        reasonStart = 2;
      }
    }
    const reason = parts.slice(reasonStart).join(' ').trim();

    if (reason.length === 0) {
      await ctx.reply(ctx.t('report.usage'), { parse_mode: 'HTML' });
      return;
    }

    const resolved = await ctx.services.share.resolveShareCode({
      rawCode: codeArg,
      contextBot: ctx.bot,
    });
    if (!resolved) {
      await ctx.reply(ctx.t('decode.not_found'));
      return;
    }

    const target: ReportTarget =
      resolved.type === 'single_file'
        ? { type: 'file', file: resolved.file }
        : { type: 'collection', collection: resolved.collection };

    ctx.services.report.submit({
      reporter: ctx.user,
      target,
      reason,
      reason_category,
    });
    await ctx.reply(
      ctx.t('report.success_with_category', { category: reason_category }),
      { parse_mode: 'HTML' },
    );
  });

  /**
   * Reporter's own report history. No pagination yet — page 1 covers the
   * first {@link MY_REPORTS_PAGE_SIZE} most recent reports, which is enough
   * for the typical user. Mini App users get the full list in
   * `/my-reports`.
   */
  composer.command('my_reports', async (ctx) => {
    if (!ctx.config.ENABLE_REPORTS) {
      await ctx.reply(ctx.t('common.error.feature_disabled'));
      return;
    }
    const rows = ctx.services.report.listByReporter(
      ctx.user,
      null,
      MY_REPORTS_PAGE_SIZE,
      0,
    );
    if (rows.length === 0) {
      await ctx.reply(ctx.t('my_reports.bot.empty'), { parse_mode: 'HTML' });
      return;
    }
    const lines = [ctx.t('my_reports.bot.header')];
    for (const r of rows) {
      lines.push(
        ctx.t('my_reports.bot.item', {
          id: r.id,
          kind: r.target_type,
          target_id: r.target_id,
          status: r.status,
          category: r.reason_category,
          reason: r.reason,
        }),
      );
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });
}
