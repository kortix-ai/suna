import { runWorkerTick } from '../services/audit/audit-scope';
import { sweepStaleTeamsTurns } from '../services/channels';

let gcTimer: ReturnType<typeof setInterval> | null = null;

/** Leader-only (bootstrap.ts): one replica sweeps, not all of them. */
export function startTeamsTurnGc(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    runWorkerTick('teams-turn-gc', sweepStaleTeamsTurns).catch((err) => console.warn('[teams-webhook] gc tick failed', err));
  }, 5 * 60 * 1000);
}

export function stopTeamsTurnGc(): void {
  if (gcTimer) clearInterval(gcTimer);
  gcTimer = null;
}
