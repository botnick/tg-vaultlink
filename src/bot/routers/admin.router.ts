/**
 * Admin router — every command guarded by {@link adminOnlyMiddleware}.
 *
 * Provides moderation actions (ban/unban, lock/unlock, force-delete file),
 * read-only stats (`/admin_stats`, `/admin_reports`, `/admin_bots`), and an
 * optional broadcast that is gated on `config.ENABLE_ADMIN_BROADCAST`.
 *
 * IMPORTANT: the admin guard is attached PER-COMMAND via
 * `composer.command(name, guard, handler)` rather than as a global
 * `composer.use(guard)` at the top of this router. Installing the guard
 * globally would block every subsequent middleware in the parent composer
 * (decode router, etc.) for non-admin users — which previously caused the
 * "you do not have permission to use this command" reply on plain-text
 * share-code lookups.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { adminOnlyMiddleware } from '../middlewares/adminOnly.middleware.js';
import { botModeratorMiddleware } from '../middlewares/botModerator.middleware.js';
import { founderOnlyMiddleware } from '../middlewares/founderOnly.middleware.js';
import { escapeHtml } from '../../utils/safeText.js';
import { formatSingleFileShareCode } from '../../utils/shareCodeFormat.js';
import { AppError } from '../../utils/errors.js';
import type { FileRow, ReportRow } from '../../types/index.js';

/**
 * Render a file as the canonical `botname:CODE_<n><L>` form so admin replies
 * carry a code that can be pasted right back into the decoder. Falls back to
 * the bare code if the owning bot row is somehow missing.
 */
function shareCodeFor(ctx: AppContext, file: FileRow): string {
  const bot = ctx.repos.bots.findById(file.bot_id);
  if (!bot) return file.code;
  return formatSingleFileShareCode(bot.username, file.code, file.file_type);
}

/**
 * Resolve a polymorphic report row to a human-pasteable share code. Files
 * render as `botname:CODE_<n><L>`; collections render as `botname:CODE` with
 * no media-count suffix (admins paste this back into the decoder, which
 * accepts both forms). Returns "—" when the underlying row is missing.
 */
function reportTargetCode(ctx: AppContext, report: ReportRow): string {
  if (report.target_type === 'file') {
    const file = ctx.repos.files.findById(report.target_id);
    return file ? shareCodeFor(ctx, file) : '—';
  }
  const collection = ctx.repos.collections.findById(report.target_id);
  if (!collection) return '—';
  const bot = ctx.repos.bots.findById(collection.bot_id);
  return bot ? `${bot.username}:${collection.code}` : collection.code;
}

const NUMERIC_RE = /^\d+$/;
const REPORTS_PAGE_SIZE = 10;
const BOTS_PAGE_SIZE = 10;

function parsePage(raw: string): number {
  const n = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function registerAdminRouter(composer: Composer<AppContext>): void {
  // Two scoped gates, attached PER-COMMAND so they never leak to other
  // routers' middleware chains:
  //
  //   superAdmin  — only `super_admin` role / ADMIN_IDS.
  //                 System-wide actions: ban/unban, broadcast, system stats,
  //                 cross-bot listing, the admin Mini-App dashboard.
  //
  //   moderator   — super admin OR owner of any managed bot.
  //                 Per-bot moderation: lock/unlock/delete files,
  //                 the `/admin_reports` queue (filtered to their bots),
  //                 and the `/admin` menu entry point.
  //
  //   Per-action authorization (e.g. "this file lives on a bot you own")
  //   happens INSIDE the handler via `permission.canModerateFile()` so a
  //   bot owner can never reach across to another bot's content.
  const superAdmin = adminOnlyMiddleware();
  const moderator = botModeratorMiddleware();
  const founder = founderOnlyMiddleware();

  const sa = {
    command: (name: string, handler: Parameters<typeof composer.command>[1]) =>
      composer.command(name, superAdmin, handler),
  };
  const mod = {
    command: (name: string, handler: Parameters<typeof composer.command>[1]) =>
      composer.command(name, moderator, handler),
  };
  const founderCmd = {
    command: (name: string, handler: Parameters<typeof composer.command>[1]) =>
      composer.command(name, founder, handler),
  };

  // /admin — menu (with optional Mini App link). Open to moderators; the
  // body adapts to the caller's role.
  mod.command('admin', async (ctx) => {
    await handleAdminCommand(ctx);
  });

  sa.command('admin_stats', async (ctx) => {
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

  mod.command('admin_reports', async (ctx) => {
    const page = parsePage((ctx.match ?? '').toString());
    const offset = (page - 1) * REPORTS_PAGE_SIZE;

    // Cross-bot isolation: super admin sees every pending report; a bot
    // owner only sees reports against files on bots THEY OWN. Bot list is
    // resolved server-side from the actor's user id — never trusted from
    // input — so a bot owner can't probe another owner's queue.
    const isSuper = ctx.services.permission.isAdmin(ctx.user);
    let reports;
    if (isSuper) {
      reports = ctx.services.report.listPending(REPORTS_PAGE_SIZE, offset);
    } else {
      const ownedBotIds = ctx.repos.bots.listByOwner(ctx.user.id).map((b) => b.id);
      reports = ctx.services.report.listPendingForBots(ownedBotIds, REPORTS_PAGE_SIZE, offset);
    }

    if (reports.length === 0) {
      await ctx.reply(ctx.t('admin.reports.empty'), { parse_mode: 'HTML' });
      return;
    }
    const lines = [ctx.t('admin.reports.header')];
    for (const r of reports) {
      // Reporter @username (or bare id when the row is anonymized) so the
      // bot view matches the Mini App's owner/reporter chips.
      let reporterLabel = '—';
      if (r.reporter_user_id !== null) {
        const u = ctx.repos.users.findById(r.reporter_user_id);
        reporterLabel = u?.username ? `@${u.username}` : (u?.first_name ?? `id:${r.reporter_user_id}`);
      }
      lines.push(
        ctx.t('admin.reports.item', {
          id: r.id,
          kind: ctx.t(`admin.reports.kind.${r.target_type}`),
          code: escapeHtml(reportTargetCode(ctx, r)),
          status: escapeHtml(r.status),
          category: escapeHtml(r.reason_category),
          reporter: escapeHtml(reporterLabel),
          reason: escapeHtml(r.reason),
        }),
      );
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  sa.command('admin_bots', async (ctx) => {
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

  sa.command('ban', async (ctx) => {
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

  sa.command('unban', async (ctx) => {
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

  /* ------------------------------------------------------------------ *
   * Founder-only: promote / demote super admins, list current ones.
   *
   * `/promote` and `/demote` mutate the trust graph and must NEVER be
   * reachable by a promoted super admin — only env-driven `ADMIN_IDS`
   * founders. Per-action authz is also re-checked inside
   * `userService.setRole` so the gate cannot be bypassed by a missing
   * middleware on a future code path.
   * ------------------------------------------------------------------ */
  founderCmd.command('promote', async (ctx) => {
    const idStr = (ctx.match ?? '').toString().trim();
    if (!NUMERIC_RE.test(idStr)) {
      await ctx.reply(ctx.t('admin.promote.usage'), { parse_mode: 'HTML' });
      return;
    }
    const target = ctx.repos.users.findByTelegramId(idStr);
    if (!target) {
      await ctx.reply(ctx.t('common.error.user_not_found'));
      return;
    }
    if (target.role === 'super_admin') {
      await ctx.reply(ctx.t('admin.promote.already', { userId: idStr }), { parse_mode: 'HTML' });
      return;
    }
    try {
      ctx.services.user.setRole(target, 'super_admin', ctx.user);
    } catch (err) {
      if (err instanceof AppError && err.expose) {
        await ctx.reply(err.message);
        return;
      }
      throw err;
    }
    ctx.services.audit.log('user.promoted_to_super_admin', {
      actorUserId: ctx.user.id,
      targetType: 'user',
      targetId: String(target.id),
      metadata: { telegram_user_id: idStr },
    });
    await ctx.reply(ctx.t('admin.promote.success', { userId: idStr }), { parse_mode: 'HTML' });
  });

  founderCmd.command('demote', async (ctx) => {
    const idStr = (ctx.match ?? '').toString().trim();
    if (!NUMERIC_RE.test(idStr)) {
      await ctx.reply(ctx.t('admin.demote.usage'), { parse_mode: 'HTML' });
      return;
    }
    const target = ctx.repos.users.findByTelegramId(idStr);
    if (!target) {
      await ctx.reply(ctx.t('common.error.user_not_found'));
      return;
    }
    if (target.role !== 'super_admin') {
      await ctx.reply(ctx.t('admin.demote.not_super', { userId: idStr }), { parse_mode: 'HTML' });
      return;
    }
    try {
      ctx.services.user.setRole(target, 'user', ctx.user);
    } catch (err) {
      if (err instanceof AppError && err.expose) {
        await ctx.reply(err.message);
        return;
      }
      throw err;
    }
    ctx.services.audit.log('user.demoted_from_super_admin', {
      actorUserId: ctx.user.id,
      targetType: 'user',
      targetId: String(target.id),
      metadata: { telegram_user_id: idStr },
    });
    await ctx.reply(ctx.t('admin.demote.success', { userId: idStr }), { parse_mode: 'HTML' });
  });

  founderCmd.command('super_admins', async (ctx) => {
    const PAGE = 50;
    const rows = ctx.repos.users.listByRole('super_admin', PAGE, 0);
    if (rows.length === 0) {
      await ctx.reply(ctx.t('admin.super_admins.empty'), { parse_mode: 'HTML' });
      return;
    }
    const lines: string[] = [ctx.t('admin.super_admins.header', { count: rows.length })];
    for (const u of rows) {
      const isFounderRow = ctx.config.ADMIN_IDS.includes(u.telegram_user_id);
      const tag = isFounderRow
        ? ctx.t('admin.super_admins.founder_tag')
        : ctx.t('admin.super_admins.promoted_tag');
      const handle = u.username ? `@${u.username}` : u.telegram_user_id;
      lines.push(
        ctx.t('admin.super_admins.item', {
          handle: escapeHtml(handle),
          userId: escapeHtml(u.telegram_user_id),
          tag,
        }),
      );
    }
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  /**
   * Resolve a `<bot:code>` / `<code>` argument and authorize the caller to
   * moderate it. Returns `null` (and replies to the user) when the file is
   * missing OR the caller has no authority on its bot. Centralised here so
   * every moderation command shares the same security gate.
   */
  async function resolveModerableFile(
    ctx: AppContext,
    arg: string,
  ): Promise<import('../../types/index.js').FileRow | null> {
    const code = arg.includes(':') ? (arg.split(':').pop() ?? '') : arg;
    if (!code) {
      await ctx.reply(ctx.t('files.not_found', { code: escapeHtml(arg) }), { parse_mode: 'HTML' });
      return null;
    }
    const file = ctx.repos.files.findByCodeAcrossBots(code);
    if (!file) {
      await ctx.reply(ctx.t('files.not_found', { code: escapeHtml(arg) }), { parse_mode: 'HTML' });
      return null;
    }
    const decision = ctx.services.permission.canModerateFile(ctx.user, file);
    if (!decision.allowed) {
      // Treat unauthorised lookups as "not found" so a non-admin bot owner
      // can't probe code-existence on bots they don't own.
      await ctx.reply(ctx.t('files.not_found', { code: escapeHtml(arg) }), { parse_mode: 'HTML' });
      return null;
    }
    return file;
  }

  mod.command('lock_file', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('admin.lock.usage'), { parse_mode: 'HTML' });
      return;
    }
    const file = await resolveModerableFile(ctx, arg);
    if (!file) return;
    ctx.services.file.setLocked(file, true, ctx.user);
    await ctx.reply(ctx.t('admin.lock.success', { code: escapeHtml(shareCodeFor(ctx, file)) }), {
      parse_mode: 'HTML',
    });
  });

  mod.command('unlock_file', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('admin.unlock.usage'), { parse_mode: 'HTML' });
      return;
    }
    const file = await resolveModerableFile(ctx, arg);
    if (!file) return;
    ctx.services.file.setLocked(file, false, ctx.user);
    await ctx.reply(ctx.t('admin.unlock.success', { code: escapeHtml(shareCodeFor(ctx, file)) }), {
      parse_mode: 'HTML',
    });
  });

  mod.command('delete_file', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('admin.delete.usage'), { parse_mode: 'HTML' });
      return;
    }
    const file = await resolveModerableFile(ctx, arg);
    if (!file) return;
    const before = shareCodeFor(ctx, file);
    ctx.services.file.softDelete(file, ctx.user);
    await ctx.reply(ctx.t('admin.delete.success', { code: escapeHtml(before) }), {
      parse_mode: 'HTML',
    });
  });

  sa.command('broadcast', async (ctx) => {
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

  // The legacy `/admin_dashboard` command was removed in the Tier-A UX
  // simplification; the Mini-App link is now reachable via the WebApp button
  // on `/admin` itself (`handleAdminCommand`).
}

/**
 * Re-usable `/admin` body. Exposed so the main-menu router can re-dispatch
 * from `menu:admin`. The body adapts to the caller's role:
 *   - super admin: full menu with system-wide actions
 *   - bot owner only: per-bot moderation surface only
 *
 * Callers MUST gate access (the slash-command path is wrapped in the
 * moderator middleware; the callback path re-checks `isModerator` before
 * forwarding here) — this function trusts that the caller is at least a
 * moderator and only differentiates super-admin extras.
 */
export async function handleAdminCommand(ctx: AppContext): Promise<void> {
  const isSuper = ctx.services.permission.isAdmin(ctx.user);
  const isFounder = ctx.services.permission.isFounder(ctx.user);

  const sections: string[] = [ctx.t('admin.menu')];
  sections.push('');
  sections.push(ctx.t('admin.menu_moderator'));
  if (isSuper) {
    sections.push('');
    sections.push(ctx.t('admin.menu_super'));
  }
  if (isFounder) {
    sections.push('');
    sections.push(ctx.t('admin.menu_founder'));
  }

  // Wave 9 — surface the credits admin entry to super admins so they know
  // where to find the toggles. Behind isEnabled OR ENABLE_CREDITS env so
  // the line appears even when the system is off (admin needs a path to
  // turn it on).
  if (isSuper) {
    sections.push('');
    sections.push(ctx.t('admin.menu_credits_hint'));
  }

  const opts: Parameters<typeof ctx.reply>[1] = { parse_mode: 'HTML' };
  // Mini-App admin dashboard is super-admin-only — surface the button only
  // to super admins to match the Mini App's own auth gate.
  if (isSuper && ctx.config.ENABLE_MINI_APP && ctx.config.MINI_APP_URL.length > 0) {
    const url = `${ctx.config.MINI_APP_URL.replace(/\/+$/, '')}/admin`;
    opts.reply_markup = new InlineKeyboard().webApp(ctx.t('admin.dashboard_button'), url);
  }
  await ctx.reply(sections.join('\n'), opts);
}
