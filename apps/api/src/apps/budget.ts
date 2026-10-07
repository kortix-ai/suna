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

/**
 * The budget an App gets when nobody sets one. An always-on App gets its 24/7
 * estimate rounded up to a whole dollar, so it does not stop mid-month on its
 * own default. An on-demand App gets the flat default.
 */
export function defaultAppBudgetUsd(
  app: AppMachine & { alwaysOn: boolean },
  provider?: ProviderName,
  max = maxAppMonthlyBudgetUsd(),
): number {
  if (!app.alwaysOn) return DEFAULT_APP_MONTHLY_BUDGET_USD;
  return Math.min(Math.ceil(appMonthlyEstimateUsd(app, provider)), max);
}

export const MAX_APP_MONTHLY_BUDGET_USD = 100_000;

/** The highest monthly budget an App may have: the operator's `KORTIX_APPS_MAX_MONTHLY_BUDGET_USD`, default 100,000. */
export function maxAppMonthlyBudgetUsd(): number {
  return config.KORTIX_APPS_MAX_MONTHLY_BUDGET_USD;
}

export interface AppBudgetWarning {
  code: 'app_budget_below_always_on';
  message: string;
  estimated_monthly_usd: number;
  monthly_budget_usd: number;
}

/**
 * An always-on App whose monthly budget is below what its machine costs for a
 * month stops at the budget and stays stopped until the month ends. Create,
 * update and deploy report it; none of them refuses it.
 */
export function alwaysOnBudgetWarning(
  app: AppMachine & { alwaysOn: boolean; monthlyBudgetUsd: string | number },
  provider?: ProviderName,
): AppBudgetWarning | null {
  if (!app.alwaysOn) return null;
  const estimate = appMonthlyEstimateUsd(app, provider);
  const budget = Number(app.monthlyBudgetUsd);
  if (budget >= estimate) return null;
  const days = estimate > 0 ? (budget / estimate) * 30.4 : 0;
  return {
    code: 'app_budget_below_always_on',
    message:
      `This App runs 24/7, which costs about $${estimate.toFixed(2)} a month at list compute rates, ` +
      `but its monthly budget is $${budget.toFixed(2)}. A server App stops at the budget ` +
      `(after about ${days.toFixed(1)} days) until the next month. Raise the budget or run it on demand. ` +
      'A static App runs no server and is not affected.',
    estimated_monthly_usd: estimate,
    monthly_budget_usd: budget,
  };
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
