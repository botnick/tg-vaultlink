/**
 * Live-updating countdown hook for invoice expiry timers.
 *
 * Re-renders the consumer every second while the deadline is in the future
 * so the user sees the seconds tick down. The interval auto-stops once the
 * deadline has passed (or is invalid), keeping the component idle while
 * the invoice is in a terminal state.
 *
 * Returns the remaining time pre-formatted as `mm:ss` plus the raw split
 * for callers that want to render their own layout (e.g. only minutes
 * when a list row is too tight for both numbers).
 */

import { useEffect, useState } from 'react';

export interface Countdown {
  /** Whole minutes left (rounded down). */
  readonly minutes: number;
  /** Seconds component (0-59). */
  readonly seconds: number;
  /** Pre-formatted `mm:ss` (zero-padded). */
  readonly mmss: string;
  /** Total milliseconds remaining. 0 when expired or invalid. */
  readonly totalMs: number;
  /** True when the deadline has passed or the input is malformed. */
  readonly expired: boolean;
}

const ZERO: Countdown = {
  minutes: 0,
  seconds: 0,
  mmss: '00:00',
  totalMs: 0,
  expired: true,
};

function compute(deadlineMs: number, nowMs: number): Countdown {
  if (!Number.isFinite(deadlineMs)) return ZERO;
  const totalMs = Math.max(0, deadlineMs - nowMs);
  if (totalMs <= 0) return ZERO;
  const totalSeconds = Math.floor(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return { minutes, seconds, mmss, totalMs, expired: false };
}

/**
 * @param expiresAt ISO timestamp (any value `new Date()` can parse).
 * @param tickMs    How often to re-render. Defaults to 1000 ms (1 s).
 */
export function useCountdown(
  expiresAt: string | null | undefined,
  tickMs = 1000,
): Countdown {
  const deadlineMs = expiresAt ? new Date(expiresAt).getTime() : Number.NaN;
  const [state, setState] = useState<Countdown>(() => compute(deadlineMs, Date.now()));

  useEffect(() => {
    // Recompute immediately whenever the deadline reference changes so a
    // freshly-loaded invoice doesn't display stale state from the previous
    // render.
    setState(compute(deadlineMs, Date.now()));
    if (!Number.isFinite(deadlineMs)) return;
    const id = setInterval(() => {
      const next = compute(deadlineMs, Date.now());
      setState(next);
      // Stop ticking once expired — the consumer can re-mount if the
      // invoice gets extended.
      if (next.expired) clearInterval(id);
    }, tickMs);
    return () => clearInterval(id);
  }, [deadlineMs, tickMs]);

  return state;
}
