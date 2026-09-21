'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { createPendingGate, type PendingGate } from '@/lib/pending-gate';

export interface PendingSnapshot<T> {
  /**
   * Wait for the guarded value to load. `true` when it landed, `false` when
   * the wait timed out — the caller must then refuse rather than proceed on a
   * value it never received.
   */
  settled: (timeoutMs?: number) => Promise<boolean>;
  /** The NEWEST value, not the one captured in the caller's render closure. */
  current: () => T;
  /** Whether the value is still loading right now. */
  pending: () => boolean;
}

/**
 * Await a reactive "still loading" flag, and read the value it guards without
 * a stale closure.
 *
 * Both halves matter. An async handler that awaits `settled()` resumes in a
 * closure built by an OLDER render, where the awaited value is still
 * `undefined` — so waiting alone would trade one wrong answer for another.
 * `current()` reads the ref the effect keeps live, which is the whole point:
 * decide against the real answer.
 *
 * See `lib/pending-gate.ts` for why the send path waits instead of refusing.
 */
export function usePendingSnapshot<T>(pending: boolean, value: T): PendingSnapshot<T> {
  // `useState`, not a lazily-filled ref: the gate must be created exactly once
  // and read during render, and a ref read during render is what
  // `react-hooks/refs` (correctly) rejects.
  const [gate] = useState<PendingGate>(() => createPendingGate(pending));

  // Read only from the closures below, which callers invoke outside render.
  const valueRef = useRef(value);

  useEffect(() => {
    valueRef.current = value;
    gate.set(pending);
  }, [gate, pending, value]);

  return useMemo(
    () => ({
      settled: (timeoutMs?: number) => gate.settled(timeoutMs),
      current: () => valueRef.current,
      pending: () => gate.pending(),
    }),
    [gate],
  );
}
