'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * How often a streaming message's markdown is re-parsed and re-rendered.
 *
 * The sync store applies a delta per ~16 ms event batch. Re-parsing the
 * message at that rate is most of the main-thread cost of a streaming turn,
 * and a reader cannot follow text that changes 60 times a second anyway.
 * 80 ms (12.5 renders a second) still reads as live typing.
 */
export const STREAM_RENDER_INTERVAL_MS = 80;

interface CadenceTimers {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: never) => void;
}

const defaultTimers: CadenceTimers = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/**
 * Leading + trailing throttle for a streamed value.
 *
 * - The first change shows at once.
 * - Further changes inside the interval collapse into ONE trailing show of
 *   the latest value at the interval edge.
 * - `active: false` (the stream ended) shows the latest value immediately
 *   and cancels any trailing timer, so a settled message never lags.
 *
 * Framework-free so the schedule is unit-tested with a manual clock.
 */
export function createStreamingCadence(
  show: (value: string) => void,
  timers: CadenceTimers = defaultTimers,
  intervalMs = STREAM_RENDER_INTERVAL_MS,
) {
  let shown: string | undefined;
  let latest: string | undefined;
  let lastShownAt = -Infinity;
  let timer: unknown = null;

  const cancel = () => {
    if (timer !== null) timers.clearTimeout(timer as never);
    timer = null;
  };
  const flush = () => {
    timer = null;
    if (latest === undefined || latest === shown) return;
    shown = latest;
    lastShownAt = timers.now();
    show(latest);
  };

  return {
    push(value: string, active: boolean) {
      latest = value;
      if (!active) {
        cancel();
        flush();
        return;
      }
      if (value === shown) return;
      const wait = intervalMs - (timers.now() - lastShownAt);
      if (wait <= 0) {
        cancel();
        flush();
        return;
      }
      if (timer === null) timer = timers.setTimeout(flush, wait);
    },
    dispose() {
      cancel();
    },
  };
}

/**
 * `value`, re-emitted at most once per `STREAM_RENDER_INTERVAL_MS` while
 * `active`. Returns `value` itself once the stream ends.
 */
export function useStreamingCadence(value: string, active: boolean): string {
  const [shown, setShown] = useState(value);
  const cadenceRef = useRef<ReturnType<typeof createStreamingCadence> | null>(null);
  if (cadenceRef.current === null) cadenceRef.current = createStreamingCadence(setShown);

  useEffect(() => {
    cadenceRef.current?.push(value, active);
  }, [value, active]);
  useEffect(() => () => cadenceRef.current?.dispose(), []);

  return active ? shown : value;
}
