/**
 * VaultLink Mini App — page header with optional back button.
 *
 * The actual back affordance is rendered both here (visible chrome on
 * platforms that don't show Telegram's BackButton) AND wired to the
 * native `Telegram.WebApp.BackButton` from the Layout. So users get
 * "the right answer" regardless of which control they reach for.
 */

import type { ReactNode } from 'react';
import { ChevronLeftIcon } from './icons.js';
import { hapticImpact } from '../lib/telegram.js';

interface Props {
  title: string;
  back?: () => void;
  right?: ReactNode;
}

export function Header({ title, back, right }: Props): JSX.Element {
  return (
    <header
      className="sticky top-0 z-30 flex items-center gap-2 bg-tg-header-bg/95 px-4 backdrop-blur-md"
      style={{ paddingTop: 'var(--safe-top)' }}
    >
      <div className="flex h-12 w-full items-center gap-2">
        {back ? (
          <button
            type="button"
            onClick={() => {
              hapticImpact('light');
              back();
            }}
            className="press-scale -ml-2 inline-flex h-9 w-9 items-center justify-center rounded-full text-tg-link hover:bg-tg-secondary-bg"
            aria-label="back"
          >
            <ChevronLeftIcon size={22} />
          </button>
        ) : null}
        <h1 className="flex-1 truncate text-lg font-semibold text-tg-text">{title}</h1>
        {right ? <div className="flex items-center gap-2">{right}</div> : null}
      </div>
    </header>
  );
}
