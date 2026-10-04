import { runWorkerTick } from '../services/audit/audit-scope';
import { sweepStaleSlackTurns } from '../services/channels';

let gcTimer: ReturnType<typeof setInterval> | null = null;

/** Leader-only (bootstrap.ts): one replica sweeps, not all of them. */
export function startSlackTurnGc(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    void runWorkerTick('slack-turn-gc', async () => {
      try {
        await sweepStaleSlackTurns();
      } catch (err) {
        console.warn('[slack-webhook] gc tick failed', err);
      }
    });
  }, 5 * 60 * 1000);
}

export function stopSlackTurnGc(): void {
  if (gcTimer) clearInterval(gcTimer);
  gcTimer = null;
}
