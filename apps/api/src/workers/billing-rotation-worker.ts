import {
  runFreeTierCreditRotation,
  runTrialExpirySweep,
  runYearlyCreditRotation,
} from '../billing/rotation-schedule';
import { config } from '../config';
import { runWorkerTick } from '../shared/audit-scope';
import { logger } from '../lib/logger';

// The hourly billing sweeps. bootstrap.ts starts them with the other singleton
// workers, so they run on the elected leader only, not on every replica.
const HOUR_MS = 60 * 60 * 1000;
let timers: ReturnType<typeof setInterval>[] = [];

function hourly(name: string, tick: () => Promise<unknown>): ReturnType<typeof setInterval> {
  return setInterval(() => {
    tick().catch((err) => logger.error('[BillingApp] sweep tick failed', { sweep: name, error: err instanceof Error ? err.message : String(err) }));
  }, HOUR_MS);
}

export function startBillingRotation(): void {
  if (timers.length || !config.KORTIX_BILLING_INTERNAL_ENABLED) return;
  timers = [
    hourly('trial expiry', () => runWorkerTick('billing-trial-expiry', runTrialExpirySweep)),
    hourly('yearly rotation', () => runWorkerTick('billing-yearly-rotation', runYearlyCreditRotation)),
    hourly('free-tier rotation', () => runWorkerTick('billing-free-tier-rotation', runFreeTierCreditRotation)),
  ];
}

export function stopBillingRotation(): void {
  for (const timer of timers) clearInterval(timer);
  timers = [];
}
