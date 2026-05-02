/**
 * Bot management router — `/add_bot`, `/add_bot_open`, `/my_bots`,
 * `/remove_bot`. Lives on the main bot; child bots inherit the same router
 * but the typical user only ever runs these on the main bot.
 *
 * Adding a bot stops at persistence here; the running grammY instance is
 * spun up by the {@link ChildBotManager} which is wired into `app.ts`. We
 * fire-and-forget the start so the user doesn't wait for `getMe`.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { rateLimitMiddleware } from '../middlewares/rateLimit.middleware.js';
import type { ChildBotManager } from '../childBotManager.js';
import { escapeHtml } from '../../utils/safeText.js';

export interface BotManagementDeps {
  /**
   * Optional child manager. When the main bot owns this router, supplying
   * the manager lets `/add_bot*` actually start the new instance and
   * `/remove_bot` stop the running one. Child bots typically pass `undefined`
   * (the same operations remain available, they just don't try to mutate
   * sibling instances at runtime).
   */
  childManager?: ChildBotManager;
}

export function registerBotManagementRouter(
  composer: Composer<AppContext>,
  deps: BotManagementDeps = {},
): void {
  const { childManager } = deps;

  async function handleAdd(ctx: AppContext, rawArg: string): Promise<void> {
    const token = rawArg.trim();
    if (token.length === 0) {
      await ctx.reply(ctx.t('bot.add.usage'), { parse_mode: 'HTML' });
      return;
    }

    // Default to personal_public — anyone can decode AND upload through the
    // new bot, exactly like the system's main bot. The owner can lock it
    // down later with `/mode_private`.
    const record = await ctx.services.bot.addBot({
      owner: ctx.user,
      rawToken: token,
      mode: 'personal_public',
    });

    await ctx.reply(ctx.t('bot.add.success_public', { username: escapeHtml(record.username) }), {
      parse_mode: 'HTML',
    });

    if (childManager) {
      // Fire-and-forget: the start can take seconds (it talks to Telegram and
      // boots the runner) and the user already got a "registered" reply. We
      // explicitly `void` the chain and attach a final `.catch` so any throw
      // inside the success/failure branches cannot escape as an unhandled
      // rejection.
      void childManager
        .start(record)
        .then(
          () =>
            ctx
              .reply(ctx.t('bot.add.success_started', { username: escapeHtml(record.username) }), {
                parse_mode: 'HTML',
              })
              .catch(() => undefined),
          () => ctx.reply(ctx.t('bot.add.start_failed')).catch(() => undefined),
        )
        .catch(() => undefined);
    }
  }

  composer.command('add_bot', rateLimitMiddleware('add_bot'), async (ctx) => {
    await handleAdd(ctx, (ctx.match ?? '').toString());
  });

  composer.command('remove_bot', async (ctx) => {
    const arg = (ctx.match ?? '').toString().trim().replace(/^@/, '').toLowerCase();
    if (arg.length === 0) {
      await ctx.reply(ctx.t('bot.remove.usage'), { parse_mode: 'HTML' });
      return;
    }
    const record = ctx.repos.bots.findByUsername(arg);
    if (!record) {
      await ctx.reply(ctx.t('bot.remove.not_found', { username: escapeHtml(arg) }), {
        parse_mode: 'HTML',
      });
      return;
    }
    // The system's main bot row is created by the bootstrap from
    // MAIN_BOT_TOKEN and is NOT user-removable. The bootstrap re-seeds it
    // every boot anyway, but soft-deleting it would still take the bot
    // offline until next restart. Refuse here.
    if (record.mode === 'main_public') {
      await ctx.reply(ctx.t('bot.remove.not_allowed_main'), { parse_mode: 'HTML' });
      return;
    }
    const decision = ctx.services.permission.canManageBot(ctx.user, record);
    if (!decision.allowed) {
      await ctx.reply(ctx.t('common.error.permission_denied'));
      return;
    }
    ctx.services.bot.remove(record, ctx.user);
    if (childManager) {
      void childManager.stop(record.username).catch(() => undefined);
    }
    await ctx.reply(ctx.t('bot.remove.success', { username: escapeHtml(record.username) }), {
      parse_mode: 'HTML',
    });
  });

  /* ------------------------------------------------------------------- *
   * `/bots` — owner listing.
   * ------------------------------------------------------------------- */
  composer.command('bots', async (ctx) => {
    await handleBotsCommand(ctx);
  });
}

/**
 * Re-usable handler for the `/bots` command. Sends ONE chat message: the
 * owner's bot list, an inline hint with the add/remove command syntax, and
 * — when the Mini App is enabled — a single "Open Mini App" button. No
 * per-row buttons; per-bot management goes through the slash commands or
 * the Mini App so the chat doesn't accumulate stale keyboards.
 */
export async function handleBotsCommand(ctx: AppContext): Promise<void> {
  const bots = ctx.services.bot.listForOwner(ctx.user);
  const lines: string[] = [];
  if (bots.length === 0) {
    lines.push(ctx.t('bot.list_empty'));
  } else {
    lines.push(ctx.t('bot.list_header', { count: bots.length }));
    for (const b of bots) {
      lines.push(
        ctx.t('bot.list_item', {
          username: escapeHtml(b.username),
          mode: escapeHtml(b.mode),
          status: escapeHtml(b.status),
        }),
      );
    }
  }
  lines.push(ctx.t('bot.list_actions_hint'));

  const opts: Parameters<typeof ctx.reply>[1] = { parse_mode: 'HTML' };
  if (ctx.config.ENABLE_MINI_APP && ctx.config.MINI_APP_URL.length > 0) {
    const url = `${ctx.config.MINI_APP_URL.replace(/\/+$/, '')}/bots`;
    opts.reply_markup = new InlineKeyboard().webApp(ctx.t('menu.open_mini_app'), url);
  }

  await ctx.reply(lines.join('\n'), opts);
}
