'use client';

import {
  sessionListStatus,
  sessionStartingStuck,
  type ProjectSession,
} from '@kortix/sdk';
import { useEffect, useState } from 'react';

/**
 * Whether this row's boot has sat in the starting family past the SDK's
 * `SESSION_STARTING_STUCK_MS` — the wedged boot the row names in words (hover
 * card, screen-reader description) instead of an indefinite spinner
 * (KRTX-1687).
 *
 * The clock ticks only while the row sits in the starting family: a settled
 * row reads one static `Date.now()` and runs no interval. A starting row
 * ticks at the list's own provisioning poll cadence (5s), so the flip lands
 * within one tick of the threshold — the list's data does not change while a
 * boot is wedged, so without this clock nothing would ever re-render.
 */
export function useStartingStuck(session: ProjectSession): boolean {
  const starting = sessionListStatus(session) === 'starting';
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!starting) return;
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, [starting]);
  return starting && sessionStartingStuck(session, now);
}
