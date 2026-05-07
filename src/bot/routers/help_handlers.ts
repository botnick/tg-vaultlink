/**
 * `/help` body + page-switching helpers.
 *
 * Help is split into short, scannable pages with an inline tab bar at the
 * bottom: `📖 ภาพรวม`, `📁 ไฟล์`, `🤖 บอท`, `🔧 ตั้งค่า`, and (only for
 * moderators) `🛡 ผู้ดูแล`. Switching pages edits the same message in
 * place — the chat doesn't accumulate stale help bubbles.
 */

import { InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';

interface HelpPage {
  /** Short symbol shown on the tab — current page is wrapped in dots. */
  label: string;
  /** Locale key resolving to the page body (HTML allowed). */
  bodyKey: string;
}

/** Ordered list of help pages visible to this user. */
export function getHelpPages(ctx: AppContext): HelpPage[] {
  const pages: HelpPage[] = [
    { label: '📖', bodyKey: 'help.page.overview' },
    { label: '📁', bodyKey: 'help.page.files' },
    { label: '🤖', bodyKey: 'help.page.bots' },
    { label: '🔧', bodyKey: 'help.page.settings' },
  ];
  // Surface the credits help tab only when the system is enabled — keeps
  // the help surface tidy on free-for-all deploys.
  if (ctx.services.credits.isEnabled()) {
    pages.push({ label: '💳', bodyKey: 'help.page.credits' });
  }
  if (ctx.services.permission.isModerator(ctx.user)) {
    pages.push({ label: '🛡', bodyKey: 'help.page.admin' });
  }
  return pages;
}

/** Build the tab bar. Current tab is wired to `help:noop` (no re-send). */
export function buildHelpKeyboard(
  ctx: AppContext,
  currentIdx: number,
  pages: HelpPage[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]!;
    if (i === currentIdx) {
      kb.text(`· ${page.label} ·`, 'help:noop');
    } else {
      kb.text(page.label, `help:page:${i}`);
    }
  }
  // Mini-App link as a second row when configured.
  if (ctx.config.ENABLE_MINI_APP && ctx.config.MINI_APP_URL.length > 0) {
    kb.row().webApp(ctx.t('menu.open_mini_app'), ctx.config.MINI_APP_URL);
  }
  return kb;
}

/** Clamp an arbitrary index into the page-array range. */
export function clampPageIndex(idx: number, pages: HelpPage[]): number {
  return Math.min(Math.max(0, Math.trunc(idx) || 0), pages.length - 1);
}

/** Re-usable `/help` handler. Renders page 0 by default. */
export async function handleHelpCommand(ctx: AppContext): Promise<void> {
  const pages = getHelpPages(ctx);
  const idx = 0;
  const page = pages[idx]!;
  await ctx.reply(ctx.t(page.bodyKey), {
    parse_mode: 'HTML',
    reply_markup: buildHelpKeyboard(ctx, idx, pages),
  });
}
