'use client';

import { useEffect, useState } from 'react';

/**
 * How long a freshly mounted session may say NOTHING about its runtime.
 *
 * Long enough to cover the first health probe + `GET .../turn` round trip on a
 * healthy session (both answer well inside a second locally and on dev), short
 * enough that a genuinely parked box still announces its wake promptly. The
 * cost of being wrong in one direction is a false "your session dropped" flash
 * on every page load; in the other, a real wake notice arrives ~1.5s later.
 */
export const READINESS_SETTLE_MS = 1_500;

/**
 * True while the runtime has not been contacted yet AND the mount is young.
 *
 * Feeds `sessionComposerReadiness({ settling })`, whose fallback would
 * otherwise assert "Waking this session up…" the instant a page loads — the
 * one claim nothing had checked. See that input's docstring.
 */
export function useReadinessSettling(uncontacted: boolean, windowMs = READINESS_SETTLE_MS): boolean {
  // The window is identified by WHEN it opened, and that instant is state, not a
  // ref: an earlier cut bumped a ref inside the effect and compared it during
  // render, so on the first render of each window the ref still held the
  // previous value, the hook answered "not settling", and the notice this hook
  // exists to suppress flashed anyway before the effect could run.
  const [openedAt, setOpenedAt] = useState<number | null>(null);
  const [elapsedFor, setElapsedFor] = useState<number | null>(null);

  useEffect(() => {
    if (!uncontacted) {
      setOpenedAt(null);
      return;
    }
    const startedAt = Date.now();
    setOpenedAt(startedAt);
    const timer = window.setTimeout(() => setElapsedFor(startedAt), windowMs);
    return () => window.clearTimeout(timer);
  }, [uncontacted, windowMs]);

  // Settling from the first render onward: `openedAt === null` means the effect
  // has not run yet, which is the very moment the flash used to happen.
  if (!uncontacted) return false;
  return openedAt === null || elapsedFor !== openedAt;
}
