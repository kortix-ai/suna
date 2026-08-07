import { appDeployments, appRuntimes, sandboxComputeSessions } from '@kortix/db';
import { and, eq, gte } from 'drizzle-orm';
import { calculateComputeCost } from '../billing/services/compute-metering';
import { type ProviderName } from '../platform/providers';
import { db } from '../shared/db';

export class AppBudgetExceededError extends Error {
  constructor(
    readonly appId: string,
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(`App monthly compute budget reached (${spentUsd.toFixed(4)} of ${budgetUsd.toFixed(2)} USD)`);
    this.name = 'AppBudgetExceededError';
  }
}

export async function appMonthlyComputeCost(appId: string, now = new Date()): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const rows = await db
    .select({
      costUsd: sandboxComputeSessions.costUsd,
      endedAtValue: sandboxComputeSessions.endedAt,
      lastBilledAt: sandboxComputeSessions.lastBilledAt,
      provider: sandboxComputeSessions.provider,
      cpuCores: sandboxComputeSessions.cpuCores,
      memoryGb: sandboxComputeSessions.memoryGb,
      diskGb: sandboxComputeSessions.diskGb,
    })
    .from(sandboxComputeSessions)
    .innerJoin(appRuntimes, eq(sandboxComputeSessions.appRuntimeId, appRuntimes.runtimeId))
    .innerJoin(appDeployments, eq(appRuntimes.deploymentId, appDeployments.deploymentId))
    .where(and(
      eq(appDeployments.appId, appId),
      gte(sandboxComputeSessions.startedAt, monthStart.toISOString()),
    ));
  let total = 0;
  for (const row of rows) {
    total += Number(row.costUsd || 0);
    if (!row.endedAtValue) {
      const unbilledSeconds = Math.max(0, (now.getTime() - new Date(row.lastBilledAt).getTime()) / 1000);
      total += calculateComputeCost({
        cpuCores: row.cpuCores,
        memoryGb: row.memoryGb,
        diskGb: row.diskGb,
        gpuCount: 0,
      }, unbilledSeconds, row.provider as ProviderName);
    }
  }
  return total;
}

export async function assertAppBudgetAvailable(
  appId: string,
  budgetUsd: number,
  now = new Date(),
): Promise<number> {
  const spent = await appMonthlyComputeCost(appId, now);
  if (spent >= budgetUsd) throw new AppBudgetExceededError(appId, spent, budgetUsd);
  return spent;
}
