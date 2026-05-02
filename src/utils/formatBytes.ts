/**
 * VaultLink Bot — byte-size formatter.
 *
 * Uses binary divisors (1024) so the numbers line up with what Telegram and
 * most file managers show, but prefers the friendlier "KB / MB / GB"
 * abbreviations over the technically-correct IEC "KiB / MiB / GiB". Values of
 * `null`/`undefined` yield the em-dash placeholder used across the bot UI.
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;
const PLACEHOLDER = '—';

export interface FormatBytesOptions {
  /** Number of decimal places to show (default 1, except for `B` which is integer). */
  precision?: number;
}

/**
 * Format a byte count using binary divisors with friendly unit labels.
 *
 *   formatBytes(0)        // "0 B"
 *   formatBytes(1024)     // "1.0 KB"
 *   formatBytes(1_048_576) // "1.0 MB"
 *   formatBytes(null)     // "—"
 */
export function formatBytes(
  bytes: number | null | undefined,
  opts: FormatBytesOptions = {},
): string {
  if (bytes === null || bytes === undefined) return PLACEHOLDER;
  if (!Number.isFinite(bytes)) return PLACEHOLDER;

  const precision = opts.precision ?? 1;
  const negative = bytes < 0;
  let value = Math.abs(bytes);

  let unitIndex = 0;
  while (value >= 1024 && unitIndex < UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  const unit = UNITS[unitIndex] as string;
  const formatted = unitIndex === 0 ? String(Math.round(value)) : value.toFixed(precision);
  return `${negative ? '-' : ''}${formatted} ${unit}`;
}
