/**
 * VaultLink Mini App — formatting helpers.
 *
 * Locale-aware date + size formatting. We deliberately avoid Intl
 * RelativeTimeFormat for "expires in N days" copy because Telegram's
 * webview ships old Intl data on some Android builds; the manual
 * branch below is bulletproof and tiny.
 */

import type { Locale } from '../types/api.js';

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;
const TB = GB * 1024;

export function formatBytes(bytes: number | null | undefined, fractionDigits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${(bytes / KB).toFixed(fractionDigits)} KB`;
  if (bytes < GB) return `${(bytes / MB).toFixed(fractionDigits)} MB`;
  if (bytes < TB) return `${(bytes / GB).toFixed(fractionDigits)} GB`;
  return `${(bytes / TB).toFixed(fractionDigits)} TB`;
}

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: Locale): Intl.DateTimeFormat {
  const tag = locale === 'th' ? 'th-TH' : 'en-US';
  let f = dateFormatterCache.get(tag);
  if (!f) {
    f = new Intl.DateTimeFormat(tag, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    dateFormatterCache.set(tag, f);
  }
  return f;
}

export function formatDate(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  try {
    return dateFormatter(locale).format(new Date(t));
  } catch {
    return new Date(t).toISOString();
  }
}

/**
 * Returns "expires today / in N days / N days ago" copy. Keeps the
 * call site compact — no need to feed it through i18n unless the
 * caller wants full sentence translations.
 */
export function relativeDays(iso: string | null | undefined, locale: Locale): string {
  if (!iso) return locale === 'th' ? 'ไม่จำกัดเวลา' : 'No expiry';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  const diffMs = t - Date.now();
  const diffDays = Math.round(diffMs / (24 * 60 * 60 * 1000));
  if (locale === 'th') {
    if (diffDays === 0) return 'หมดอายุวันนี้';
    if (diffDays > 0) return `เหลืออีก ${diffDays} วัน`;
    return `หมดอายุไปแล้ว ${Math.abs(diffDays)} วัน`;
  }
  if (diffDays === 0) return 'expires today';
  if (diffDays > 0) return `in ${diffDays} day${diffDays === 1 ? '' : 's'}`;
  return `${Math.abs(diffDays)} day${Math.abs(diffDays) === 1 ? '' : 's'} ago`;
}
