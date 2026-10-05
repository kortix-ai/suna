import { appDeployments, appRuntimes, sandboxComputeSessions } from '@kortix/db';
import { and, eq, gte } from 'drizzle-orm';
import { monthStartUtc, monthlyComputeColumns, sumMonthlyComputeCost } from '../billing/services/compute-accrual';
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
  const rows = await db
    .select(monthlyComputeColumns)
    .from(sandboxComputeSessions)
    .innerJoin(appRuntimes, eq(sandboxComputeSessions.appRuntimeId, appRuntimes.runtimeId))
    .innerJoin(appDeployments, eq(appRuntimes.deploymentId, appDeployments.deploymentId))
    .where(and(
      eq(appDeployments.appId, appId),
      gte(sandboxComputeSessions.startedAt, monthStartUtc(now).toISOString()),
    ));
  return sumMonthlyComputeCost(rows, now);
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
