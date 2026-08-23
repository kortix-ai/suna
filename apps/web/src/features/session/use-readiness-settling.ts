'use client';

import { useEffect, useRef, useState } from 'react';

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
  // Each uninterrupted stretch of "uncontacted" is one ARM. The timer reports
  // which arm it belongs to, so a session switch (uncontacted false -> true)
  // starts a fresh window without a state reset inside the effect.
  const armRef = useRef(0);
  const [expiredArm, setExpiredArm] = useState(-1);

  useEffect(() => {
    if (!uncontacted) return;
    const arm = (armRef.current += 1);
    const timer = window.setTimeout(() => setExpiredArm(arm), windowMs);
    return () => window.clearTimeout(timer);
  }, [uncontacted, windowMs]);

  return uncontacted && expiredArm !== armRef.current;
}
