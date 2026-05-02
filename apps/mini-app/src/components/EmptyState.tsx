/**
 * VaultLink Mini App — empty-state placeholder.
 *
 * Used wherever a list returns zero rows. Keeping the visual language
 * consistent (icon + title + description + optional CTA) so the user
 * doesn't have to re-learn what "empty" looks like across screens.
 */

import type { ReactNode } from 'react';

interface Props {
  icon?: ReactNode;
  title: string;
  description?: string;
  cta?: ReactNode;
}

export function EmptyState({ icon, title, description, cta }: Props): JSX.Element {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center animate-fade-up">
      {icon ? (
        <div className="mb-5 flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-brand-indigo/20 to-brand-pink/20 text-tg-link animate-float">
          {icon}
        </div>
      ) : null}
      <h2 className="text-lg font-semibold text-tg-text">{title}</h2>
      {description ? (
        <p className="mt-2 max-w-sm text-sm text-tg-subtitle-text">{description}</p>
      ) : null}
      {cta ? <div className="mt-6">{cta}</div> : null}
    </div>
  );
}
