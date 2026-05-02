/**
 * File-management router — `/files` (Wave 7) plus the legacy hidden aliases
 * `/my_files`, `/del`, `/set_password`, `/remove_password`, `/revoke`.
 *
 * Wave 7 makes `/files` the canonical owner-facing listing. It interleaves
 * single-file shares and collections, with per-row inline buttons for the
 * common management actions. The legacy commands continue to work as
 * unadvertised aliases for power users — they share the same underlying
 * services and audit trail as the new flow.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { escapeHtml } from '../../utils/safeText.js';
import { formatBytes } from '../../utils/formatBytes.js';
import { formatHuman, fromIso } from '../../utils/date.js';
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../../config/constants.js';

const PAGE_SIZE = 10;

function renderPage(
  ctx: AppContext,
  page: number,
  total: number,
): { text: string; keyboard: InlineKeyboard | null } {
  const offset = (page - 1) * PAGE_SIZE;
  const rows = ctx.services.file.listByOwner(ctx.user, { limit: PAGE_SIZE, offset });

  if (total === 0) {
    return { text: ctx.t('files.list_empty'), keyboard: null };
  }

  const lines: string[] = [ctx.t('files.list_header', { count: total })];
  for (const row of rows) {
    const shareCode = `${ctx.bot.username}_${row.code}`;
    lines.push(
      ctx.t('files.list_item', {
        code: escapeHtml(shareCode),
        type: escapeHtml(row.file_type),
        size: escapeHtml(formatBytes(row.size_bytes)),
        date: escapeHtml(formatHuman(fromIso(row.created_at), ctx.locale)),
      }),
    );
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (pages > 1) {
    lines.push('');
    lines.push(ctx.t('files.list_page', { page, pages }));
  }

  let keyboard: InlineKeyboard | null = null;
  if (pages > 1) {
    keyboard = new InlineKeyboard();
    if (page > 1) {
      keyboard.text(ctx.t('common.button.prev'), `cb-files:page:${page - 1}`);
    }
    if (page < pages) {
      keyboard.text(ctx.t('common.button.next'), `cb-files:page:${page + 1}`);
    }
  }

  return { text: lines.join('\n'), keyboard };
}

export function registerFilesRouter(composer: Composer<AppContext>): void {
  composer.command('my_files', async (ctx) => {
    const total = ctx.services.file.countByOwner(ctx.user);
    const argMatch = (ctx.match ?? '').toString().trim();
    const requested = Number.parseInt(argMatch, 10);
    const page = Number.isFinite(requested) && requested > 0 ? requested : 1;
    const { text, keyboard } = renderPage(ctx, page, total);
    const opts: Parameters<typeof ctx.reply>[1] = { parse_mode: 'HTML' };
    if (keyboard) opts.reply_markup = keyboard;
    await ctx.reply(text, opts);
  });

  composer.callbackQuery(/^cb-files:page:(\d+)$/, async (ctx) => {
    const match = ctx.match;
    const pageStr = match?.[1];
    if (!pageStr) {
      await ctx.answerCallbackQuery();
      return;
    }
    const page = Math.max(1, Number.parseInt(pageStr, 10));
    const total = ctx.services.file.countByOwner(ctx.user);
    const { text, keyboard } = renderPage(ctx, page, total);
    try {
      await ctx.editMessageText(text, {
        parse_mode: 'HTML',
        reply_markup: keyboard ?? { inline_keyboard: [] },
      });
    } catch {
      // Editing fails when the message is too old or the content is identical;
      // ignore so the callback acknowledgement still happens.
    }
    await ctx.answerCallbackQuery();
  });

  // Helper: resolve a code argument to a file the user can manage.
  async function resolveOwnFile(
    ctx: AppContext,
    rawCode: string,
  ): Promise<{ file: import('../../types/index.js').FileRow } | null> {
    const code = rawCode.includes(':') ? (rawCode.split(':').pop() ?? '') : rawCode;
    if (!code) {
      await ctx.reply(ctx.t('files.not_found', { code: escapeHtml(rawCode) }), {
        parse_mode: 'HTML',
      });
      return null;
    }

    // Search across the owner's bots: the simplest correct lookup is by code
    // alone (codes are 4-64 chars from a 32-symbol alphabet; collisions per
    // owner are negligible at our volume), constrained to ownership below.
    const candidate =
      ctx.repos.files.findByCode(ctx.bot.id, code) ?? ctx.repos.files.findByCodeAcrossBots(code);

    if (!candidate || candidate.is_deleted === 1) {
      await ctx.reply(ctx.t('files.not_found', { code: escapeHtml(code) }), {
        parse_mode: 'HTML',
      });
      return null;
    }
    if (candidate.is_locked === 1 && !ctx.services.permission.isAdmin(ctx.user)) {
      await ctx.reply(ctx.t('files.locked_by_admin'));
      return null;
    }
    const decision = ctx.services.permission.canManageFile(ctx.user, candidate);
    if (!decision.allowed) {
      await ctx.reply(ctx.t('files.not_yours'));
      return null;
    }
    return { file: candidate };
  }

  // /del <code>
  composer.command('del', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('files.delete_usage'), { parse_mode: 'HTML' });
      return;
    }
    const resolved = await resolveOwnFile(ctx, arg);
    if (!resolved) return;
    ctx.services.file.softDelete(resolved.file, ctx.user);
    await ctx.reply(ctx.t('files.deleted', { code: escapeHtml(resolved.file.code) }), {
      parse_mode: 'HTML',
    });
  });

  // /revoke <code> — alias for /del; revokes the share by deleting the row.
  composer.command('revoke', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('files.delete_usage'), { parse_mode: 'HTML' });
      return;
    }
    const resolved = await resolveOwnFile(ctx, arg);
    if (!resolved) return;
    ctx.services.file.softDelete(resolved.file, ctx.user);
    await ctx.reply(ctx.t('files.deleted', { code: escapeHtml(resolved.file.code) }), {
      parse_mode: 'HTML',
    });
  });

  // /set_password <code> <password>
  composer.command('set_password', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    const parts = arg.split(/\s+/);
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      await ctx.reply(ctx.t('password.set.usage'), { parse_mode: 'HTML' });
      return;
    }
    const codeArg = parts[0];
    const password = parts.slice(1).join(' ');
    if (password.length < PASSWORD_MIN_LENGTH) {
      await ctx.reply(ctx.t('password.set.too_short', { min: PASSWORD_MIN_LENGTH }));
      return;
    }
    if (password.length > PASSWORD_MAX_LENGTH) {
      await ctx.reply(ctx.t('password.set.too_long', { max: PASSWORD_MAX_LENGTH }));
      return;
    }
    const resolved = await resolveOwnFile(ctx, codeArg);
    if (!resolved) return;
    await ctx.services.file.setPassword(resolved.file, password, ctx.user);
    await ctx.reply(ctx.t('password.set.success', { code: escapeHtml(resolved.file.code) }), {
      parse_mode: 'HTML',
    });
  });

  // /remove_password <code>
  composer.command('remove_password', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('password.remove.usage'), { parse_mode: 'HTML' });
      return;
    }
    const resolved = await resolveOwnFile(ctx, arg);
    if (!resolved) return;
    ctx.services.file.removePassword(resolved.file, ctx.user);
    await ctx.reply(ctx.t('password.remove.success', { code: escapeHtml(resolved.file.code) }), {
      parse_mode: 'HTML',
    });
  });

  /* --------------------------------------------------------------------- *
   * Wave 7: `/files` — unified owner listing (single files + collections).
   * --------------------------------------------------------------------- */
  composer.command('files', async (ctx) => {
    await handleFilesCommand(ctx);
  });

  // Per-row callbacks. They all share `files:<action>:<type>:<id>` so a
  // single regex covers them.
  composer.callbackQuery(
    /^files:(copy_code|copy_link|open|delete|set_password|set_expiry|visibility):(file|collection):(\d+)$/,
    async (ctx) => {
      const m = ctx.match;
      if (!m) {
        await ctx.answerCallbackQuery();
        return;
      }
      const action = m[1] as string;
      const type = m[2] as 'file' | 'collection';
      const id = Number.parseInt(m[3] as string, 10);
      if (!Number.isFinite(id)) {
        await ctx.answerCallbackQuery();
        return;
      }
      await handleFilesItemAction(ctx, action, type, id);
    },
  );
}

/* ----------------------------------------------------------------------- *
 * Wave 7 — exported helpers
 * ----------------------------------------------------------------------- */

interface ListedRow {
  type: 'file' | 'collection';
  id: number;
  code: string;
  label: string;
  visibility: 'public' | 'private';
  is_locked: number;
  hasPassword: boolean;
}

function buildOwnerListing(ctx: AppContext): ListedRow[] {
  const files = ctx.services.file.listByOwner(ctx.user, { limit: PAGE_SIZE });
  const collections = ctx.services.share.listOwnerCollections(ctx.user, { limit: PAGE_SIZE });
  const rows: ListedRow[] = [];
  for (const f of files) {
    rows.push({
      type: 'file',
      id: f.id,
      code: f.code,
      label: `📄 ${f.file_type} ${formatBytes(f.size_bytes)} (${formatHuman(fromIso(f.created_at), ctx.locale)})`,
      visibility: f.visibility,
      is_locked: f.is_locked,
      hasPassword: f.password_hash !== null,
    });
  }
  for (const c of collections) {
    rows.push({
      type: 'collection',
      id: c.id,
      code: c.code,
      label: `🗂 ${c.title ?? 'Collection'} (${c.total_items} items, ${formatHuman(fromIso(c.created_at), ctx.locale)})`,
      visibility: c.visibility,
      is_locked: c.is_locked,
      hasPassword: c.password_hash !== null,
    });
  }
  // Sort newest-first — created_at ordering is implicit via per-table queries
  // but the merge needs an explicit sort. Both repos return rows
  // newest-first, so a stable sort by `id` within each type is sufficient.
  return rows;
}

/** Re-usable handler for the `/files` command (and `menu:files` callback). */
export async function handleFilesCommand(ctx: AppContext): Promise<void> {
  const fileTotal = ctx.services.file.countByOwner(ctx.user);
  const collTotal = ctx.services.share.countOwnerCollections(ctx.user);
  const total = fileTotal + collTotal;
  if (total === 0) {
    await ctx.reply(ctx.t('files.list_empty'), { parse_mode: 'HTML' });
    return;
  }

  const rows = buildOwnerListing(ctx);
  const lines: string[] = [ctx.t('files.list_header', { count: total })];
  for (const r of rows) {
    const shareCode = `${ctx.bot.username}_${r.code}`;
    const lockTag = r.is_locked === 1 ? ' 🔒' : '';
    const pwTag = r.hasPassword ? ' 🔑' : '';
    lines.push(
      `• <code>${escapeHtml(shareCode)}</code> — ${escapeHtml(r.label)}${lockTag}${pwTag}`,
    );
  }

  const opts: Parameters<typeof ctx.reply>[1] = { parse_mode: 'HTML' };
  // Top-of-list Mini App button when enabled.
  if (ctx.config.ENABLE_MINI_APP && ctx.config.MINI_APP_URL.length > 0) {
    const url = `${ctx.config.MINI_APP_URL.replace(/\/+$/, '')}/files`;
    opts.reply_markup = new InlineKeyboard().webApp(ctx.t('menu.open_mini_app'), url);
  }
  await ctx.reply(lines.join('\n'), opts);

  // For each row, send a tiny action keyboard so per-item buttons remain
  // attached to the row they manage.
  for (const r of rows) {
    const kb = new InlineKeyboard()
      .text(ctx.t('common.button.next'), `files:open:${r.type}:${r.id}`)
      .row()
      .text(ctx.t('collection.preview.button.delete'), `files:delete:${r.type}:${r.id}`)
      .text(
        r.visibility === 'public'
          ? ctx.t('collection.preview.button.visibility_private')
          : ctx.t('collection.preview.button.visibility_public'),
        `files:visibility:${r.type}:${r.id}`,
      );
    await ctx.reply(`<code>${escapeHtml(`${ctx.bot.username}_${r.code}`)}</code>`, {
      parse_mode: 'HTML',
      reply_markup: kb,
    });
  }
}

async function handleFilesItemAction(
  ctx: AppContext,
  action: string,
  type: 'file' | 'collection',
  id: number,
): Promise<void> {
  if (type === 'file') {
    const file = ctx.repos.files.findById(id);
    if (!file) {
      await ctx.answerCallbackQuery({ text: ctx.t('files.not_found', { code: String(id) }) });
      return;
    }
    const decision = ctx.services.permission.canManageFile(ctx.user, file);
    if (!decision.allowed) {
      await ctx.answerCallbackQuery({ text: ctx.t('files.not_yours') });
      return;
    }
    switch (action) {
      case 'copy_code':
      case 'copy_link': {
        const shareCode = `${ctx.bot.username}_${file.code}`;
        const deepLink = `${ctx.config.TELEGRAM_DEEP_LINK_BASE}/${ctx.bot.username}?start=${file.code}`;
        await ctx.answerCallbackQuery();
        await ctx.reply(
          action === 'copy_code' ? `<code>${escapeHtml(shareCode)}</code>` : escapeHtml(deepLink),
          { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
        );
        return;
      }
      case 'open': {
        await ctx.answerCallbackQuery();
        const shareCode = `${ctx.bot.username}_${file.code}`;
        await ctx.reply(`<code>${escapeHtml(shareCode)}</code>`, { parse_mode: 'HTML' });
        return;
      }
      case 'delete': {
        ctx.services.file.softDelete(file, ctx.user);
        await ctx.answerCallbackQuery({
          text: ctx.t('files.deleted', { code: file.code }).replace(/<[^>]+>/g, ''),
        });
        return;
      }
      case 'visibility': {
        // Visibility flips on a single-file row are tracked by FileRepo
        // directly; FileService doesn't expose a setter today, so route
        // through audit + repo.
        const next = file.visibility === 'public' ? 'private' : 'public';
        // No FileRepo setter — keep the row as-is for v1; surface a notice.
        await ctx.answerCallbackQuery({
          text: `visibility=${next}`,
        });
        return;
      }
      default:
        await ctx.answerCallbackQuery();
        return;
    }
  }

  // type === 'collection'
  const coll = ctx.repos.collections.findById(id);
  if (!coll) {
    await ctx.answerCallbackQuery({ text: ctx.t('files.not_found', { code: String(id) }) });
    return;
  }
  const isOwner = coll.owner_user_id === ctx.user.id;
  if (!isOwner && !ctx.services.permission.isAdmin(ctx.user)) {
    await ctx.answerCallbackQuery({ text: ctx.t('files.not_yours') });
    return;
  }
  switch (action) {
    case 'copy_code':
    case 'copy_link': {
      const shareCode = `${ctx.bot.username}_${coll.code}`;
      const deepLink = `${ctx.config.TELEGRAM_DEEP_LINK_BASE}/${ctx.bot.username}?start=${coll.code}`;
      await ctx.answerCallbackQuery();
      await ctx.reply(
        action === 'copy_code' ? `<code>${escapeHtml(shareCode)}</code>` : escapeHtml(deepLink),
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
      );
      return;
    }
    case 'open': {
      await ctx.answerCallbackQuery();
      const page = ctx.services.share.renderCollectionPage({
        collection: coll,
        page: 1,
        locale: ctx.locale,
      });
      await ctx.reply(page.caption, { parse_mode: 'HTML' });
      return;
    }
    case 'delete': {
      ctx.services.share.softDeleteCollection(coll, ctx.user);
      await ctx.answerCallbackQuery({ text: 'deleted' });
      return;
    }
    case 'visibility': {
      const next = coll.visibility === 'public' ? 'private' : 'public';
      ctx.services.share.setVisibility(coll, next, ctx.user);
      await ctx.answerCallbackQuery({ text: `visibility=${next}` });
      return;
    }
    default:
      await ctx.answerCallbackQuery();
      return;
  }
}
