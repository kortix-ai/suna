// Recursive setTimeout keeps the daily audit archive ticks serial per process.
import { config } from '../lib/config';
import { runWorkerTick } from '../services/audit/audit-scope';
import { runAuditArchiveOnce } from '../services/audit/audit-archive/worker';

const TICK_MS = 24 * 3_600_000;
const FIRST_TICK_MS = 10 * 60_000;

async function tickAndRearm(): Promise<void> {
  try {
    const outcome = await runWorkerTick('audit-archive', runAuditArchiveOnce);
    if (outcome?.ran) console.info('[audit archive] pass finished', outcome);
    else if (outcome && config.AUDIT_ARCHIVE_ENABLED) console.warn('[audit archive] skipped:', outcome.reason);
  } catch (err) {
    console.error('[audit archive] pass failed', err);
  }
  if (!stopped) timer = setTimeout(tickAndRearm, TICK_MS);
}

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export function startAuditArchiveWorker(): void {
  if (timer) return;
  stopped = false;
  timer = setTimeout(tickAndRearm, FIRST_TICK_MS);
}

export function stopAuditArchiveWorker(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
