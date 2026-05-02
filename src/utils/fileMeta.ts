/**
 * VaultLink Bot — Telegram message media extractor.
 *
 * Reduces a Telegram `Message` shape down to the dominant attachment so the
 * upload pipeline can persist a single canonical row. The util is structurally
 * typed (no grammY dependency) so it remains easy to unit-test in isolation.
 *
 * Priority order, by intent rather than the order Telegram packs fields in:
 *
 *   document → video → animation → audio → voice → photo → sticker
 *
 * For photos, Telegram delivers an array of size variants; we pick the
 * highest-resolution entry (largest `file_size` if present, otherwise largest
 * `width * height`).
 */

import type { FileType } from '../types/index.js';

export interface ExtractedFileMeta {
  file_type: FileType;
  telegram_file_id: string;
  telegram_file_unique_id: string | null;
  file_name: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  caption: string | null;
}

/** Minimal structural type for what we read off the message. */
export interface TelegramMessageLike {
  caption?: string | null;
  document?: {
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  photo?: Array<{
    file_id: string;
    file_unique_id?: string;
    width: number;
    height: number;
    file_size?: number;
  }>;
  video?: {
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration: number;
    width: number;
    height: number;
  };
  audio?: {
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration: number;
    performer?: string;
    title?: string;
  };
  voice?: {
    file_id: string;
    file_unique_id?: string;
    mime_type?: string;
    file_size?: number;
    duration: number;
  };
  animation?: {
    file_id: string;
    file_unique_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
    duration: number;
  };
  sticker?: {
    file_id: string;
    file_unique_id?: string;
    emoji?: string;
    set_name?: string;
    file_size?: number;
    is_animated?: boolean;
    is_video?: boolean;
  };
}

function nullish<T>(v: T | undefined | null): T | null {
  return v === undefined || v === null ? null : v;
}

function pickPhoto(
  photos: NonNullable<TelegramMessageLike['photo']>,
): NonNullable<TelegramMessageLike['photo']>[number] | null {
  if (photos.length === 0) return null;
  let best = photos[0]!;
  let bestSize = best.file_size ?? best.width * best.height;
  for (let i = 1; i < photos.length; i++) {
    const p = photos[i]!;
    const size = p.file_size ?? p.width * p.height;
    if (size > bestSize) {
      best = p;
      bestSize = size;
    }
  }
  return best;
}

function stickerMime(s: NonNullable<TelegramMessageLike['sticker']>): string {
  if (s.is_animated) return 'application/x-tgsticker';
  if (s.is_video) return 'video/webm';
  return 'image/webp';
}

/**
 * Pulls the dominant attachment off a Telegram message. Returns `null` if no
 * recognized media is present.
 */
export function extractFileMeta(msg: TelegramMessageLike): ExtractedFileMeta | null {
  const caption = nullish(msg.caption);

  if (msg.document) {
    const d = msg.document;
    return {
      file_type: 'document',
      telegram_file_id: d.file_id,
      telegram_file_unique_id: nullish(d.file_unique_id),
      file_name: nullish(d.file_name),
      mime_type: nullish(d.mime_type),
      size_bytes: nullish(d.file_size),
      caption,
    };
  }

  if (msg.video) {
    const v = msg.video;
    return {
      file_type: 'video',
      telegram_file_id: v.file_id,
      telegram_file_unique_id: nullish(v.file_unique_id),
      file_name: nullish(v.file_name),
      mime_type: nullish(v.mime_type),
      size_bytes: nullish(v.file_size),
      caption,
    };
  }

  if (msg.animation) {
    const a = msg.animation;
    return {
      file_type: 'animation',
      telegram_file_id: a.file_id,
      telegram_file_unique_id: nullish(a.file_unique_id),
      file_name: nullish(a.file_name),
      mime_type: nullish(a.mime_type),
      size_bytes: nullish(a.file_size),
      caption,
    };
  }

  if (msg.audio) {
    const a = msg.audio;
    return {
      file_type: 'audio',
      telegram_file_id: a.file_id,
      telegram_file_unique_id: nullish(a.file_unique_id),
      file_name: nullish(a.file_name),
      mime_type: nullish(a.mime_type),
      size_bytes: nullish(a.file_size),
      caption,
    };
  }

  if (msg.voice) {
    const v = msg.voice;
    return {
      file_type: 'voice',
      telegram_file_id: v.file_id,
      telegram_file_unique_id: nullish(v.file_unique_id),
      file_name: null,
      mime_type: nullish(v.mime_type),
      size_bytes: nullish(v.file_size),
      caption,
    };
  }

  if (msg.photo && msg.photo.length > 0) {
    const p = pickPhoto(msg.photo);
    if (p) {
      return {
        file_type: 'photo',
        telegram_file_id: p.file_id,
        telegram_file_unique_id: nullish(p.file_unique_id),
        file_name: null,
        mime_type: 'image/jpeg',
        size_bytes: nullish(p.file_size),
        caption,
      };
    }
  }

  if (msg.sticker) {
    const s = msg.sticker;
    return {
      file_type: 'sticker',
      telegram_file_id: s.file_id,
      telegram_file_unique_id: nullish(s.file_unique_id),
      file_name: nullish(s.set_name),
      mime_type: stickerMime(s),
      size_bytes: nullish(s.file_size),
      caption,
    };
  }

  return null;
}
