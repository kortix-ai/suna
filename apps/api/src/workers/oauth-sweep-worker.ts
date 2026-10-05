// Recursive setTimeout keeps the hourly OAuth sweep ticks serial per process.

import { runOAuthSweepOnce } from '../oauth/sweeper';
import { runWorkerTick } from '../shared/audit-scope';

const TICK_MS = 60 * 60_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

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
