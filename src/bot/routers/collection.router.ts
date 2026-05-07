/**
 * Collection router.
 *
 * Owns every `coll:*` callback emitted by the collection-preview UI:
 *
 *   - preview navigation: `coll:page:<id>:<page>`, `coll:close:<id>`
 *   - bulk delivery: `coll:send_remaining:<id>:<fromPage>`
 *   - moderation hand-off: `coll:report:<id>`
 *   - owner/admin actions: `coll:lock:*`, `coll:delete:*`, etc.
 *
 * Preview rendering: each page is shipped as REAL media — photos and videos
 * grouped via `sendMediaGroup`, documents in their own group, audios in
 * their own, animations / voice / stickers individually. After the media a
 * separate text+keyboard message carries the page caption and the
 * pagination buttons (numbered, current page marked, plus a "send all
 * remaining" shortcut). Deep-link decode and the `coll:page:*` callback
 * both go through {@link sendCollectionPage} so the UX is identical.
 *
 * Bulk send is orchestrated here (NOT in the service) so the rate-limit
 * and delivery semantics stay close to the Telegram API surface; the
 * service exposes only `renderCollectionPage` for slicing.
 */

import { Composer, InlineKeyboard } from 'grammy';
import type {
  InputMediaAudio,
  InputMediaDocument,
  InputMediaPhoto,
  InputMediaVideo,
} from 'grammy/types';
import type { AppContext } from '../context.js';
import { AppError, ErrorCode } from '../../utils/errors.js';
import { deliverItem } from './_delivery.js';
import type { CollectionItemRow, CollectionRow } from '../../types/index.js';
import { escapeHtml } from '../../utils/safeText.js';
import { formatShareCode } from '../../utils/shareCodeFormat.js';
import { chargeRedemptionForCallback } from './_credit_charge.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Max numbered page buttons per row in the pagination keyboard. */
const PAGE_BUTTONS_PER_ROW = 5;

/**
 * Build the inline keyboard for one page of a collection preview.
 *
 * Layout (matches the original bot 1:1):
 *   - One numbered button per page (📗 for current — wired to the no-op
 *     `coll:noop` callback so clicking it doesn't re-deliver the same page,
 *     ❎ for others — wired to navigation).
 *   - A final row with "📂 send all remaining" (skipped on the last page).
 */
function previewKeyboard(
  ctx: AppContext,
  collectionId: number,
  currentPage: number,
  totalPages: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (let p = 1; p <= totalPages; p++) {
    if (p === currentPage) {
      kb.text(ctx.t('collection.preview.page_current', { page: p }), 'coll:noop');
    } else {
      kb.text(
        ctx.t('collection.preview.page_other', { page: p }),
        `coll:page:${collectionId}:${p}`,
      );
    }
    if (p % PAGE_BUTTONS_PER_ROW === 0 && p < totalPages) kb.row();
  }
  if (currentPage < totalPages) {
    kb.row().text(
      ctx.t('collection.preview.button.send_remaining'),
      `coll:send_remaining:${collectionId}:${currentPage + 1}`,
    );
  }
  return kb;
}

/** Convenience: page=1 entry point used by the deep-link decode path. */
export async function sendCollectionPreview(
  ctx: AppContext,
  collection: CollectionRow,
): Promise<void> {
  await sendCollectionPage(ctx, collection, 1);
}

/**
 * Render and send one page of the collection: actual media first, then a
 * text + keyboard message below. Photos and videos go in one media group;
 * documents and audios get their own homogeneous groups; voice / animation
 * / sticker fall back to individual sends because Telegram doesn't allow
 * them in media groups.
 */
export async function sendCollectionPage(
  ctx: AppContext,
  collection: CollectionRow,
  pageNum: number,
): Promise<void> {
  const rendered = ctx.services.share.renderCollectionPage({
    collection,
    page: pageNum,
    locale: ctx.locale,
  });

  const photoVideo: Array<InputMediaPhoto | InputMediaVideo> = [];
  const documents: InputMediaDocument[] = [];
  const audios: InputMediaAudio[] = [];
  const others: CollectionItemRow[] = [];

  for (const it of rendered.items) {
    if (it.file_type === 'photo') {
      photoVideo.push({ type: 'photo', media: it.telegram_file_id });
    } else if (it.file_type === 'video') {
      photoVideo.push({ type: 'video', media: it.telegram_file_id });
    } else if (it.file_type === 'document') {
      documents.push({ type: 'document', media: it.telegram_file_id });
    } else if (it.file_type === 'audio') {
      audios.push({ type: 'audio', media: it.telegram_file_id });
    } else {
      others.push(it);
    }
  }

  await flushMediaBucket(ctx, photoVideo, rendered.items);
  await flushMediaBucket(ctx, documents, rendered.items);
  await flushMediaBucket(ctx, audios, rendered.items);
  for (const it of others) {
    try {
      await deliverItem(ctx, {
        file_type: it.file_type,
        telegram_file_id: it.telegram_file_id,
        caption: null,
      });
    } catch {
      // Best-effort: skip items that Telegram refuses.
    }
  }

  const isLastPage = rendered.page >= rendered.totalPages;
  if (isLastPage) {
    // Final page — no more navigation to offer. Reply with a "complete"
    // message that includes the full share code (with type-count suffix)
    // and, on the public main bot, a hint to spin up a private decoder.
    const counts = ctx.repos.collections.countItemsByType(collection.id);
    const shareCode = formatShareCode(ctx.bot.username, collection.code, counts);
    const addBotHint =
      ctx.bot.mode === 'main_public' && ctx.config.ENABLE_CHILD_BOTS
        ? ctx.t('collection.preview.add_bot_hint')
        : '';
    const completeText = ctx.t('collection.preview.complete', {
      total: rendered.totalItems,
      shareCode: escapeHtml(shareCode),
      addBotHint,
    });
    await ctx.reply(completeText, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
    return;
  }

  const kb = previewKeyboard(ctx, collection.id, rendered.page, rendered.totalPages);
  await ctx.reply(rendered.caption, { parse_mode: 'HTML', reply_markup: kb });
}

/**
 * Send a single homogeneous bucket. Uses `sendMediaGroup` when there are
 * 2+ items (Telegram requires that minimum); falls back to individual
 * sends for a single item, or when the group call fails (e.g. an expired
 * file_id in the middle).
 */
async function flushMediaBucket(
  ctx: AppContext,
  bucket: ReadonlyArray<InputMediaPhoto | InputMediaVideo | InputMediaDocument | InputMediaAudio>,
  pageItems: ReadonlyArray<CollectionItemRow>,
): Promise<void> {
  if (bucket.length === 0) return;

  if (bucket.length >= 2) {
    try {
      // grammY's `replyWithMediaGroup` accepts the union — TS sometimes
      // needs the cast because of how the per-type overloads are written.
      await ctx.replyWithMediaGroup(bucket as ReadonlyArray<InputMediaPhoto | InputMediaVideo>);
      return;
    } catch {
      // Fall through to individual sends so a single bad file_id doesn't
      // take down the whole page.
    }
  }

  for (const m of bucket) {
    const item = pageItems.find((i) => i.telegram_file_id === m.media);
    if (!item) continue;
    try {
      await deliverItem(ctx, {
        file_type: item.file_type,
        telegram_file_id: item.telegram_file_id,
        caption: null,
      });
    } catch {
      // skip
    }
  }
}

async function deliverItemsBatch(ctx: AppContext, items: CollectionItemRow[]): Promise<number> {
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
   * Preview navigation
   * ------------------------------------------------------------------ */
  // No-op for the "current page" button — clicking it just dismisses the
  // loading spinner instead of re-delivering the same media. Mirrors the
  // original bot's UX where 📗<n> is effectively a label, not a link.
  composer.callbackQuery('coll:noop', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

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
      await ctx.services.share.ensureAccessible({ collection, actor: ctx.user });
    } catch (err) {
      if (err instanceof AppError && err.expose) {
        await ctx.answerCallbackQuery({ text: err.message });
        return;
      }
      throw err;
    }
    await ctx.answerCallbackQuery();

    // Delete the previous page's keyboard message before delivering the new
    // page so the chat doesn't accumulate stale "Page N/M" bubbles. The
    // media itself (sent on previous pages) is left in place so the user
    // can scroll back through what they've already seen.
    try {
      await ctx.deleteMessage();
    } catch {
      // Not worth surfacing — message may already be gone.
    }

    await sendCollectionPage(ctx, collection, requestedPage);
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
   * Bulk send (remaining pages from `fromPage` onward)
   * ------------------------------------------------------------------ */
  composer.callbackQuery(/^coll:send_remaining:(\d+):(\d+)$/, async (ctx) => {
    const m = ctx.match;
    const id = Number.parseInt(m?.[1] ?? '0', 10);
    const fromPage = Math.max(1, Number.parseInt(m?.[2] ?? '1', 10));
    const collection = ctx.repos.collections.findById(id);
    if (!collection) {
      await ctx.answerCallbackQuery({ text: ctx.t('decode.not_found') });
      return;
    }
    try {
      await ctx.services.share.ensureAccessible({ collection, actor: ctx.user });
    } catch (err) {
      if (err instanceof AppError && err.expose) {
        await ctx.answerCallbackQuery({ text: err.message });
        return;
      }
      throw err;
    }
    const total = ctx.repos.collections.countItems(collection.id);
    const pageSize = ctx.config.COLLECTION_PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const remainingPages = Math.max(0, pages - fromPage + 1);
    const remainingItems = remainingPages * pageSize;
    if (remainingItems > ctx.config.MAX_BULK_SEND_ITEMS) {
      await ctx.answerCallbackQuery({
        text: ctx.t('collection.send_all.too_many', { max: ctx.config.MAX_BULK_SEND_ITEMS }),
      });
      return;
    }

    // Wave 9 — charge for the bulk-send action (per-item surcharge applies
    // when configured). The callback-flavored helper handles the user
    // notification on insufficient credits AND answers the callback query.
    const charge = await chargeRedemptionForCallback(ctx, {
      kind: 'collection_send',
      referenceType: 'collection',
      referenceId: collection.id,
      ownerUserId: collection.owner_user_id,
      itemCount: remainingItems,
    });
    if (!charge) return;

    await ctx.answerCallbackQuery();

    let sent = 0;
    try {
      for (let p = fromPage; p <= pages; p++) {
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
    } catch (err) {
      ctx.services.credits.refund(charge, String(err));
      throw err;
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
    if (!ctx.services.permission.isAdmin(ctx.user) && collection.owner_user_id !== ctx.user.id) {
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
    if (!ctx.services.permission.isAdmin(ctx.user) && collection.owner_user_id !== ctx.user.id) {
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
    if (!ctx.services.permission.isAdmin(ctx.user) && collection.owner_user_id !== ctx.user.id) {
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

  // Keep a reference so the unused-imports linter doesn't trip.
  void ErrorCode.INTERNAL_ERROR;
}
