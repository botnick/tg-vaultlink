/**
 * Main menu router.
 *
 * Owns the `menu:*` callback queries fired from the inline keyboard surfaced
 * by `/start`. Each callback re-dispatches the corresponding command handler
 * — `/files`, `/bots`, etc. — so a button press behaves identically to typing
 * the command. There is no "create share" entry: uploading a file (or an
 * album) IS the create flow, surfaced via the upload router.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { handleFilesCommand } from './files.router.js';
import { handleBotsCommand } from './botManagement.router.js';
import { handleSettingsCommand } from './settings.router.js';
import { handleHelpCommand } from './help_handlers.js';
import { handleAdminCommand } from './admin.router.js';

/** Build the main-menu inline keyboard shown after `/start` (no deep link). */
export function buildMainMenuKeyboard(ctx: AppContext): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text(ctx.t('menu.my_files'), 'menu:files')
    .text(ctx.t('menu.my_bots'), 'menu:bots')
    .row()
    .text(ctx.t('menu.settings'), 'menu:settings')
    .text(ctx.t('menu.help'), 'menu:help');

  if (ctx.services.permission.isAdmin(ctx.user)) {
    kb.row().text(ctx.t('menu.admin'), 'menu:admin');
  }

  if (ctx.config.ENABLE_MINI_APP && ctx.config.MINI_APP_URL.length > 0) {
    kb.row().webApp(ctx.t('menu.open_mini_app'), ctx.config.MINI_APP_URL);
  }

  return kb;
}

export function registerMainMenuRouter(composer: Composer<AppContext>): void {
  composer.callbackQuery('menu:files', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleFilesCommand(ctx);
  });

  composer.callbackQuery('menu:bots', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleBotsCommand(ctx);
  });

  composer.callbackQuery('menu:settings', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleSettingsCommand(ctx);
  });

  composer.callbackQuery('menu:help', async (ctx) => {
    await ctx.answerCallbackQuery();
    await handleHelpCommand(ctx);
  });

  composer.callbackQuery('menu:admin', async (ctx) => {
    if (!ctx.services.permission.isAdmin(ctx.user)) {
      await ctx.answerCallbackQuery({ text: ctx.t('common.error.permission_denied') });
      return;
    }
    await ctx.answerCallbackQuery();
    await handleAdminCommand(ctx);
  });
}
