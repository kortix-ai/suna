'use client';

import { useSyncExternalStore } from 'react';

/**
 * A shared, ticking clock for relative-time labels.
 *
 * Three problems it solves at once, all of which a bare `Date.now()` in render
 * has:
 *
 *  1. **Purity.** `Date.now()` is an impure read during render — the React
 *     Compiler flags it, and correctly: a component that re-renders for an
 *     unrelated reason silently changes its output.
 *  2. **Staleness.** A run report left open showed "3m ago" for an hour. The
 *     store ticks, so every label ages on its own.
 *  3. **Disagreement.** Every consumer in one render reads the SAME instant, so
 *     two rows one millisecond apart can never show "3m" and "4m".
 *
 * ONE interval for the whole page, not one per component: a fifty-row report
 * would otherwise hold fifty timers. The interval only exists while something
 * is subscribed.
 */

/** 30s. Fine enough that a minute-granularity label is never more than a
 *  half-minute stale, coarse enough to be invisible in a profile. */
const TICK_MS = 30_000;

let current = Date.now();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (!timer) {
    // Re-read on the first subscribe: the module may have been evaluated long
    // before this page mounted.
    current = Date.now();
    timer = setInterval(() => {
      current = Date.now();
      for (const listener of listeners) listener();
    }, TICK_MS);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Cached, so `useSyncExternalStore` is not handed a new value every call. */
const getSnapshot = () => current;

/**
 * `0` on the server, deliberately.
 *
 * A server snapshot must be deterministic per request, and the module-scope
 * `current` is not — it is the process start time, shared across every request.
 * `0` makes every relative label read "just now" in server HTML, which is
 * never seen: every surface using this clock renders its rows from a
 * client-fetched query, so the server output is the loading state.
 */
const getServerSnapshot = () => 0;

/** The current instant, refreshed every 30s while mounted. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
