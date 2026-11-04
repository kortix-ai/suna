import { processSalesOutbox } from '../../accounts/sales-outbox';
import { logger } from '../../lib/logger';
import { runWorkerTick } from '../../shared/audit-scope';

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let active: Promise<void> | null = null;

function schedule(delay: number): void {
  timer = setTimeout(() => {
    timer = null;
    active = runWorkerTick('sales-outbox', () => processSalesOutbox())
      .catch(() => logger.error('[sales-outbox] delivery tick failed'))
      .then(() => { if (!stopped) schedule(30_000); });
  }, delay);
}
export function startSalesOutbox(): void {
  if (!stopped) return;
  stopped = false;
  schedule(0);
}
export async function stopSalesOutbox(): Promise<void> {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  await active;
}
