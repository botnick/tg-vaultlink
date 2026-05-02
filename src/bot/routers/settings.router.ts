/**
 * Settings router — language picker plus the Mini App entry-point commands.
 *
 * `/settings` and `/lang` open the locale keyboard; the inline buttons fire
 * `cb-locale:<th|en>` callbacks that rewrite `users.locale` and acknowledge.
 *
 * `/dashboard`, `/files`, `/bots`, `/admin_dashboard` always exist so users
 * have a stable command surface; when `ENABLE_MINI_APP` is false they reply
 * with the localized "feature disabled" notice instead of the WebApp button.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { isSupportedLocale } from '../../utils/i18n.js';

function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🇹🇭 ภาษาไทย', 'cb-locale:th')
    .text('🇬🇧 English', 'cb-locale:en');
}

function miniAppButton(ctx: AppContext, path: string, label: string): InlineKeyboard | null {
  if (!ctx.config.ENABLE_MINI_APP || ctx.config.MINI_APP_URL.length === 0) {
    return null;
  }
  const base = ctx.config.MINI_APP_URL.replace(/\/+$/, '');
  const url = path === '' ? base : `${base}${path.startsWith('/') ? path : `/${path}`}`;
  return new InlineKeyboard().webApp(label, url);
}

async function replyMiniAppOrDisabled(
  ctx: AppContext,
  path: string,
  label: string,
): Promise<void> {
  const kb = miniAppButton(ctx, path, label);
  if (!kb) {
    await ctx.reply(ctx.t('common.error.feature_disabled'));
    return;
  }
  await ctx.reply(ctx.t('miniapp.dashboard_caption'), { reply_markup: kb });
}

export function registerSettingsRouter(composer: Composer<AppContext>): void {
  composer.command(['settings', 'lang'], async (ctx) => {
    await ctx.reply(ctx.t('settings.header'), {
      parse_mode: 'HTML',
      reply_markup: settingsKeyboard(),
    });
  });

  composer.callbackQuery(/^cb-locale:(th|en)$/, async (ctx) => {
    const match = ctx.match;
    const code = match?.[1];
    if (!code || !isSupportedLocale(code)) {
      await ctx.answerCallbackQuery();
      return;
    }
    ctx.repos.users.update(ctx.user.id, { locale: code });
    ctx.services.audit.log('user.locale_changed', {
      actorUserId: ctx.user.id,
      metadata: { locale: code },
    });
    await ctx.answerCallbackQuery({ text: ctx.t('settings.locale_changed') });
    try {
      await ctx.editMessageText(ctx.t('settings.locale_changed'));
    } catch {
      // editing may fail if the original message is unavailable
    }
  });

  // Mini App entry-points (or feature-disabled fallbacks). The `/files` and
  // `/bots` commands are now owned by the dedicated files/botManagement
  // routers (Wave 7); only `/dashboard` remains as a Mini App shortcut.
  composer.command('dashboard', async (ctx) => {
    await replyMiniAppOrDisabled(ctx, '', ctx.t('start.dashboard_button'));
  });
}

/**
 * Re-usable handler for the `/settings` command. Exposed so the main-menu
 * router can re-dispatch it from `menu:settings`.
 */
export async function handleSettingsCommand(ctx: AppContext): Promise<void> {
  await ctx.reply(ctx.t('settings.header'), {
    parse_mode: 'HTML',
    reply_markup: settingsKeyboard(),
  });
}
