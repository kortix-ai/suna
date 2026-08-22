/**
 * Wait for React to go QUIET under happy-dom — a commit-observing `flush()`
 * for the live-root tests, replacing the fixed `2 × 20 ms` timer that lost
 * the race with React under host load (a prepend that re-anchors through
 * `scrollToFn → setTimeout(0) → scroll event → setState → render` needs four
 * event-loop turns, and 40 ms of wall clock is not four turns on a busy box).
 *
 * One TURN:
 *   1. the timers phase (`setTimeout(0)`) — a hop a commit scheduled (the
 *      virtual seam's scroll event) fires and queues its React work;
 *   2. an IDLE-priority task on React's OWN scheduler — it runs only after
 *      every Normal-or-higher task ahead of it: the render (including one
 *      that yielded mid-way and continued), the passive-effect flush, and
 *      any re-render those effects or a native listener queued. When it
 *      resolves, React has nothing left to do for now.
 * A turn is BUSY while a one-shot animation frame is pending (`./dom` paces
 * and tracks frames; the two-frame containment flip and the overscan
 * warm-up are generation 0–1, an animation loop's later frames are not).
 * `flush()` resolves after `QUIET_TURNS` consecutive turns that were not
 * busy — so a chain of up to that many `setTimeout(0)` hops still completes
 * — and throws after `MAX_TURNS` (a tree that never settles is a bug, not a
 * slow host).
 *
 * The scheduler is the ONE `react-dom` uses: pnpm does not hoist it, so it
 * is resolved from `react-dom`'s real path (`flush.test.tsx` pins the single
 * instance in `require.cache` — a private copy would have an always-empty
 * queue and the idle probe would resolve before React rendered).
 */
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import { pendingAnimationFrames } from './dom';

type SchedulerModule = {
  unstable_IdlePriority: number;
  unstable_scheduleCallback(priority: number, callback: () => void): unknown;
};

function loadScheduler(): SchedulerModule {
  const reactDomDir = dirname(
    realpathSync(Bun.resolveSync('react-dom/package.json', import.meta.dir)),
  );
  return createRequire(import.meta.url)(
    Bun.resolveSync('scheduler', reactDomDir),
  ) as SchedulerModule;
}

export const scheduler: SchedulerModule = loadScheduler();

/** Consecutive idle turns before `flush()` resolves. */
export const QUIET_TURNS = 3;
/** Upper bound on turns per `flush()` — ~1 ms each on an idle loop. */
export const MAX_TURNS = 5000;

const timersPhase = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Resolves once React's scheduler has run everything queued ahead of an
 *  idle-priority task — i.e. React is idle at that instant. */
export const reactIdle = () =>
  new Promise<void>((resolve) => {
    scheduler.unstable_scheduleCallback(scheduler.unstable_IdlePriority, () => resolve());
  });

/** One event-loop turn: due timers, then React's queue drained. */
async function turn(): Promise<void> {
  await timersPhase();
  await reactIdle();
}

/** Resolve once React, its effects and the one-shot frames have all run and
 *  nothing new arrived for `QUIET_TURNS` turns. */
export async function flush(): Promise<void> {
  let quiet = 0;
  for (let i = 0; i < MAX_TURNS; i++) {
    await turn();
    quiet = pendingAnimationFrames() > 0 ? 0 : quiet + 1;
    if (quiet >= QUIET_TURNS) return;
  }
  throw new Error(`flush(): React did not go quiet within ${MAX_TURNS} turns`);
}
