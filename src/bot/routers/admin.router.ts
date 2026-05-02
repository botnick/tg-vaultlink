/**
 * Admin router — every command guarded by {@link adminOnlyMiddleware}.
 *
 * Provides moderation actions (ban/unban, lock/unlock, force-delete file),
 * read-only stats (`/admin_stats`, `/admin_reports`, `/admin_bots`), and an
 * optional broadcast that is gated on `config.ENABLE_ADMIN_BROADCAST`.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { adminOnlyMiddleware } from '../middlewares/adminOnly.middleware.js';
import { escapeHtml } from '../../utils/safeText.js';

const NUMERIC_RE = /^\d+$/;
const REPORTS_PAGE_SIZE = 10;
const BOTS_PAGE_SIZE = 10;

function parsePage(raw: string): number {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function registerAdminRouter(composer: Composer<AppContext>): void {
  // Build a sub-composer that gates everything below on admin role.
  const admin = composer.use(adminOnlyMiddleware());

  // /admin — menu (with optional Mini App link)
  admin.command('admin', async (ctx) => {
    await handleAdminCommand(ctx);
  });

  admin.command('admin_stats', async (ctx) => {
    const users = ctx.repos.users.countAll();
    const files = ctx.repos.files.countAll();
    const bots = ctx.repos.bots.countAll();
    const pending = ctx.services.report.countPending();
    await ctx.reply(
      ctx.t('admin.stats', {
        users,
        files,
        bots,
        pendingReports: pending,
      }),
      { parse_mode: 'HTML' },
    );
  });

  admin.command('admin_reports', async (ctx) => {
    const page = parsePage((ctx.match ?? '').toString());
    const offset = (page - 1) * REPORTS_PAGE_SIZE;
    const reports = ctx.services.report.listPending(REPORTS_PAGE_SIZE, offset);
    if (reports.length === 0) {
      await ctx.reply(ctx.t('admin.reports.empty'), { parse_mode: 'HTML' });
      return;
    }
    const lines = [ctx.t('admin.reports.header')];
    for (const r of reports) {
      const file = r.file_id !== null ? ctx.repos.files.findById(r.file_id) : undefined;
      lines.push(
        ctx.t('admin.reports.item', {
          id: r.id,
          code: escapeHtml(file?.code ?? '—'),
          status: escapeHtml(r.status),
          reason: escapeHtml(r.reason),
        }),
      );
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  admin.command('admin_bots', async (ctx) => {
    const page = parsePage((ctx.match ?? '').toString());
    const offset = (page - 1) * BOTS_PAGE_SIZE;
    const bots = ctx.repos.bots.listAll({ limit: BOTS_PAGE_SIZE, offset });
    const lines = [ctx.t('admin.bots.header')];
    for (const b of bots) {
      const owner = ctx.repos.users.findById(b.owner_user_id);
      const ownerLabel = owner?.username ?? owner?.telegram_user_id ?? String(b.owner_user_id);
      lines.push(
        ctx.t('admin.bots.item', {
          username: escapeHtml(b.username),
          owner: escapeHtml(ownerLabel),
          mode: escapeHtml(b.mode),
          status: escapeHtml(b.status),
        }),
      );
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  admin.command('ban', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    const firstSpace = arg.search(/\s+/);
    const idStr = firstSpace === -1 ? arg : arg.slice(0, firstSpace);
    if (!NUMERIC_RE.test(idStr)) {
      await ctx.reply(ctx.t('admin.ban.usage'), { parse_mode: 'HTML' });
      return;
    }
    const target = ctx.repos.users.findByTelegramId(idStr);
    if (!target) {
      await ctx.reply(ctx.t('common.error.user_not_found'));
      return;
    }
    ctx.repos.users.setBanned(target.id, true);
    ctx.services.audit.log('user.banned', {
      actorUserId: ctx.user.id,
      targetType: 'user',
      targetId: String(target.id),
      metadata: { telegram_user_id: idStr },
    });
    await ctx.reply(ctx.t('admin.ban.success', { userId: idStr }), { parse_mode: 'HTML' });
  });

  admin.command('unban', async (ctx) => {
    const idStr = (ctx.match ?? '').toString().trim();
    if (!NUMERIC_RE.test(idStr)) {
      await ctx.reply(ctx.t('admin.unban.usage'), { parse_mode: 'HTML' });
      return;
    }
    const target = ctx.repos.users.findByTelegramId(idStr);
    if (!target) {
      await ctx.reply(ctx.t('common.error.user_not_found'));
      return;
    }
    ctx.repos.users.setBanned(target.id, false);
    ctx.services.audit.log('user.unbanned', {
      actorUserId: ctx.user.id,
      targetType: 'user',
      targetId: String(target.id),
    });
    await ctx.reply(ctx.t('admin.unban.success', { userId: idStr }), { parse_mode: 'HTML' });
  });

  async function adminFileLookup(
    ctx: AppContext,
    arg: string,
  ): Promise<import('../../types/index.js').FileRow | null> {
    const code = arg.includes(':') ? (arg.split(':').pop() ?? '') : arg;
    if (!code) return null;
    return ctx.repos.files.findByCodeAcrossBots(code) ?? null;
  }

  admin.command('lock_file', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('admin.lock.usage'), { parse_mode: 'HTML' });
      return;
    }
    const file = await adminFileLookup(ctx, arg);
    if (!file) {
      await ctx.reply(ctx.t('files.not_found', { code: escapeHtml(arg) }), { parse_mode: 'HTML' });
      return;
    }
    ctx.services.file.setLocked(file, true, ctx.user);
    await ctx.reply(ctx.t('admin.lock.success', { code: escapeHtml(file.code) }), {
      parse_mode: 'HTML',
    });
  });

  admin.command('unlock_file', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('admin.unlock.usage'), { parse_mode: 'HTML' });
      return;
    }
    const file = await adminFileLookup(ctx, arg);
    if (!file) {
      await ctx.reply(ctx.t('files.not_found', { code: escapeHtml(arg) }), { parse_mode: 'HTML' });
      return;
    }
    ctx.services.file.setLocked(file, false, ctx.user);
    await ctx.reply(ctx.t('admin.unlock.success', { code: escapeHtml(file.code) }), {
      parse_mode: 'HTML',
    });
  });

  admin.command('delete_file', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('admin.delete.usage'), { parse_mode: 'HTML' });
      return;
    }
    const file = await adminFileLookup(ctx, arg);
    if (!file) {
      await ctx.reply(ctx.t('files.not_found', { code: escapeHtml(arg) }), { parse_mode: 'HTML' });
      return;
    }
    ctx.services.file.softDelete(file, ctx.user);
    await ctx.reply(ctx.t('admin.delete.success', { code: escapeHtml(file.code) }), {
      parse_mode: 'HTML',
    });
  });

  admin.command('broadcast', async (ctx) => {
    if (!ctx.config.ENABLE_ADMIN_BROADCAST) {
      await ctx.reply(ctx.t('admin.broadcast.disabled'));
      return;
    }
    const message = (ctx.match ?? '').toString();
    if (message.trim().length === 0) {
      await ctx.reply(ctx.t('admin.broadcast.usage'), { parse_mode: 'HTML' });
      return;
    }

    const PAGE = 200;
    let offset = 0;
    let sent = 0;
    let failed = 0;
    while (true) {
      const rows = ctx.repos.users.list(PAGE, offset);
      if (rows.length === 0) break;
      for (const u of rows) {
        if (u.is_banned === 1) continue;
        try {
          await ctx.api.sendMessage(u.telegram_user_id, message);
          sent++;
        } catch {
          failed++;
        }
      }
      offset += PAGE;
      if (rows.length < PAGE) break;
    }

    ctx.services.audit.log('admin.broadcast', {
      actorUserId: ctx.user.id,
      metadata: { sent, failed },
    });

    await ctx.reply(ctx.t('admin.broadcast.sent', { count: sent, failed }), {
      parse_mode: 'HTML',
    });
  });

  // /admin_dashboard — Mini App entry; if disabled, fall through to the
  // settings router which renders a feature_disabled reply.
  admin.command('admin_dashboard', async (ctx) => {
    if (!ctx.config.ENABLE_MINI_APP || ctx.config.MINI_APP_URL.length === 0) {
      await ctx.reply(ctx.t('common.error.feature_disabled'));
      return;
    }
    const url = `${ctx.config.MINI_APP_URL.replace(/\/+$/, '')}/admin`;
    const kb = new InlineKeyboard().webApp(ctx.t('admin.dashboard_button'), url);
    await ctx.reply(ctx.t('miniapp.dashboard_caption'), { reply_markup: kb });
  });
}

/**
 * Re-usable `/admin` body. Exposed so the main-menu router can re-dispatch
 * from `menu:admin`. Permission gating is the caller's responsibility — the
 * `/admin` command path itself is wrapped in {@link adminOnlyMiddleware}, but
 * the callback path checks `permission.isAdmin` before forwarding here.
 */
export async function handleAdminCommand(ctx: AppContext): Promise<void> {
  const opts: Parameters<typeof ctx.reply>[1] = { parse_mode: 'HTML' };
  if (ctx.config.ENABLE_MINI_APP && ctx.config.MINI_APP_URL.length > 0) {
    const url = `${ctx.config.MINI_APP_URL.replace(/\/+$/, '')}/admin`;
    opts.reply_markup = new InlineKeyboard().webApp(ctx.t('admin.dashboard_button'), url);
  }
  await ctx.reply(ctx.t('admin.menu'), opts);
}
