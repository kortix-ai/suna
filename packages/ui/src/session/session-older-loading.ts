'use client';

import { useEffect, useState } from 'react';

/**
 * How long the "loading older messages" row stays on screen after the pull
 * that raised it has landed.
 *
 * An older-history pull against a warm session is a single request and often
 * lands inside 150ms. Rendered raw, the row is a flash — one frame of text
 * that is gone before it can be read, which is worse than no indicator at all:
 * the transcript still grows upward, and nothing ever explained why. Held, it
 * is a sentence the reader has time to finish, and the prepended turns arrive
 * underneath it.
 *
 * 600ms also outlasts a 2Hz observer, so "a loading state was shown" is
 * something the E2E harness can actually catch rather than race.
 */
export const OLDER_LOADING_MIN_MS = 600;

/** What the older-history row should do this commit. */
export type OlderLoadingPhase = 'show' | 'hold' | 'hide';

/**
 * Pure: the row's phase, from the live flag and whether the row is already up.
 *
 * - `show` — a pull is in flight; the row is up now, in this commit.
 * - `hold` — the pull landed while the row was up: keep it for
 *   `OLDER_LOADING_MIN_MS`, then take it down.
 * - `hide` — nothing to say.
 *
 * Separated from the timer so the anti-flash rule is a test rather than a
 * reading of `useEffect`.
 */
export function olderLoadingPhase(input: {
  isLoadingOlder: boolean;
  visible: boolean;
}): OlderLoadingPhase {
  if (input.isLoadingOlder) return 'show';
  return input.visible ? 'hold' : 'hide';
}

/**
 * The live flag, kept up for `OLDER_LOADING_MIN_MS` after the pull ends.
 *
 * The row is raised by the adjust-state-during-render pattern, not by an
 * effect: it must be up in the SAME commit the pull starts, and an effect that
 * raises it is both a frame late and a cascading render. The one effect here
 * does what only a timer can — take the row back down.
 */
export function useHeldOlderLoading(
  isLoadingOlder: boolean,
  minMs = OLDER_LOADING_MIN_MS,
): boolean {
  const [wasLoading, setWasLoading] = useState(isLoadingOlder);
  const [visible, setVisible] = useState(isLoadingOlder);

  if (wasLoading !== isLoadingOlder) {
    setWasLoading(isLoadingOlder);
    if (isLoadingOlder) setVisible(true);
  }

  useEffect(() => {
    if (olderLoadingPhase({ isLoadingOlder, visible }) !== 'hold') return;
    const timer = setTimeout(() => setVisible(false), minMs);
    return () => clearTimeout(timer);
  }, [isLoadingOlder, visible, minMs]);

  return visible;
}
