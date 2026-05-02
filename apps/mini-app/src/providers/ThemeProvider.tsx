/**
 * VaultLink Mini App — ThemeProvider.
 *
 * Reads `Telegram.WebApp.colorScheme` + `themeParams` and pushes every
 * value into a CSS custom property on `<html>`. Subscribes to
 * `themeChanged` so a user toggling Telegram's appearance from inside
 * the host instantly reflows the Mini App without a reload.
 *
 * Outside Telegram: defaults from `index.css` apply (`data-theme="light"`).
 */

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  getColorScheme,
  getThemeParams,
  onThemeChanged,
  type TgColorScheme,
  type TgThemeParams,
} from '../lib/telegram.js';

interface ThemeState {
  colorScheme: TgColorScheme;
  themeParams: TgThemeParams;
}

const ThemeContext = createContext<ThemeState | null>(null);

const VAR_MAP: Array<[keyof TgThemeParams, string]> = [
  ['bg_color', '--tg-bg'],
  ['text_color', '--tg-text'],
  ['hint_color', '--tg-hint'],
  ['link_color', '--tg-link'],
  ['button_color', '--tg-button'],
  ['button_text_color', '--tg-button-text'],
  ['secondary_bg_color', '--tg-secondary-bg'],
  ['section_bg_color', '--tg-section-bg'],
  ['header_bg_color', '--tg-header-bg'],
  ['accent_text_color', '--tg-accent-text'],
  ['destructive_text_color', '--tg-destructive-text'],
  ['subtitle_text_color', '--tg-subtitle-text'],
];

function applyTheme(scheme: TgColorScheme, params: TgThemeParams): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', scheme);
  for (const [key, cssVar] of VAR_MAP) {
    const value = params[key];
    if (typeof value === 'string' && value.length > 0) {
      // `setProperty` with the third arg ensures we beat any
      // inline `style="..."` written by Telegram's iframe shell.
      root.style.setProperty(cssVar, value);
    } else {
      root.style.removeProperty(cssVar);
    }
  }
  // Sync the browser meta theme-color to bg_color so the system
  // status bar tints match (matters on Android in particular).
  const bg = params.bg_color;
  if (typeof bg === 'string' && bg.length > 0) {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.appendChild(meta);
    }
    meta.content = bg;
  }
}

interface Props {
  children: ReactNode;
}

export function ThemeProvider({ children }: Props): JSX.Element {
  const [state, setState] = useState<ThemeState>(() => ({
    colorScheme: getColorScheme(),
    themeParams: getThemeParams(),
  }));

  useEffect(() => {
    applyTheme(state.colorScheme, state.themeParams);
  }, [state]);

  useEffect(() => {
    const sync = (): void => {
      setState({ colorScheme: getColorScheme(), themeParams: getThemeParams() });
    };
    sync();
    return onThemeChanged(sync);
  }, []);

  return <ThemeContext.Provider value={state}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeState {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>');
  return ctx;
}
