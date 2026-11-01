import { syncStorageCharges } from '../../billing/services/storage-charges';
import { config } from '../../config';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const INTERVAL_MS = 60 * 60_000;

// Leader only, serial: every hour, charge the volume storage Platinum metered
// for every ended UTC day still open (billing/services/storage-charges.ts).
const worker = leaderTimer(async () => {
  await runWorkerTick('storage-billing', () => syncStorageCharges());
  return INTERVAL_MS;
}, { name: 'storage-billing', firstDelayMs: 2 * 60_000 });

/** Runs only where Kortix charges for usage and Platinum hosts the volumes. */
export function startStorageBillingWorker(): void {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED || !config.PLATINUM_API_KEY) return;
  worker.start();
}

export const stopStorageBillingWorker = worker.stop;
