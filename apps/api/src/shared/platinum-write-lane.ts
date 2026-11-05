/**
 * Platinum gives an org one write budget: 20 requests/s sustained (bucket `org_mutation`), and
 * every non-GET call counts, `expose` and `exec` included. The worker's sweeps (the reaper's stops
 * and lifecycle renewals, the idle lane, the active-turn renewal) sent bursts that took the whole
 * budget, so a session start in the same second got 429 (prod 2026-11-04: 668 refusals, 380 of them
 * the reaper's). Background work runs inside {@link inPlatinumBackgroundLane}; its writes leave this
 * process at most KORTIX_PLATINUM_BACKGROUND_WRITES_PER_SECOND apart. A call outside the lane is
 * never delayed.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config';

const lane = new AsyncLocalStorage<true>();
/** replica-local: the next free slot of this process's background lane (epoch ms). Only the worker runs the sweeps. */
let nextSlotAt = 0;

/** Run background work whose Platinum writes, and those of every async call it starts, are paced. */
export function inPlatinumBackgroundLane<T>(run: () => Promise<T>): Promise<T> {
  return lane.run(true, run);
}

/** Waits for the next slot when `method` is a write inside the lane; resolves at once otherwise. */
export async function awaitPlatinumWriteSlot(
  method: string,
  now = Date.now(),
  sleep: (ms: number) => Promise<unknown> = (ms) => Bun.sleep(ms),
): Promise<void> {
  const perSecond = config.KORTIX_PLATINUM_BACKGROUND_WRITES_PER_SECOND;
  if (perSecond <= 0 || method === 'GET' || method === 'HEAD' || !lane.getStore()) return;
  const at = Math.max(now, nextSlotAt);
  nextSlotAt = at + 1_000 / perSecond;
  if (at > now) await sleep(at - now);
}

/** Seam for tests: the slot clock is module state. */
export function __resetPlatinumWriteLaneForTests(): void {
  nextSlotAt = 0;
}
