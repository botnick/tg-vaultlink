/**
 * Shared file-delivery helper used by the `/start` deep-link path and the
 * decode router. Maps a stored {@link FileRow} (or any `(file_type, file_id,
 * caption?)` tuple) onto the appropriate grammY `replyWith*` call so the
 * recipient receives the original media kind back.
 */

import type { AppContext } from '../context.js';
import type { FileRow, FileType } from '../../types/index.js';

/** Minimal shape needed to dispatch a `replyWith*` call. */
export interface DeliverableItem {
  file_type: FileType;
  telegram_file_id: string;
  caption: string | null;
}

/**
 * Send the given file row back to the user using the stored Telegram
 * `file_id` and original caption (when present). Picks the right `replyWith*`
 * for the file type so a video does not arrive as a generic document, etc.
 */
export async function deliverFile(ctx: AppContext, file: FileRow): Promise<void> {
  await deliverItem(ctx, {
    file_type: file.file_type,
    telegram_file_id: file.telegram_file_id,
    caption: file.caption,
  });
}

/**
 * Generic delivery used by both single-file shares and collection items.
 * Takes the structurally-typed {@link DeliverableItem} so collection items —
 * which are NOT {@link FileRow}s — can flow through the same dispatcher.
 */
export async function deliverItem(ctx: AppContext, item: DeliverableItem): Promise<void> {
  const id = item.telegram_file_id;
  const captionOpt = item.caption !== null ? { caption: item.caption } : {};

  switch (item.file_type) {
    case 'document':
      await ctx.replyWithDocument(id, captionOpt);
      return;
    case 'photo':
      await ctx.replyWithPhoto(id, captionOpt);
      return;
    case 'video':
      await ctx.replyWithVideo(id, captionOpt);
      return;
    case 'audio':
      await ctx.replyWithAudio(id, captionOpt);
      return;
    case 'voice':
      await ctx.replyWithVoice(id, captionOpt);
      return;
    case 'animation':
      await ctx.replyWithAnimation(id, captionOpt);
      return;
    case 'sticker':
      await ctx.replyWithSticker(id);
      return;
  }
}
