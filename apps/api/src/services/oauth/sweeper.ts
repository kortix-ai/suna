// Hourly housekeeping for the OAuth tables: expired authorization requests and
// abandoned self-registered clients (B-9). Both deletes are bounded, idempotent
// and safe when several API tasks run them: a row a peer already deleted is not
// matched. Recursive setTimeout keeps ticks serial per process.

import { runWorkerTick } from '../audit/audit-scope';
import { sweepAbandonedSelfRegisteredClients, sweepExpiredAuthorizationRequests } from './requests';

const TICK_MS = 60 * 60_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

export async function runOAuthSweepOnce(): Promise<{ requests: number; clients: number }> {
  return { requests: await sweepExpiredAuthorizationRequests(), clients: await sweepAbandonedSelfRegisteredClients() };
}

async function tickAndRearm(): Promise<void> {
  try {
    const swept = await runWorkerTick('oauth-sweep', runOAuthSweepOnce);
    if (swept && (swept.requests || swept.clients)) console.info('[oauth sweep] deleted', swept);
  } catch (err) {
    console.error('[oauth sweep] tick failed', err);
  }
  if (!stopped) timer = setTimeout(tickAndRearm, TICK_MS);
}

export function startOAuthSweeper(): void {
  if (timer) return;
  stopped = false;
  void tickAndRearm();
}

export function stopOAuthSweeper(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
}
