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
 * A restart (`stop()` then `start()`, a lease flap) while a run is in flight
 * used to start the new chain's first run at once, beside the old one. The new
 * run now waits for the old one to settle, so two runs never overlap. A wait
 * over `SLOW_WAIT_MS` logs a warning with the timer's `name`.
 *
 * `run` returns the delay until the next tick.
 */
import { logger } from '../lib/logger';
import { isLeader } from './leader-election';

const SLOW_WAIT_MS = 10_000;

export function leaderTimer(
  run: () => Promise<number>,
  options: { firstDelayMs?: number; name?: string } = {},
): { start(): void; stop(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let started = false;
  let inFlight: Promise<unknown> = Promise.resolve();

  const arm = (generationAtArm: number, delayMs: number) => {
    timer = setTimeout(() => void tick(generationAtArm), delayMs);
  };

  async function tick(generationAtStart: number): Promise<void> {
    timer = null;
    const waitStarted = performance.now();
    await inFlight;
    const waited = Math.round(performance.now() - waitStarted);
    if (waited > SLOW_WAIT_MS) logger.warn('[leader-timer] a restarted timer waited for the run before the restart', { name: options.name, ms: waited });
    if (generationAtStart !== generation || !isLeader()) return;
    let next: number;
    try {
      const running = run();
      inFlight = running.catch(() => undefined);
      next = await running;
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
