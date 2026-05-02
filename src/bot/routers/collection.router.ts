/**
 * Collection router (Wave 7).
 *
 * Owns every `coll:*` callback emitted by the share-creation wizard and the
 * collection-preview UI:
 *
 *   - draft lifecycle: `coll:finish`, `coll:summary`, `coll:cancel`
 *   - preview navigation: `coll:page:<id>:<page>`, `coll:close:<id>`
 *   - bulk delivery: `coll:send_all:<id>`
 *   - moderation hand-off: `coll:report:<id>`
 *   - owner/admin actions: `coll:lock:*`, `coll:delete:*`, etc.
 *
 * Bulk send is orchestrated here (NOT in the service) so the rate-limit and
 * delivery semantics stay close to the Telegram API surface; the service
 * exposes only `renderCollectionPage` for slicing.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type { AppContext } from '../context.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { escapeHtml } from '../../utils/safeText.js';
import { deliverItem } from './_delivery.js';
import type { CollectionItemRow, CollectionRow } from '../../types/index.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Build the inline keyboard for one page of a collection preview. */
function previewKeyboard(
  ctx: AppContext,
  collectionId: number,
  page: number,
  totalPages: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (page > 1) {
    kb.text(ctx.t('collection.preview.button.prev'), `coll:page:${collectionId}:${page - 1}`);
  }
  if (page < totalPages) {
    kb.text(ctx.t('collection.preview.button.next'), `coll:page:${collectionId}:${page + 1}`);
  }
  kb.row()
    .text(ctx.t('collection.preview.button.send_all'), `coll:send_all:${collectionId}`)
    .text(ctx.t('collection.preview.button.report'), `coll:report:${collectionId}`)
    .row()
    .text(ctx.t('collection.preview.button.close'), `coll:close:${collectionId}`);
  return kb;
}

/** Render page 1 of a collection as a fresh reply. */
export async function sendCollectionPreview(
  ctx: AppContext,
  collection: CollectionRow,
): Promise<void> {
  const page = ctx.services.share.renderCollectionPage({
    collection,
    page: 1,
    locale: ctx.locale,
  });
  const kb = previewKeyboard(ctx, collection.id, page.page, page.totalPages);
  await ctx.reply(page.caption, { parse_mode: 'HTML', reply_markup: kb });
}

async function deliverItemsBatch(
  ctx: AppContext,
  items: CollectionItemRow[],
): Promise<number> {
  let sent = 0;
  for (const it of items) {
    try {
      await deliverItem(ctx, {
        file_type: it.file_type,
        telegram_file_id: it.telegram_file_id,
        caption: it.caption,
      });
      sent++;
    } catch {
      // Telegram occasionally returns transient send errors; we surface a
      // best-effort total to the user rather than aborting on the first one.
    }
  }
  return sent;
}

export function registerCollectionRouter(composer: Composer<AppContext>): void {
  /* ------------------------------------------------------------------ *
   * Draft lifecycle
   * ------------------------------------------------------------------ */
  composer.callbackQuery('coll:finish', async (ctx) => {
    if (!ctx.config.ENABLE_COLLECTIONS) {
      await ctx.answerCallbackQuery({ text: ctx.t('new.feature_disabled') });
      return;
    }
    const draft = ctx.services.share.getOpenDraft(ctx.user, ctx.bot);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: ctx.t('common.nothing_to_cancel') });
      return;
    }
    try {
      const result = await ctx.services.share.finishCollection(draft, ctx.user);
      await ctx.answerCallbackQuery();
      await ctx.reply(
        ctx.t('collection.finished', {
          shareCode: escapeHtml(result.shareCode),
          deepLink: escapeHtml(result.deepLink),
          total: result.collection.total_items,
        }),
        { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
      );
    } catch (err) {
      if (err instanceof AppError && err.expose) {
        await ctx.answerCallbackQuery({ text: err.message });
        return;
      }
      throw err;
    }
  });

  composer.callbackQuery('coll:summary', async (ctx) => {
    if (!ctx.config.ENABLE_COLLECTIONS) {
      await ctx.answerCallbackQuery({ text: ctx.t('new.feature_disabled') });
      return;
    }
    const draft = ctx.services.share.getOpenDraft(ctx.user, ctx.bot);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: ctx.t('common.nothing_to_cancel') });
      return;
    }
    const counts = ctx.repos.collectionDrafts.countItemsByType(draft.id);
    const total = ctx.repos.collectionDrafts.countItems(draft.id);
    await ctx.answerCallbackQuery();
    await ctx.reply(
      ctx.t('collection.draft.summary', {
        total,
        photo: counts.photo,
        video: counts.video,
        doc: counts.document,
        audio: counts.audio,
        voice: counts.voice,
        animation: counts.animation,
        sticker: counts.sticker,
      }),
      { parse_mode: 'HTML' },
    );
  });

  composer.callbackQuery('coll:cancel', async (ctx) => {
    if (!ctx.config.ENABLE_COLLECTIONS) {
      await ctx.answerCallbackQuery({ text: ctx.t('new.feature_disabled') });
      return;
    }
    const draft = ctx.services.share.getOpenDraft(ctx.user, ctx.bot);
    if (!draft) {
      await ctx.answerCallbackQuery({ text: ctx.t('common.nothing_to_cancel') });
      return;
    }
    ctx.services.share.cancelDraft(draft, ctx.user);
    await ctx.answerCallbackQuery();
    await ctx.reply(ctx.t('collection.draft.cancelled'));
  });

  /* ------------------------------------------------------------------ *
   * Preview navigation
   * ------------------------------------------------------------------ */
  composer.callbackQuery(/^coll:page:(\d+):(\d+)$/, async (ctx) => {
    const m = ctx.match;
    const collectionId = Number.parseInt(m?.[1] ?? '0', 10);
    const requestedPage = Number.parseInt(m?.[2] ?? '1', 10);
    const collection = ctx.repos.collections.findById(collectionId);
    if (!collection) {
      await ctx.answerCallbackQuery({ text: ctx.t('decode.not_found') });
      return;
    }
    try {
      await ctx.services.share.ensureAccessible({ collection });
    } catch (err) {
      if (err instanceof AppError && err.expose) {
        await ctx.answerCallbackQuery({ text: err.message });
        return;
      }
      throw err;
    }
    const page = ctx.services.share.renderCollectionPage({
      collection,
      page: requestedPage,
      locale: ctx.locale,
    });
    const kb = previewKeyboard(ctx, collection.id, page.page, page.totalPages);
    try {
      await ctx.editMessageText(page.caption, { parse_mode: 'HTML', reply_markup: kb });
    } catch {
      // editing fails when the message is too old or content unchanged; fall
      // back to a fresh reply so the user still gets the page.
      await ctx.reply(page.caption, { parse_mode: 'HTML', reply_markup: kb });
    }
    await ctx.answerCallbackQuery();
  });

  composer.callbackQuery(/^coll:close:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.deleteMessage();
    } catch {
      // ignore — message may already be gone
    }
  });

  /* ------------------------------------------------------------------ *
   * Bulk send
   * ------------------------------------------------------------------ */
  composer.callbackQuery(/^coll:send_all:(\d+)$/, async (ctx) => {
    const m = ctx.match;
    const id = Number.parseInt(m?.[1] ?? '0', 10);
    const collection = ctx.repos.collections.findById(id);
    if (!collection) {
      await ctx.answerCallbackQuery({ text: ctx.t('decode.not_found') });
      return;
    }
    try {
      await ctx.services.share.ensureAccessible({ collection });
    } catch (err) {
      if (err instanceof AppError && err.expose) {
        await ctx.answerCallbackQuery({ text: err.message });
        return;
      }
      throw err;
    }
    const total = ctx.repos.collections.countItems(collection.id);
    if (total > ctx.config.MAX_BULK_SEND_ITEMS) {
      await ctx.answerCallbackQuery({
        text: ctx.t('collection.send_all.too_many', { max: ctx.config.MAX_BULK_SEND_ITEMS }),
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(ctx.t('collection.send_all.starting', { total }));

    const pageSize = ctx.config.COLLECTION_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    let sent = 0;
    for (let p = 1; p <= pages; p++) {
      const slice = ctx.services.share.renderCollectionPage({
        collection,
        page: p,
        locale: ctx.locale,
      });
      sent += await deliverItemsBatch(ctx, slice.items);
      if (p < pages) {
        await sleep(ctx.config.COLLECTION_SEND_DELAY_MS);
      }
    }
    ctx.services.share.recordCollectionAccess(collection, ctx.user);
    await ctx.reply(ctx.t('collection.send_all.completed', { count: sent }));
  });

  /* ------------------------------------------------------------------ *
   * Report (placeholder — surfaces the prompt; the user replies and the
   * existing /report command picks it up).
   * ------------------------------------------------------------------ */
  composer.callbackQuery(/^coll:report:(\d+)$/, async (ctx) => {
    if (!ctx.config.ENABLE_REPORTS) {
      await ctx.answerCallbackQuery({ text: ctx.t('common.error.feature_disabled') });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(ctx.t('collection.report.prompt'));
  });

  /* ------------------------------------------------------------------ *
   * Owner/admin per-collection actions
   * ------------------------------------------------------------------ */
  composer.callbackQuery(/^coll:lock:(\d+):(0|1)$/, async (ctx) => {
    const m = ctx.match;
    const id = Number.parseInt(m?.[1] ?? '0', 10);
    const wantLock = m?.[2] === '1';
    const collection = ctx.repos.collections.findById(id);
    if (!collection) {
      await ctx.answerCallbackQuery({ text: ctx.t('decode.not_found') });
      return;
    }
    if (
      !ctx.services.permission.isAdmin(ctx.user) &&
      collection.owner_user_id !== ctx.user.id
    ) {
      await ctx.answerCallbackQuery({ text: ctx.t('files.not_yours') });
      return;
    }
    ctx.services.share.setLocked(collection, wantLock, ctx.user);
    await ctx.answerCallbackQuery({ text: wantLock ? 'locked' : 'unlocked' });
  });

  composer.callbackQuery(/^coll:delete:(\d+)$/, async (ctx) => {
    const m = ctx.match;
    const id = Number.parseInt(m?.[1] ?? '0', 10);
    const collection = ctx.repos.collections.findById(id);
    if (!collection) {
      await ctx.answerCallbackQuery({ text: ctx.t('decode.not_found') });
      return;
    }
    if (
      !ctx.services.permission.isAdmin(ctx.user) &&
      collection.owner_user_id !== ctx.user.id
    ) {
      await ctx.answerCallbackQuery({ text: ctx.t('files.not_yours') });
      return;
    }
    ctx.services.share.softDeleteCollection(collection, ctx.user);
    await ctx.answerCallbackQuery({ text: 'deleted' });
  });

  composer.callbackQuery(/^coll:visibility:(\d+):(public|private)$/, async (ctx) => {
    const m = ctx.match;
    const id = Number.parseInt(m?.[1] ?? '0', 10);
    const vis = m?.[2] as 'public' | 'private';
    const collection = ctx.repos.collections.findById(id);
    if (!collection) {
      await ctx.answerCallbackQuery({ text: ctx.t('decode.not_found') });
      return;
    }
    if (
      !ctx.services.permission.isAdmin(ctx.user) &&
      collection.owner_user_id !== ctx.user.id
    ) {
      await ctx.answerCallbackQuery({ text: ctx.t('files.not_yours') });
      return;
    }
    ctx.services.share.setVisibility(collection, vis, ctx.user);
    await ctx.answerCallbackQuery({ text: `visibility=${vis}` });
  });

  composer.callbackQuery(/^coll:set_password:(\d+)$/, async (ctx) => {
    if (!ctx.config.ENABLE_PASSWORD_PROTECTION) {
      await ctx.answerCallbackQuery({
        text: ctx.t('common.error.feature_disabled'),
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(ctx.t('password.set.usage'), { parse_mode: 'HTML' });
  });

  composer.callbackQuery(/^coll:set_expiry:(\d+)$/, async (ctx) => {
    if (!ctx.config.ENABLE_FILE_EXPIRY) {
      await ctx.answerCallbackQuery({
        text: ctx.t('common.error.feature_disabled'),
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.reply(ctx.t('files.delete_usage'), { parse_mode: 'HTML' });
  });

  // The above register accepts but we still need to hold the unused ErrorCode
  // import bound somewhere if we keep referencing AppError below — silence
  // unused warnings by referencing the type once.
  void ErrorCode.INTERNAL_ERROR;
}
