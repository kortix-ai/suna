import { syncResidentialProxyCharges } from '../../billing/services/residential-proxy-charges';
import { config } from '../../config';
import { runWorkerTick } from '../../shared/audit-scope';
import { leaderTimer } from '../../shared/leader-timer';

const INTERVAL_MS = 5 * 60_000;

// Leader only, serial: every 5 minutes, debit the residential proxy charges
// Platinum published since the last tick (billing/services/residential-proxy-charges.ts).
const worker = leaderTimer(async () => {
  await runWorkerTick('residential-proxy-billing', () => syncResidentialProxyCharges());
  return INTERVAL_MS;
}, { name: 'residential-proxy-billing' });

/** Runs only where Kortix charges for usage and the operator turned the residential proxy on. */
export function startResidentialProxyBillingWorker(): void {
  if (!config.KORTIX_BILLING_INTERNAL_ENABLED || !config.PLATINUM_API_KEY || !config.KORTIX_PLATINUM_RESIDENTIAL_PROXY) return;
  worker.start();
}

export const stopResidentialProxyBillingWorker = worker.stop;
