/**
 * VaultLink Mini App — app chrome.
 *
 * Three slots: header (sticky), main content, optional bottom-nav.
 * The Telegram BackButton is wired automatically when `back` is set,
 * so the user gets the native chrome too — not just our in-page
 * back chevron.
 */

import { useEffect, type ReactNode } from 'react';
import { Header } from './Header.js';
import { BottomNav } from './BottomNav.js';
import { showBackButton } from '../lib/telegram.js';

interface Props {
  title: string;
  back?: () => void;
  /** Hide the bottom-tab nav (used on detail pages). */
  hideNav?: boolean;
  right?: ReactNode;
  children: ReactNode;
}

export function Layout({ title, back, hideNav = false, right, children }: Props): JSX.Element {
  useEffect(() => {
    if (!back) return undefined;
    return showBackButton(back);
  }, [back]);

  return (
    <div className="min-h-screen bg-tg-bg text-tg-text">
      <Header title={title} {...(back ? { back } : {})} {...(right ? { right } : {})} />
      <main
        className="mx-auto max-w-md px-4 py-4"
        style={{ paddingBottom: hideNav ? 'calc(1rem + var(--safe-bottom))' : '5.5rem' }}
      >
        {children}
      </main>
      {hideNav ? null : <BottomNav />}
    </div>
  );
}
