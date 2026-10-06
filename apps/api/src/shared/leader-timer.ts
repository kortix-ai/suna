/**
 * A serial, restartable timer for a leader-only sweeper.
 *
 * `stop()` used to clear the timer and set a flag, but an in-flight tick
 * re-armed itself on finish when a fast re-acquire had already called `start()`.
 * Two chains then ran for the whole term and doubled every sweep. Each `start()`
 * and `stop()` now moves a generation counter; a tick that finishes in an older
 * generation re-arms nothing. A tick also checks the lease first (`isLeader`),
 * so a leader whose renew deadline passed writes nothing.
 *
 * `run` returns the delay until the next tick.
 */
import { logger } from '../lib/logger';
import { isLeader } from './leader-election';

export function leaderTimer(
  run: () => Promise<number>,
  options: { firstDelayMs?: number } = {},
): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let started = false;

  const arm = (generationAtArm: number, delayMs: number) => {
    timer = setTimeout(() => void tick(generationAtArm), delayMs);
  };

  async function tick(generationAtStart: number): Promise<void> {
    timer = null;
    if (generationAtStart !== generation || !isLeader()) return;
    let next: number;
    try {
      next = await run();
    } catch (error) {
      logger.error('[leader-timer] tick failed', { error: error instanceof Error ? error.message : String(error) });
      next = 60_000;
    }
    if (generationAtStart === generation) arm(generationAtStart, next);
  }

  return {
    start() {
      if (started) return;
      started = true;
      generation += 1;
      if (options.firstDelayMs) arm(generation, options.firstDelayMs);
      else void tick(generation);
    },
    stop() {
      started = false;
      generation += 1;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
