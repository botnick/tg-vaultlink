/**
 * VaultLink Mini App — I18n provider.
 *
 * The locale comes from `/me` (set via `AuthProvider`). This provider
 * exposes:
 *   - `t(key, params)` for translating strings (with `{{name}}` substitution).
 *   - `useLocale()` for components that branch on the active locale.
 *   - A setter so the Settings screen can switch language at runtime.
 *
 * Side-effect: whenever `locale` changes we update `<html data-locale>`
 * + `lang` so the right font family kicks in (see `index.css`).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import th from '../locales/th.json';
import en from '../locales/en.json';
import type { Locale } from '../types/api.js';

type Bundle = Record<string, string>;

const BUNDLES: Record<Locale, Bundle> = {
  th: th as Bundle,
  en: en as Bundle,
};

interface I18nState {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nState | null>(null);

function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const v = params[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

interface Props {
  initialLocale: Locale;
  children: ReactNode;
}

export function I18nProvider({ initialLocale, children }: Props): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);

  // Keep `<html data-locale>` and the `lang` attr in sync — both for
  // a11y (screen readers pick the right voice/profile) and for the
  // CSS font-family selector.
  useEffect(() => {
    document.documentElement.setAttribute('data-locale', locale);
    document.documentElement.lang = locale === 'th' ? 'th' : 'en';
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
  }, []);

  const t = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      const bundle = BUNDLES[locale];
      const raw = bundle[key] ?? BUNDLES.en[key] ?? key;
      return params ? interpolate(raw, params) : raw;
    },
    [locale],
  );

  const value = useMemo<I18nState>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nState {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useT/useLocale must be used within <I18nProvider>');
  return ctx;
}

export function useT(): I18nState['t'] {
  return useI18n().t;
}

export function useLocale(): { locale: Locale; setLocale: (next: Locale) => void } {
  const { locale, setLocale } = useI18n();
  return { locale, setLocale };
}

/** Coerce an arbitrary string into one of our supported locales. */
export function coerceLocale(raw: string | null | undefined, fallback: Locale = 'th'): Locale {
  if (raw === 'th' || raw === 'en') return raw;
  return fallback;
}
