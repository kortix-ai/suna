'use client';

import { useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';

/**
 * How many of a scene's beats have landed. `times` are ms from the moment
 * `play` turns true; pass a module constant so the timers are set once. A
 * scene restarts when its host remounts it. Reduced motion: every beat has
 * landed, so the scene shows its final state and nothing moves.
 */
export function useBeats(play: boolean, times: readonly number[]) {
  const reduced = Boolean(useReducedMotion());
  const [landed, setLanded] = useState(0);
  useEffect(() => {
    if (!play || reduced) return;
    const ids = times.map((ms, i) =>
      window.setTimeout(() => setLanded((n) => Math.max(n, i + 1)), ms),
    );
    return () => ids.forEach(clearTimeout);
  }, [play, reduced, times]);
  return reduced ? times.length : landed;
}
