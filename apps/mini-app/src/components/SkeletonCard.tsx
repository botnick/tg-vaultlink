/**
 * VaultLink Mini App — animated skeleton row used while lists load.
 */

interface Props {
  lines?: number;
  className?: string;
}

export function SkeletonCard({ lines = 2, className = '' }: Props): JSX.Element {
  return (
    <div
      className={[
        'rounded-2xl bg-tg-section-bg shadow-sm border border-black/[0.04] dark:border-white/[0.06] p-4',
        className,
      ].join(' ')}
    >
      <div className="skeleton mb-3 h-4 w-2/3 rounded" />
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="skeleton mb-2 h-3 rounded last:mb-0"
          style={{ width: `${60 + ((i * 13) % 30)}%` }}
        />
      ))}
    </div>
  );
}

export function SkeletonList({
  rows = 4,
  lines = 2,
}: {
  rows?: number;
  lines?: number;
}): JSX.Element {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonCard key={i} lines={lines} />
      ))}
    </div>
  );
}
