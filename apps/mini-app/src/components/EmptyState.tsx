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
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      {icon ? <div className="mb-4 text-tg-hint opacity-80">{icon}</div> : null}
      <h2 className="text-lg font-semibold text-tg-text">{title}</h2>
      {description ? (
        <p className="mt-2 max-w-sm text-sm text-tg-subtitle-text">{description}</p>
      ) : null}
      {cta ? <div className="mt-5">{cta}</div> : null}
    </div>
  );
}
