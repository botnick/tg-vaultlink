/**
 * Settings router — language picker.
 *
 * `/settings` opens the locale keyboard; the inline buttons fire
 * `cb-locale:<th|en>` callbacks that rewrite `users.locale` and acknowledge.
 *
 * The Mini App entry-point commands (`/dashboard`, `/admin_dashboard`,
 * `/lang`) used to live here as aliases. They were removed in the Tier-A
 * UX simplification: the Mini App is reachable via the WebApp button on
 * `/start`, `/files`, `/bots`, and `/admin`, so a separate command surface
 * was redundant.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { isSupportedLocale } from '../../utils/i18n.js';

function settingsKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🇹🇭 ภาษาไทย', 'cb-locale:th').text('🇬🇧 English', 'cb-locale:en');
}

export function registerSettingsRouter(composer: Composer<AppContext>): void {
  composer.command('settings', async (ctx) => {
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
