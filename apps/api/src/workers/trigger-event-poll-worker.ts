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
let ticking = false;
let again = false;

async function tick(): Promise<void> {
  // One tick at a time: a check that ends during a tick asks for another one after it.
  if (ticking) {
    again = true;
    return;
  }
  ticking = true;
  timer = null;
  let delay = IDLE_MS;
  try {
    // Loaded even while switched off: the module registers the delivery queue, and
    // deliveries already queued still fire.
    await loadEventPoller();
    if (config.KORTIX_EVENT_POLLS_ENABLED !== false) {
      if ((await runWorkerTick('trigger-event-poll', () => runDueEventPolls(wake))) >= BATCH) delay = 0;
    }
  } catch (error) {
    logger.error('[trigger-events/poll] tick failed', { error: String(error) });
  }
  ticking = false;
  if (again) {
    again = false;
    delay = 0;
  }
  if (!stopped) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, delay);
  }
}

/** A check ended and freed its slot: claim into it now, not after the idle wait. */
function wake(): void {
  if (stopped) return;
  if (ticking) {
    again = true;
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(tick, 0);
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
