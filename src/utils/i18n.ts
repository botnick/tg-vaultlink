/**
 * VaultLink Bot — locale dispatcher.
 *
 * Loads both Thai and English message catalogs at module-init time via static
 * JSON import attributes (NodeNext + ESM). Lookups go through {@link t}, which
 * throws on missing keys — silent English fallback would mask shipping bugs
 * where a Thai key was forgotten. The public API is intentionally tiny.
 *
 * Locale JSON files use **flat keys with dots** (e.g.
 * `"common.button.cancel": "ยกเลิก"`), and values may contain `{{var}}`
 * placeholders that are interpolated from the `params` argument.
 */

import thLocale from '../locales/th.json' with { type: 'json' };
import enLocale from '../locales/en.json' with { type: 'json' };
import { SUPPORTED_LOCALES } from '../config/constants.js';
import type { Locale } from '../types/index.js';
import { AppError, ErrorCode } from './errors.js';

const LOCALES: Record<Locale, Record<string, string>> = {
  th: thLocale as Record<string, string>,
  en: enLocale as Record<string, string>,
};

/** Type guard: is `input` a supported locale code? */
export function isSupportedLocale(input: string): input is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(input);
}

/**
 * Resolve a translation key for the given locale, interpolating any `{{var}}`
 * placeholders from `params`. Both unknown keys and unfilled placeholders are
 * treated as bugs and throw {@link AppError} (`INTERNAL_ERROR`) — the bot
 * fails loud during development and gets caught by the global error boundary
 * in production.
 */
export function t(locale: Locale, key: string, params?: Record<string, string | number>): string {
  const table = LOCALES[locale];
  const template = table[key];
  if (template === undefined) {
    throw new AppError(ErrorCode.INTERNAL_ERROR, `missing translation key: ${locale}/${key}`);
  }
  if (params === undefined || Object.keys(params).length === 0) {
    if (template.includes('{{')) {
      // Template wants params but caller passed none — surface the bug.
      const missing = extractFirstPlaceholder(template);
      if (missing !== null) {
        throw new AppError(
          ErrorCode.INTERNAL_ERROR,
          `missing translation param: ${locale}/${key}/${missing}`,
        );
      }
    }
    return template;
  }
  return template.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(params, name)) {
      throw new AppError(
        ErrorCode.INTERNAL_ERROR,
        `missing translation param: ${locale}/${key}/${name}`,
      );
    }
    return String(params[name]);
  });
}

/** Enumerate the locale codes the bot ships with. */
export function locales(): readonly Locale[] {
  return SUPPORTED_LOCALES;
}

function extractFirstPlaceholder(template: string): string | null {
  const m = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/.exec(template);
  return m ? (m[1] as string) : null;
}
