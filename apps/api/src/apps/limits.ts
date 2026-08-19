/**
 * App resource policy — the controls an App answers to before it may consume
 * provider compute.
 *
 * An App runtime is a sandbox. It burns the same CPU, memory and disk a session
 * burns, on the same providers, against the same wallet. Until this module the
 * only control was the per-App monthly budget: `POST /projects/:id/apps`
 * accepted 64 CPU / 512 GB RAM / 2 TB disk with no clamp, no account
 * entitlement was consulted on deploy or wake, and nothing bounded how many
 * Apps an account could create or run at once.
 *
 * The four controls here mirror what sessions already enforce:
 *   1. machine spec  — the same SANDBOX_SPEC_LIMITS ceiling a session snapshot
 *      gets (projects/lib clamps; Apps reject, because an App that silently
 *      receives less than it asked for is still billed for what it asked for);
 *   2. account entitlement — checkBillingActive, exactly as session create;
 *   3. App count      — a per-account cap, like maxProjectsForAccount;
 *   4. concurrency    — running App runtimes, like the concurrent-session cap.
 *
 * Every cap lifts entirely when billing is off, so a local or self-hosted
 * deployment is never gated by a plan it does not have.
 */
import { appDeployments, appRuntimes, apps } from '@kortix/db';
import { and, count, eq, inArray, isNull } from 'drizzle-orm';
import { config } from '../config';
import { assertAppBudgetAvailable } from './budget';
import { checkBillingActive } from '../billing/services/billing-gate';
import { getTier } from '../billing/services/tiers';
import { resolveAccountTier } from '../shared/account-limits';
import { db } from '../shared/db';
import { SANDBOX_SPEC_LIMITS } from '../snapshots/dockerfile-layer';

/** An App machine may not exceed what a session sandbox may. */
export const APP_MACHINE_LIMITS = SANDBOX_SPEC_LIMITS;

/** Per-App monthly compute safety limit — the spec default, now bounded. */
export const DEFAULT_APP_MONTHLY_BUDGET_USD = 5;
export const MAX_APP_MONTHLY_BUDGET_USD = 100_000;

/** App runtime statuses that hold provider compute. */
const LIVE_APP_RUNTIME_STATUSES = ['provisioning', 'starting', 'running'] as const;

function billingEnabled(): boolean {
  return Boolean((config as unknown as { KORTIX_BILLING_INTERNAL_ENABLED?: boolean }).KORTIX_BILLING_INTERNAL_ENABLED);
}

function positiveIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

export class AppLimitError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 402 | 429,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AppLimitError';
  }
}

/* ─── 1. Machine spec ────────────────────────────────────────────────────── */

export interface AppMachineRequest {
  cpu?: number;
  memoryGb?: number;
  diskGb?: number;
}

/**
 * Reject a machine larger than a session sandbox may be. Sessions clamp, Apps
 * reject: an App records its requested spec and bills off that record, so a
 * silent downgrade would charge for CPU and memory the provider never gave.
 */
export function assertAppMachineWithinLimits(machine: AppMachineRequest): void {
  const checks: Array<[string, number | undefined, { min: number; max: number }]> = [
    ['cpu', machine.cpu, APP_MACHINE_LIMITS.cpu],
    ['memory_gb', machine.memoryGb, APP_MACHINE_LIMITS.memory],
    ['disk_gb', machine.diskGb, APP_MACHINE_LIMITS.disk],
  ];
  for (const [field, value, bounds] of checks) {
    if (value === undefined) continue;
    if (value < bounds.min || value > bounds.max) {
      throw new AppLimitError(
        'app_machine_out_of_range',
        `${field} must be between ${bounds.min} and ${bounds.max}`,
        400,
        { field, min: bounds.min, max: bounds.max, requested: value },
      );
    }
  }
}

export function assertAppBudgetWithinLimits(budgetUsd: number | undefined): void {
  if (budgetUsd === undefined) return;
  const max = positiveIntEnv('KORTIX_APPS_MAX_MONTHLY_BUDGET_USD') ?? MAX_APP_MONTHLY_BUDGET_USD;
  if (budgetUsd < 0 || budgetUsd > max) {
    throw new AppLimitError(
      'app_budget_out_of_range',
      `monthly_budget_usd must be between 0 and ${max}`,
      400,
      { max, requested: budgetUsd },
    );
  }
}

/* ─── 2. Account entitlement ─────────────────────────────────────────────── */

export class AppAccountUnfundedError extends Error {
  constructor(
    readonly accountId: string,
    message: string,
    readonly reason: string,
    readonly detail: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppAccountUnfundedError';
  }
}

/**
 * The account entitlement half of the wake gate the Apps spec describes
 * ("Wake checks the account entitlement and the App monthly budget"). Same
 * check session create runs, so an account that cannot start a session cannot
 * silently keep burning compute through an App instead.
 */
export async function assertAppAccountFunded(accountId: string): Promise<void> {
  const gate = await checkBillingActive(accountId);
  if (gate.ok) return;
  throw new AppAccountUnfundedError(accountId, gate.message, gate.reason, {
    balance: gate.balance,
    billing_model: gate.billingModel,
    has_subscription: gate.hasSubscription,
    billing_state: gate.billingState,
    account_id: accountId,
  });
}

/* ─── 3. App count ───────────────────────────────────────────────────────── */

/**
 * Apps an account may own. Deliberately NOT a new plan dimension: no plan in
 * PLAN_CATALOG prices Apps, so inventing a number here would be a pricing
 * decision wearing an engineering hat. The bound is the plan's existing
 * concurrent-workload allowance, which is a real, per-tier value — an account
 * may own as many Apps as it may run sessions. Uncapped when billing is off
 * (local / self-hosted) and for Enterprise; an operator can override it.
 *
 * If Apps ever get their own plan entitlement, this is the one place to read it.
 */
export async function maxAppsForAccount(accountId: string): Promise<number> {
  if (!billingEnabled()) return Number.MAX_SAFE_INTEGER;
  const override = positiveIntEnv('KORTIX_APPS_MAX_PER_ACCOUNT');
  if (override !== null) return override;
  const tier = (await resolveAccountTier(accountId)) ?? 'free';
  if (tier === 'enterprise') return Number.MAX_SAFE_INTEGER;
  return getTier(tier).concurrentSessionLimit;
}

export async function countAccountApps(accountId: string): Promise<number> {
  const [row] = await db
    .select({ value: count() })
    .from(apps)
    .where(and(eq(apps.accountId, accountId), isNull(apps.deletedAt)));
  return Number(row?.value ?? 0);
}

export async function assertAppQuotaAvailable(accountId: string): Promise<void> {
  const limit = await maxAppsForAccount(accountId);
  if (limit === Number.MAX_SAFE_INTEGER) return;
  const current = await countAccountApps(accountId);
  if (current < limit) return;
  throw new AppLimitError(
    'app_quota_exceeded',
    `This account has reached its App limit (${limit}). Delete an App or upgrade the plan.`,
    402,
    { limit, current },
  );
}

/* ─── The gate ───────────────────────────────────────────────────────────── */

/**
 * Everything an App must satisfy before it consumes provider compute, in the
 * order a support engineer wants to read them: can the account pay at all, does
 * it have a free slot, and has this App exhausted its own monthly budget.
 * Deploy and wake both run it — otherwise an unfunded account keeps burning
 * compute through an App after session create has already started refusing.
 */
export async function assertAppComputeAllowed(
  app: { appId: string; accountId: string; monthlyBudgetUsd: string | number },
  options: { excludeRuntimeId?: string } = {},
): Promise<void> {
  await assertAppAccountFunded(app.accountId);
  await assertAppConcurrencyAvailable(app.accountId, options.excludeRuntimeId);
  await assertAppBudgetAvailable(app.appId, Number(app.monthlyBudgetUsd));
}

/* ─── 4. Concurrency ─────────────────────────────────────────────────────── */

/**
 * Running App runtimes an account may hold at once. An App runtime occupies a
 * provider slot exactly as a session does, so the account's concurrent-session
 * allowance is the natural budget — Apps get their own counter so they can
 * never starve interactive sessions, and an operator can override it.
 */
export async function maxConcurrentAppRuntimes(accountId: string): Promise<number> {
  if (!billingEnabled()) return Number.MAX_SAFE_INTEGER;
  const override = positiveIntEnv('KORTIX_APPS_MAX_CONCURRENT_RUNTIMES');
  if (override !== null) return override;
  const tier = (await resolveAccountTier(accountId)) ?? 'free';
  return getTier(tier).concurrentSessionLimit;
}

export async function countLiveAppRuntimes(
  accountId: string,
  excludeRuntimeId?: string,
): Promise<number> {
  const rows = await db
    .select({ runtimeId: appRuntimes.runtimeId })
    .from(appRuntimes)
    .innerJoin(appDeployments, eq(appRuntimes.deploymentId, appDeployments.deploymentId))
    .innerJoin(apps, eq(appDeployments.appId, apps.appId))
    .where(and(
      eq(appRuntimes.accountId, accountId),
      inArray(appRuntimes.status, [...LIVE_APP_RUNTIME_STATUSES]),
      isNull(apps.deletedAt),
    ));
  return rows.filter((row) => row.runtimeId !== excludeRuntimeId).length;
}

/**
 * Guard a wake or a new runtime. `excludeRuntimeId` is the runtime being woken:
 * it is already counted in its own live row on a re-wake, and counting it
 * against the cap would make an account at exactly the limit unable to wake the
 * very App it already owns.
 */
export async function assertAppConcurrencyAvailable(
  accountId: string,
  excludeRuntimeId?: string,
): Promise<void> {
  const limit = await maxConcurrentAppRuntimes(accountId);
  if (limit === Number.MAX_SAFE_INTEGER) return;
  const running = await countLiveAppRuntimes(accountId, excludeRuntimeId);
  if (running < limit) return;
  throw new AppLimitError(
    'app_concurrency_limit',
    `This account already runs its maximum number of Apps (${limit}). Stop an App or upgrade the plan.`,
    429,
    { limit, running },
  );
}
