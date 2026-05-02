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
        'rounded-3xl bg-tg-section-bg shadow-soft border border-black/[0.04] dark:border-white/[0.06] p-4',
        className,
      ].join(' ')}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="skeleton h-12 w-12 rounded-2xl shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="skeleton h-4 w-2/3 rounded-full" />
          <div className="skeleton h-3 w-1/2 rounded-full" />
        </div>
      </div>
      {Array.from({ length: Math.max(0, lines - 1) }).map((_, i) => (
        <div
          key={i}
          className="skeleton mb-2 h-3 rounded-full last:mb-0"
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
