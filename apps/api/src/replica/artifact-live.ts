/**
 * Live presence on Artifacts (KRTX-3669): every serving process holds its own
 * Artifact sockets, so every serving process sweeps its own rooms. Each tick
 * closes sockets silent for 45 s, drops other processes' participants that
 * stopped refreshing, lets idle agents leave, re-sends local participants
 * before other processes would expire them, and runs the 60 s access
 * re-checks that are due. No rooms: the tick does nothing.
 */
import { artifactLiveRoomCount, sweepArtifactLive } from '../artifacts/live-hub';
import { logger } from '../lib/logger';
import { runWorkerTick } from '../shared/audit-scope';

const TICK_MS = 5_000;
let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking || artifactLiveRoomCount() === 0) return;
  ticking = true;
  try {
    await runWorkerTick('artifact-live', sweepArtifactLive);
  } catch (error) {
    logger.error('[artifact-live] sweep failed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    ticking = false;
  }
}

export function startArtifactLiveSweep(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  (timer as unknown as { unref?: () => void }).unref?.();
}

export function stopArtifactLiveSweep(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
