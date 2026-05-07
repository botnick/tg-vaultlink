/**
 * VaultLink Mini App — typed wrapper around `window.Telegram.WebApp`.
 *
 * This is the ONLY module allowed to read off the global. Every other
 * file imports the helpers below instead of poking at `window.Telegram`
 * directly. That keeps the outside-Telegram guard correct and makes
 * unit testing trivial (mock these functions).
 */

/* ----------------------------------------------------------------- *
 * Minimal subset of the Telegram WebApp surface we actually use.
 * The full SDK type set lives in @types/telegram-web-app, but
 * pulling that in just for these few calls is overkill.
 * ----------------------------------------------------------------- */

export interface TgThemeParams {
  bg_color?: string;
  text_color?: string;
  hint_color?: string;
  link_color?: string;
  button_color?: string;
  button_text_color?: string;
  secondary_bg_color?: string;
  section_bg_color?: string;
  header_bg_color?: string;
  accent_text_color?: string;
  destructive_text_color?: string;
  subtitle_text_color?: string;
}

export type TgColorScheme = 'light' | 'dark';

export interface TgWebApp {
  initData: string;
  initDataUnsafe?: { user?: { id?: number; first_name?: string; username?: string } };
  colorScheme: TgColorScheme;
  themeParams: TgThemeParams;
  isExpanded?: boolean;
  expand?(): void;
  close?(): void;
  ready?(): void;
  onEvent?(eventType: string, handler: () => void): void;
  offEvent?(eventType: string, handler: () => void): void;
  HapticFeedback?: {
    impactOccurred?(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
    notificationOccurred?(type: 'error' | 'success' | 'warning'): void;
    selectionChanged?(): void;
  };
  BackButton?: {
    show(): void;
    hide(): void;
    onClick(handler: () => void): void;
    offClick(handler: () => void): void;
  };
  showAlert?(message: string, callback?: () => void): void;
  showConfirm?(message: string, callback?: (ok: boolean) => void): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  /**
   * Open a Telegram Stars / payment provider invoice inside the Mini App.
   * Available since WebApp 6.1 (Bot API 6.1+). The callback fires once
   * with the user's terminal status. We always pass a callback so we can
   * resolve the returned Promise.
   */
  openInvoice?(
    url: string,
    callback?: (status: 'paid' | 'cancelled' | 'failed' | 'pending') => void,
  ): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
  }
}

/** Returns the WebApp handle if we're inside Telegram, otherwise `null`. */
export function getWebApp(): TgWebApp | null {
  if (typeof window === 'undefined') return null;
  return window.Telegram?.WebApp ?? null;
}

/** Returns the verified-via-server initData blob, or `''` outside Telegram. */
export function getInitData(): string {
  return getWebApp()?.initData ?? '';
}

/**
 * True when the page is being rendered inside the official Telegram
 * client AND initData is non-empty (which means signature verification
 * upstream is at least possible).
 */
export function isInsideTelegram(): boolean {
  return getInitData().length > 0;
}

export function getColorScheme(): TgColorScheme {
  return getWebApp()?.colorScheme ?? 'light';
}

export function getThemeParams(): TgThemeParams {
  return getWebApp()?.themeParams ?? {};
}

/** Subscribe to live `themeChanged` events from Telegram. */
export function onThemeChanged(cb: () => void): () => void {
  const wa = getWebApp();
  if (!wa?.onEvent || !wa.offEvent) return () => {};
  wa.onEvent('themeChanged', cb);
  return () => wa.offEvent?.('themeChanged', cb);
}

/** Tell Telegram we're ready — clears the loading shimmer over the iframe. */
export function readyWebApp(): void {
  getWebApp()?.ready?.();
}

/** Expand the WebApp to its full available height. */
export function expandWebApp(): void {
  getWebApp()?.expand?.();
}

export function closeWebApp(): void {
  getWebApp()?.close?.();
}

/**
 * Native bottom-sheet confirm. Resolves to the user's choice.
 * Note: we still ship our own `<ConfirmDialog>` for destructive
 * actions because it's themable and shows custom button labels;
 * `showConfirm` is reserved for outside-Telegram fallbacks.
 */
export function showConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const wa = getWebApp();
    if (!wa?.showConfirm) {
      resolve(window.confirm(message));
      return;
    }
    wa.showConfirm(message, (ok) => resolve(ok));
  });
}

export function showAlert(message: string): Promise<void> {
  return new Promise((resolve) => {
    const wa = getWebApp();
    if (!wa?.showAlert) {
      window.alert(message);
      resolve();
      return;
    }
    wa.showAlert(message, () => resolve());
  });
}

export type HapticImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';

/** Fire a light haptic if the host supports it. No-op outside Telegram. */
export function hapticImpact(style: HapticImpactStyle = 'light'): void {
  try {
    getWebApp()?.HapticFeedback?.impactOccurred?.(style);
  } catch {
    // Some hosts throw on unsupported styles — never let UX code crash.
  }
}

export function hapticNotify(type: 'error' | 'success' | 'warning'): void {
  try {
    getWebApp()?.HapticFeedback?.notificationOccurred?.(type);
  } catch {
    /* swallow */
  }
}

/* ----------------------------------------------------------------- *
 * BackButton bridge — used by the Layout's optional back chrome.
 * ----------------------------------------------------------------- */

export function showBackButton(handler: () => void): () => void {
  const wa = getWebApp();
  const bb = wa?.BackButton;
  if (!bb) return () => {};
  bb.onClick(handler);
  bb.show();
  return () => {
    bb.offClick(handler);
    bb.hide();
  };
}

export function hideBackButton(): void {
  getWebApp()?.BackButton?.hide();
}

/* ----------------------------------------------------------------- *
 * Stars / openInvoice bridge (Wave 9.2)
 * ----------------------------------------------------------------- */

export type InvoiceStatus = 'paid' | 'cancelled' | 'failed' | 'pending' | 'unsupported';

/**
 * Open the Telegram Stars payment sheet inline inside the Mini App. The
 * Promise resolves to the terminal status reported by Telegram, or
 * `'unsupported'` when running on an old client / outside Telegram.
 *
 * Usage:
 *   const status = await openInvoice(invoiceLink);
 *   if (status === 'paid') queryClient.invalidateQueries({ queryKey: qk.credits.summary });
 */
export function openInvoice(invoiceLink: string): Promise<InvoiceStatus> {
  return new Promise((resolve) => {
    const wa = getWebApp();
    if (!wa?.openInvoice) {
      resolve('unsupported');
      return;
    }
    try {
      wa.openInvoice(invoiceLink, (status) => resolve(status));
    } catch {
      resolve('unsupported');
    }
  });
}
