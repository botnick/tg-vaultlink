/**
 * File-management router — `/files`, plus `/del`, `/set_password`,
 * `/remove_password`.
 *
 * Listing UX is intentionally compact: ONE chat message per `/files`
 * invocation — header line, one row per item (single-file or collection
 * interleaved, newest-first), and a single pagination keyboard at the
 * bottom. No per-item action buttons; per-item management goes through
 * the slash commands or the Mini App. This keeps the listing
 * scroll-friendly even when the owner has dozens of items.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { escapeHtml } from '../../utils/safeText.js';
import { formatBytes } from '../../utils/formatBytes.js';
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../../config/constants.js';
import { formatShareCode, formatSingleFileShareCode } from '../../utils/shareCodeFormat.js';

const PAGE_SIZE = 10;

interface ListedRow {
  type: 'file' | 'collection';
  id: number;
  code: string;
  shareCode: string;
  label: string;
  is_locked: number;
  hasPassword: boolean;
  /** ISO timestamp used for cross-table newest-first ordering. */
  created_at: string;
}

/**
 * Pull every owned single-file row and collection row, project both onto
 * {@link ListedRow}, and sort newest-first.
 *
 * For a personal-bot deployment owners typically have well under a few
 * hundred shares; loading both tables fully and slicing in JS keeps the
 * code simple. If usage grows large enough to matter we can swap this for
 * a SQL UNION ALL with proper LIMIT/OFFSET.
 */
function buildAllOwnerRows(ctx: AppContext): ListedRow[] {
  const HARD_CAP = 500;
  const files = ctx.services.file.listByOwner(ctx.user, { limit: HARD_CAP });
  const collections = ctx.services.share.listOwnerCollections(ctx.user, { limit: HARD_CAP });
  const rows: ListedRow[] = [];

  for (const f of files) {
    rows.push({
      type: 'file',
      id: f.id,
      code: f.code,
      shareCode: formatSingleFileShareCode(ctx.bot.username, f.code, f.file_type),
      label: `📄 ${f.file_type} ${formatBytes(f.size_bytes)}`,
      is_locked: f.is_locked,
      hasPassword: f.password_hash !== null,
      created_at: f.created_at,
    });
  }
  for (const c of collections) {
    const counts = ctx.repos.collections.countItemsByType(c.id);
    rows.push({
      type: 'collection',
      id: c.id,
      code: c.code,
      shareCode: formatShareCode(ctx.bot.username, c.code, counts),
      label: `🗂 ${c.title ?? 'Collection'} (${c.total_items})`,
      is_locked: c.is_locked,
      hasPassword: c.password_hash !== null,
      created_at: c.created_at,
    });
  }

  rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
  return rows;
}

function renderPage(
  ctx: AppContext,
  page: number,
): { text: string; keyboard: InlineKeyboard | null } {
  const allRows = buildAllOwnerRows(ctx);
  const total = allRows.length;

  if (total === 0) {
    return { text: ctx.t('files.list_empty'), keyboard: null };
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const safePage = Math.min(Math.max(1, Math.trunc(page) || 1), pages);
  const start = (safePage - 1) * PAGE_SIZE;
  const slice = allRows.slice(start, start + PAGE_SIZE);

  const lines: string[] = [ctx.t('files.list_header', { count: total })];
  for (const r of slice) {
    const lockTag = r.is_locked === 1 ? ' 🔒' : '';
    const pwTag = r.hasPassword ? ' 🔑' : '';
    lines.push(
      `• <code>${escapeHtml(r.shareCode)}</code> — ${escapeHtml(r.label)}${lockTag}${pwTag}`,
    );
  }
  if (pages > 1) {
    lines.push('');
    lines.push(ctx.t('files.list_page', { page: safePage, pages }));
  }

  let keyboard: InlineKeyboard | null = null;
  if (pages > 1) {
    keyboard = new InlineKeyboard();
    if (safePage > 1) {
      keyboard.text(ctx.t('common.button.prev'), `cb-files:page:${safePage - 1}`);
    }
    if (safePage < pages) {
      keyboard.text(ctx.t('common.button.next'), `cb-files:page:${safePage + 1}`);
    }
  }

  // Mini App button: a single shortcut at the bottom for richer management
  // (delete, visibility, password, etc.) instead of per-item buttons.
  if (ctx.config.ENABLE_MINI_APP && ctx.config.MINI_APP_URL.length > 0) {
    if (!keyboard) keyboard = new InlineKeyboard();
    else keyboard.row();
    const url = `${ctx.config.MINI_APP_URL.replace(/\/+$/, '')}/files`;
    keyboard.webApp(ctx.t('menu.open_mini_app'), url);
  }

  return { text: lines.join('\n'), keyboard };
}

export function registerFilesRouter(composer: Composer<AppContext>): void {
  composer.callbackQuery(/^cb-files:page:(\d+)$/, async (ctx) => {
    const match = ctx.match;
    const pageStr = match?.[1];
    if (!pageStr) {
      await ctx.answerCallbackQuery();
      return;
    }
    const page = Math.max(1, Number.parseInt(pageStr, 10));
    const { text, keyboard } = renderPage(ctx, page);
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
    const display = formatSingleFileShareCode(
      ctx.bot.username,
      resolved.file.code,
      resolved.file.file_type,
    );
    ctx.services.file.softDelete(resolved.file, ctx.user);
    await ctx.reply(ctx.t('files.deleted', { code: escapeHtml(display) }), {
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
    const display = formatSingleFileShareCode(
      ctx.bot.username,
      resolved.file.code,
      resolved.file.file_type,
    );
    await ctx.reply(ctx.t('password.set.success', { code: escapeHtml(display) }), {
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
    const display = formatSingleFileShareCode(
      ctx.bot.username,
      resolved.file.code,
      resolved.file.file_type,
    );
    await ctx.reply(ctx.t('password.remove.success', { code: escapeHtml(display) }), {
      parse_mode: 'HTML',
    });
  });

  /* --------------------------------------------------------------------- *
   * Wave 7: `/files` — unified owner listing (single files + collections).
   * --------------------------------------------------------------------- */
  composer.command('files', async (ctx) => {
    await handleFilesCommand(ctx);
  });
}

/* ----------------------------------------------------------------------- *
 * Exported handler — used by `/files`, `/my_files`, and the menu callback.
 * ----------------------------------------------------------------------- */

/**
 * Re-usable handler for the `/files` command (and the `menu:files` callback).
 * Sends a single chat message with the paginated list — no per-item button
 * spam. Owners drive deletion / password / visibility changes through the
 * dedicated slash commands or the Mini App.
 */
export async function handleFilesCommand(ctx: AppContext): Promise<void> {
  const { text, keyboard } = renderPage(ctx, 1);
  const opts: Parameters<typeof ctx.reply>[1] = { parse_mode: 'HTML' };
  if (keyboard) opts.reply_markup = keyboard;
  await ctx.reply(text, opts);
}
