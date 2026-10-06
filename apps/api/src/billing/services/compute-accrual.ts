/**
 * The monthly unbilled-compute accrual, one copy for both readers
 * (`monitorMonthlyComputeCost`, `appMonthlyComputeCost`). A caller selects
 * `monthlyComputeColumns` over its own join and month filter; this module
 * sums the recorded cost and accrues each still-open window up to `now`.
 */
import { sandboxComputeSessions } from '@kortix/db';
import type { ProviderName } from '../../platform/providers';
import { calculateComputeCost } from './compute-metering';

/** The select list of the monthly accrual, shared by both readers. */
export const monthlyComputeColumns = {
  costUsd: sandboxComputeSessions.costUsd,
  endedAtValue: sandboxComputeSessions.endedAt,
  lastBilledAt: sandboxComputeSessions.lastBilledAt,
  provider: sandboxComputeSessions.provider,
  cpuCores: sandboxComputeSessions.cpuCores,
  memoryGb: sandboxComputeSessions.memoryGb,
  diskGb: sandboxComputeSessions.diskGb,
} as const;

/** One row of the accrual, as `monthlyComputeColumns` selects it. */
export type MonthlyComputeRow = {
  costUsd: string;
  endedAtValue: string | null;
  lastBilledAt: string;
  provider: string;
  cpuCores: number;
  memoryGb: number;
  diskGb: number;
};

/** The first instant of `now`'s calendar month, UTC. */
export function monthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Recorded cost of the rows plus each open window's unbilled accrual. */
export function sumMonthlyComputeCost(rows: readonly MonthlyComputeRow[], now: Date): number {
  let total = 0;
  for (const row of rows) {
    total += Number(row.costUsd || 0);
    if (!row.endedAtValue) {
      const unbilledSeconds = Math.max(
        0,
        (now.getTime() - new Date(row.lastBilledAt).getTime()) / 1000,
      );
      total += calculateComputeCost(
        {
          cpuCores: row.cpuCores,
          memoryGb: row.memoryGb,
          diskGb: row.diskGb,
          gpuCount: 0,
        },
        unbilledSeconds,
        row.provider as ProviderName,
      );
    }
  }
  return total;
}
