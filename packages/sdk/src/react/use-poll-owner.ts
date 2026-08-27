'use client';

import { useEffect, useId, useSyncExternalStore } from 'react';

import {
  claimPoller,
  isPollOwner,
  releasePoller,
  subscribePollOwner,
} from '../core/session/poll-owner';

/**
 * Does THIS component own the polling cadence for `scope`?
 *
 * TanStack schedules `refetchInterval` per OBSERVER, so N components mounting
 * one query polled it N times over. Give the interval to the owner and `false`
 * to everyone else: they all read the same cache entry, so an answer still
 * reaches every one of them — only the scheduling is exclusive. See
 * `core/session/poll-owner.ts` for the rules and the measurements.
 *
 * `enabled` is not a convenience. An observer that is not going to poll must
 * not hold the cadence, or the session stops being polled at all.
 */
export function usePollOwner(scope: string, enabled = true): boolean {
  // Stable for the life of this component instance, and unique across
  // instances — which is exactly the identity a claim needs.
  const id = useId();
  const active = enabled && !!scope;

  useEffect(() => {
    if (!active) return;
    claimPoller(scope, id);
    return () => releasePoller(scope, id);
  }, [active, scope, id]);

  return useSyncExternalStore(
    (onChange) => (active ? subscribePollOwner(scope, onChange) : () => {}),
    () => active && isPollOwner(scope, id),
    // On the server nothing polls, and rendering "not the owner" everywhere is
    // the honest answer: no timer exists to own.
    () => false,
  );
}
