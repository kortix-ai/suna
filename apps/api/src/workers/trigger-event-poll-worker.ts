/**
 * Kortix-polled app events (projects/trigger-events/mcp-poll.ts): every replica
 * claims due poll streams; SKIP LOCKED spreads them. A full batch means more
 * are due, so the next tick runs at once; else after IDLE_MS.
 */
import { config } from '../config';
import { logger } from '../lib/logger';
import { loadEventPoller, runDueEventPolls } from '../projects/surface';
import { runWorkerTick } from '../shared/audit-scope';

const IDLE_MS = 5_000;
const BATCH = 8;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;

async function tick(): Promise<void> {
  let delay = IDLE_MS;
  try {
    // Loaded even while switched off: the module registers the delivery queue, and
    // deliveries already queued still fire.
    await loadEventPoller();
    if (config.KORTIX_EVENT_POLLS_ENABLED !== false) {
      if ((await runWorkerTick('trigger-event-poll', () => runDueEventPolls())) >= BATCH) delay = 0;
    }
  } catch (error) {
    logger.error('[trigger-events/poll] tick failed', { error: String(error) });
  }
  if (!stopped) timer = setTimeout(tick, delay);
}

export function startTriggerEventPollWorker(): void {
  if (!stopped) return;
  stopped = false;
  timer = setTimeout(tick, IDLE_MS);
}

export function stopTriggerEventPollWorker(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
