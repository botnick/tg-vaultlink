/**
 * `/new` router — share-creation entry point (Wave 7).
 *
 * Replaces the legacy "send a file from anywhere" UX with an explicit
 * picker: single file vs. collection. The actual upload still happens in
 * `upload.router.ts` (which now also routes inbound media into an open
 * collection draft when one exists).
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { AppError } from '../../utils/errors.js';

/** Build the "single vs collection" picker keyboard. */
function newKeyboard(ctx: AppContext): InlineKeyboard {
  const kb = new InlineKeyboard().text(ctx.t('new.choose_single'), 'new:single');
  if (ctx.config.ENABLE_COLLECTIONS) {
    kb.text(ctx.t('new.choose_collection'), 'new:collection');
  }
  return kb;
}

/** Build the in-draft action keyboard shown after a draft is opened. */
function draftKeyboard(ctx: AppContext): InlineKeyboard {
  return new InlineKeyboard()
    .text(ctx.t('collection.draft.button.finish'), 'coll:finish')
    .text(ctx.t('collection.draft.button.summary'), 'coll:summary')
    .row()
    .text(ctx.t('collection.draft.button.cancel'), 'coll:cancel');
}

/**
 * Shared handler so the `/new` command and `menu:new` callback re-use the
 * same code path.
 */
export async function handleNewCommand(ctx: AppContext): Promise<void> {
  await ctx.reply(ctx.t('new.choose_prompt'), {
    reply_markup: newKeyboard(ctx),
  });
}

export function registerNewRouter(composer: Composer<AppContext>): void {
  composer.command('new', async (ctx) => {
    await handleNewCommand(ctx);
  });

  composer.callbackQuery('new:single', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(ctx.t('new.send_file'));
  });

  composer.callbackQuery('new:collection', async (ctx) => {
    if (!ctx.config.ENABLE_COLLECTIONS) {
      await ctx.answerCallbackQuery({ text: ctx.t('new.feature_disabled') });
      return;
    }
    try {
      ctx.services.share.createCollectionDraft(ctx.user, ctx.bot);
    } catch (err) {
      if (err instanceof AppError && err.expose) {
        await ctx.answerCallbackQuery({ text: err.message });
        return;
      }
      throw err;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(ctx.t('collection.draft.started'), {
      reply_markup: draftKeyboard(ctx),
    });
  });
}
