import { appDeployments, appRuntimes, sandboxComputeSessions } from '@kortix/db';
import { and, eq, gte } from 'drizzle-orm';
import { monthStartUtc, monthlyComputeColumns, sumMonthlyComputeCost } from '../billing/services/compute-accrual';
import { calculateComputeCost } from '../billing/services/compute-metering';
import type { ProviderName } from '../platform/providers';
import { config } from '../config';
import { db } from '../shared/db';

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

/** Monthly budget of an on-demand App when nobody sets one. */
export const DEFAULT_APP_MONTHLY_BUDGET_USD = 5;

export const MAX_APP_MONTHLY_BUDGET_USD = 100_000;

/** The highest monthly budget an App may have: the operator's `KORTIX_APPS_MAX_MONTHLY_BUDGET_USD`, default 100,000. */
export function maxAppMonthlyBudgetUsd(): number {
  return config.KORTIX_APPS_MAX_MONTHLY_BUDGET_USD;
}

/**
 * Cost shape decides whether an App has a monthly budget. Only an on-demand
 * server App does: its cost follows its traffic, so the budget is the control
 * and the App stops at it. An always-on server App and every `convex` App run
 * a fixed machine 24/7: the cost is the size (`estimated_monthly_usd`), and a
 * budget could only take the App down. A static App runs no machine.
 */
export function appHasBudget(app: { kind: string; alwaysOn: boolean }, hostingType: string | null = null): boolean {
  return app.kind === 'web' && !app.alwaysOn && hostingType !== 'static';
}

/** Why `monthly_budget_usd` does not apply to this App, or null when it does. */
export function appBudgetNotApplicable(
  app: AppMachine & { kind: string; alwaysOn: boolean },
  hostingType: string | null,
  provider?: ProviderName,
): string | null {
  if (appHasBudget(app, hostingType)) return null;
  if (hostingType === 'static' && app.kind === 'web') {
    return 'A static App runs no machine, so it has no monthly budget.';
  }
  const cost = `about $${appMonthlyEstimateUsd(app, provider).toFixed(2)} a month`;
  if (app.kind === 'convex') {
    return `A convex App has no monthly budget: its machine runs 24/7 at a fixed cost (${cost}). Resize it to change the cost.`;
  }
  return `An always-on App has no monthly budget: it runs 24/7 at a fixed cost (${cost}). ` +
    'Run it on demand (always_on: false) to cap its cost with a budget.';
}

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
