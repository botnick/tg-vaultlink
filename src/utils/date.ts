/**
 * VaultLink Bot — date helpers.
 *
 * Centralizes the few date calculations the bot performs (expiry checks,
 * human-readable formatting for upload receipts and `/my_files`). All
 * persisted timestamps are ISO-8601 UTC strings; rendering uses
 * `Intl.DateTimeFormat` with the Asia/Bangkok timezone since the bot's primary
 * audience is Thai.
 */

const DISPLAY_TIMEZONE = 'Asia/Bangkok';

const TH_FORMATTER = new Intl.DateTimeFormat('th', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: DISPLAY_TIMEZONE,
  // Use Gregorian calendar with Buddhist-era OFF so the year matches what is
  // stored on the server (otherwise Thai locale defaults to BE).
  calendar: 'gregory',
  numberingSystem: 'latn',
});

const EN_FORMATTER = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: DISPLAY_TIMEZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
});

/** Current time as an ISO-8601 UTC string. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Return a new `Date` shifted by `days` (may be negative). */
export function addDays(date: Date, days: number): Date {
  const out = new Date(date.getTime());
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** Parse an ISO-8601 string into a `Date`. */
export function fromIso(iso: string): Date {
  return new Date(iso);
}

/**
 * Has `expiresAtIso` already passed? `null` means the resource never expires.
 * Pass `now` (typically a stable test clock) to override the wall clock.
 */
export function isExpired(expiresAtIso: string | null, now: Date = new Date()): boolean {
  if (expiresAtIso === null) return false;
  const t = Date.parse(expiresAtIso);
  if (Number.isNaN(t)) return false;
  return t <= now.getTime();
}

/** Format a `Date` as `"2 พ.ค. 2026 14:32"` (Thai locale, Asia/Bangkok). */
export function formatHumanThai(date: Date): string {
  const parts = TH_FORMATTER.formatToParts(date);
  return assembleParts(parts);
}

/** Format a `Date` as `"2 May 2026 14:32"` (English, Asia/Bangkok). */
export function formatHumanEn(date: Date): string {
  const parts = EN_FORMATTER.formatToParts(date);
  return assembleParts(parts);
}

/** Locale-aware human-readable formatter dispatcher. */
export function formatHuman(date: Date, locale: 'th' | 'en'): string {
  return locale === 'th' ? formatHumanThai(date) : formatHumanEn(date);
}

function assembleParts(parts: Intl.DateTimeFormatPart[]): string {
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === type);
    return p ? p.value : '';
  };
  const day = get('day');
  const month = get('month');
  const year = get('year');
  const hour = get('hour');
  const minute = get('minute');
  return `${day} ${month} ${year} ${hour}:${minute}`;
}
