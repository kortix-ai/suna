import { calculateComputeCost } from '../billing/services/compute-metering';
import type { ProviderName } from '../platform/providers';

/** A month of wall clock: 730 hours, the figure cloud price lists use. */
const MONTH_SECONDS = 730 * 3600;

interface AppMachine {
  cpuCores: number;
  memoryGb: number;
  diskGb: number;
}

/**
 * What this machine costs running 24/7 for one month at list compute rates:
 * the reserved spec times wall clock, exactly as compute metering bills it.
 * A static App runs no machine and costs nothing.
 */
export function appMonthlyEstimateUsd(machine: AppMachine, provider?: ProviderName): number {
  const cost = calculateComputeCost({ ...machine, gpuCount: 0 }, MONTH_SECONDS, provider);
  return Math.round(cost * 100) / 100;
}
