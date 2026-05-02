/**
 * Share-code display format helpers.
 *
 * The canonical "share code" the user sees in chat is:
 *
 *     <botUsername>:<baseCode>[<typeSuffix>]
 *
 * The base code is the random alphanumeric the resolver looks up. The type
 * suffix is purely cosmetic — it tells the recipient at a glance how many
 * photos / videos / etc. the share contains, e.g.:
 *
 *     myshare_bot:KQ7TG2X4NPM3_5P_1V_1D
 *                              ^^^^^^^^
 *                              5 photos · 1 video · 1 document
 *
 * Letters are stable per file type and never collide with the base-code
 * alphabet because the base code can't contain `_`. Order is fixed so the
 * suffix is byte-identical for any given count vector.
 *
 * Deep links (`?start=<code>`) intentionally use the base code only —
 * Telegram's start parameter does not benefit from the cosmetic suffix.
 */

import type { FileType } from '../types/index.js';

/** Stable per-type letter. Keep additions backward-compatible. */
const TYPE_LETTERS: Record<FileType, string> = {
  photo: 'P',
  video: 'V',
  document: 'D',
  audio: 'A',
  voice: 'W',
  animation: 'G',
  sticker: 'S',
};

/** Render order — keep this fixed; downstream tools may parse the suffix. */
const TYPE_ORDER: readonly FileType[] = [
  'photo',
  'video',
  'document',
  'audio',
  'voice',
  'animation',
  'sticker',
];

export type FileTypeCounts = Partial<Record<FileType, number>>;

/**
 * Build the type-count suffix string. Returns `''` when every count is zero
 * (callers can concatenate unconditionally without producing a trailing `_`).
 */
export function buildTypeSuffix(counts: FileTypeCounts): string {
  const parts: string[] = [];
  for (const t of TYPE_ORDER) {
    const n = counts[t] ?? 0;
    if (n > 0) parts.push(`_${n}${TYPE_LETTERS[t]}`);
  }
  return parts.join('');
}

/**
 * Compose the full display share code. Equivalent to
 * `${botUsername}:${baseCode}${suffix(counts)}`.
 */
export function formatShareCode(
  botUsername: string,
  baseCode: string,
  counts: FileTypeCounts = {},
): string {
  return `${botUsername}:${baseCode}${buildTypeSuffix(counts)}`;
}

/**
 * Convenience for a single-file share — the count vector is just `{type: 1}`.
 */
export function formatSingleFileShareCode(
  botUsername: string,
  baseCode: string,
  type: FileType,
): string {
  return formatShareCode(botUsername, baseCode, { [type]: 1 });
}
