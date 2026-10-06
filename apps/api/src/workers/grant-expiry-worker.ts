import { runGrantExpirySweepOnce } from '../iam/expiry-sweeper';
import { runWorkerTick } from '../shared/audit-scope';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

// Recursive setTimeout (not setInterval) so a slow tick can't cause overlapping
// runs: with setInterval, a tick that took longer than TICK_MS would start the
// next one before the prior finished — two ticks racing inside one process,
// the same duplicate-audit problem the multi-replica case had. Re-arming AFTER
// settle guarantees serial execution per process.
export function startGrantExpirySweeper(): void {
  if (timer) return; // already armed, idempotent
  stopped = false;
  // Fire once on boot so an expiry that happened during downtime is logged
  // immediately rather than waiting up to a minute.
  void tickAndRearm();
}

async function tickAndRearm(): Promise<void> {
  try {
    await runWorkerTick('iam-grant-expiry', runGrantExpirySweepOnce);
  } catch (err) {
    console.error('[iam expiry sweeper] tick failed', err);
  }
  if (stopped) return;
  timer = setTimeout(tickAndRearm, TICK_MS);
}

export function stopGrantExpirySweeper(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
