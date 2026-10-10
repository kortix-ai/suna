/**
 * Kortix Capture's leader-only loops (capture/workers.ts holds the ticks):
 *   capture-index-reader   every KORTIX_CAPTURE_INDEX_POLL_SECONDS: each active device's index and status
 *   capture-maintenance    every 5 min: close quiet ranges, partitions, retention, prune grants and jobs
 *   capture-events-reader  only with KORTIX_CAPTURE_SQS_QUEUE_URL: long-polls the bucket's manifest events
 * A failing tick waits at least 30 s, so a missing permission or a store outage never spins.
 */
import { config } from '../config';
import { logger } from '../lib/logger';
import { captureMaintenance, pollAllDevices, receiveEvents } from '../capture/workers';
import { runWorkerTick } from '../shared/audit-scope';

const loops: Array<{ stop: () => void }> = [];

function loop(name: string, everyMs: () => number, tick: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const run = async () => {
    let delay = everyMs();
    try {
      await tick();
    } catch (error) {
      delay = Math.max(delay, 30_000);
      logger.error(`[capture] ${name} tick failed`, { error: String(error) });
    }
    if (!stopped) timer = setTimeout(run, delay);
  };
  timer = setTimeout(run, 1_000);
  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

export function startCaptureWorkers(): void {
  if (loops.length) return;
  loops.push(loop('capture-index-reader', () => config.KORTIX_CAPTURE_INDEX_POLL_SECONDS * 1000, () => runWorkerTick('capture-index-reader', pollAllDevices)));
  loops.push(loop('capture-maintenance', () => 5 * 60_000, () => runWorkerTick('capture-maintenance', captureMaintenance)));
  // Long polling waits up to 20 s inside the call; the loop re-arms at once.
  if ((config.KORTIX_CAPTURE_SQS_QUEUE_URL ?? '').trim()) {
    loops.push(loop('capture-events-reader', () => 0, () => runWorkerTick('capture-events-reader', receiveEvents)));
  }
}

export function stopCaptureWorkers(): void {
  for (const l of loops.splice(0)) l.stop();
}
