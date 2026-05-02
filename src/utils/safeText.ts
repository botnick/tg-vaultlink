/**
 * VaultLink Bot — text-safety helpers for outbound Telegram messages.
 *
 * The bot uses `parse_mode: 'HTML'` for every reply, so user-supplied strings
 * (filenames, captions, report reasons) must have HTML-special characters
 * escaped before they hit `bot.api.sendMessage`. Telegram's HTML parser only
 * recognises a small allowlist of tags; everything else is treated as
 * literal text, which means the four characters `<`, `>`, `&`, and `"` cover
 * the entire surface area we need to defend against.
 */

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

/** Escape text destined for Telegram's HTML parse mode. */
export function escapeHtml(input: string): string {
  if (typeof input !== 'string') return '';
  return input.replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch] as string);
}

/**
 * Truncate `input` to `max` characters and append a single ellipsis (`…`) when
 * truncation occurs. Returns `''` for `null`/`undefined`. Counted in code
 * units, which is what Telegram's UI cares about for layout.
 */
export function truncate(input: string | null | undefined, max: number): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') return '';
  if (max <= 0) return '';
  if (input.length <= max) return input;
  if (max === 1) return '…';
  return `${input.slice(0, max - 1)}…`;
}

/**
 * Strip ASCII control characters (preserving `\n` and `\t`), collapse runs of
 * whitespace into a single space, then trim and `truncate(_, max)`. Useful
 * for log-friendly representations of arbitrary user input.
 */
export function sanitizeOneLine(input: string | null | undefined, max: number): string {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') return '';
  // Drop ASCII control chars except tab (\x09) and newline (\x0A).
  const stripped = input.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
  // Collapse all whitespace runs (spaces, tabs, newlines) to a single space.
  const collapsed = stripped.replace(/\s+/g, ' ').trim();
  return truncate(collapsed, max);
}
