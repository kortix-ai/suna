import { appDeployments, appRuntimes, apps } from '@kortix/db';
import { and, desc, eq, isNull, lt, lte, or } from 'drizzle-orm';
import { pauseComputeSession } from '../billing/services/compute-metering';
import { type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { AppHostingProvider } from './hosting';

let running = false;

/**
 * A reaper that died between claiming a runtime (`stopping`) and finishing the
 * stop (a deploy, a leader flap) leaves the row `stopping`. Nothing reads that
 * state, so the box kept running and billing. Past this age the row is handed
 * back to `running`; the next selection stops it again, and `hosting.stop` is
 * idempotent.
 */
export const STALE_STOPPING_MS = 3 * 60_000;

export async function runAppIdleReaper(now = new Date()): Promise<{ candidates: number; stopped: number; errors: number }> {
  if (running) return { candidates: 0, stopped: 0, errors: 0 };
  running = true;
  try {
    await db
      .update(appRuntimes)
      .set({ status: 'running', updatedAt: now })
      .where(and(
        eq(appRuntimes.status, 'stopping'),
        lt(appRuntimes.updatedAt, new Date(now.getTime() - STALE_STOPPING_MS)),
      ));
    const rows = await db
      .select({ runtime: appRuntimes, app: apps })
      .from(appRuntimes)
      .innerJoin(appDeployments, eq(appRuntimes.deploymentId, appDeployments.deploymentId))
      .innerJoin(apps, eq(appDeployments.appId, apps.appId))
      .where(and(
        eq(appRuntimes.status, 'running'),
        lte(appRuntimes.idleDeadlineAt, now),
        or(isNull(appRuntimes.activityLeaseUntil), lt(appRuntimes.activityLeaseUntil, now)),
        eq(apps.desiredState, 'running'),
        // Always-on Apps never idle-stop; `runAppKeepAlive` owns their lifecycle.
        eq(apps.alwaysOn, false),
        isNull(apps.deletedAt),
      ))
      .limit(50);
    let stopped = 0;
    let errors = 0;
    const hosting = new AppHostingProvider();
    for (const { runtime } of rows) {
      try {
        const [claimed] = await db
          .update(appRuntimes)
          .set({ status: 'stopping', updatedAt: now })
          .where(and(
            eq(appRuntimes.runtimeId, runtime.runtimeId),
            eq(appRuntimes.status, 'running'),
            lte(appRuntimes.idleDeadlineAt, now),
            or(isNull(appRuntimes.activityLeaseUntil), lt(appRuntimes.activityLeaseUntil, now)),
          ))
          .returning();
        if (!claimed) continue;
        await hosting.stop(claimed.provider as SandboxProviderName, claimed.externalId);
        const stoppedAt = new Date();
        await db.update(appRuntimes).set({
          status: 'stopped',
          stoppedAt,
          activityLeaseUntil: null,
          updatedAt: stoppedAt,
        }).where(eq(appRuntimes.runtimeId, claimed.runtimeId));
        await pauseComputeSession(claimed.runtimeId, stoppedAt);
        stopped += 1;
      } catch (error) {
        errors += 1;
        await db.update(appRuntimes).set({ status: 'running', updatedAt: new Date() })
          .where(and(eq(appRuntimes.runtimeId, runtime.runtimeId), eq(appRuntimes.status, 'stopping')))
          .catch(() => {});
        logger.error('[apps] idle stop failed', {
          runtimeId: runtime.runtimeId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    const keepAlive = await runAppKeepAlive(now).catch((error) => {
      logger.error('[apps] keep-alive pass failed', { error: error instanceof Error ? error.message : String(error) });
      return null;
    });
    return { candidates: rows.length, stopped: stopped + (keepAlive?.budgetStopped ?? 0), errors };
  } finally {
    running = false;
  }
}

const KEEP_ALIVE_EVERY_MS = 5 * 60_000;
// replica-local: the reaper runs only on the leader, so one replica holds the
// last pass time; a leadership change runs one pass early, which is harmless.
let lastKeepAliveAt = 0;

/**
 * The always-on lifecycle, every 5 minutes:
 *   1. Budget: a running App (either mode) whose month-to-date compute reached
 *      `monthly_budget_usd` is stopped. Before always-on, the idle stop forced
 *      every App back through the budget check on its next wake; an App that
 *      never sleeps needs the check here.
 *   2. Keep running: an always-on App whose runtime stopped (a crash, the
 *      provider's backstop, a budget raised again) is started, through the
 *      same entitlement, concurrency and budget checks as a wake.
 *   3. Refresh: an always-on App never cold-starts, so its stale supervisor
 *      (or its static App still on a sandbox) is queued for the same immutable
 *      rebuild a cold start would queue.
 */
export async function runAppKeepAlive(now = new Date(), force = false): Promise<{
  budgetStopped: number;
  started: number;
  refreshed: number;
} | null> {
  if (!force && now.getTime() - lastKeepAliveAt < KEEP_ALIVE_EVERY_MS) return null;
  lastKeepAliveAt = now.getTime();
  const { assertAppBudgetAvailable, AppBudgetExceededError } = await import('./budget');
  const { ensureAppRuntimeRunning } = await import('./public-proxy-runtime');
  const { enqueueCurrentAppRuntime } = await import('./deployment-worker');
  const hosting = new AppHostingProvider();
  let budgetStopped = 0;
  let started = 0;
  let refreshed = 0;

  const running = await db
    .select({ runtime: appRuntimes, app: apps })
    .from(appRuntimes)
    .innerJoin(appDeployments, eq(appRuntimes.deploymentId, appDeployments.deploymentId))
    .innerJoin(apps, eq(appDeployments.appId, apps.appId))
    .where(and(eq(appRuntimes.status, 'running'), isNull(apps.deletedAt)))
    .limit(200);
  for (const { runtime, app } of running) {
    try {
      await assertAppBudgetAvailable(app.appId, Number(app.monthlyBudgetUsd), now);
    } catch (error) {
      if (!(error instanceof AppBudgetExceededError)) continue;
      try {
        await hosting.stop(runtime.provider as SandboxProviderName, runtime.externalId);
        const stoppedAt = new Date();
        await db.update(appRuntimes).set({
          status: 'stopped', stoppedAt, activityLeaseUntil: null, idleDeadlineAt: null, updatedAt: stoppedAt,
        }).where(eq(appRuntimes.runtimeId, runtime.runtimeId));
        await pauseComputeSession(runtime.runtimeId, stoppedAt);
        budgetStopped += 1;
        logger.warn('[apps] App stopped at its monthly budget', { appId: app.appId, budgetUsd: app.monthlyBudgetUsd });
      } catch (stopError) {
        logger.error('[apps] budget stop failed', { appId: app.appId, error: String(stopError) });
      }
    }
  }

  const alwaysOn = await db
    .select({ app: apps, deployment: appDeployments })
    .from(apps)
    .innerJoin(appDeployments, eq(appDeployments.deploymentId, apps.activeDeploymentId))
    .where(and(
      eq(apps.alwaysOn, true),
      eq(apps.desiredState, 'running'),
      isNull(apps.deletedAt),
      eq(appDeployments.status, 'ready'),
      eq(appDeployments.hostingType, 'sandbox'),
    ))
    .limit(100);
  for (const { app, deployment } of alwaysOn) {
    if (await enqueueCurrentAppRuntime(app, deployment).catch(() => false)) refreshed += 1;
    const [runtime] = await db.select().from(appRuntimes)
      .where(eq(appRuntimes.deploymentId, deployment.deploymentId))
      .orderBy(desc(appRuntimes.createdAt))
      .limit(1);
    if (!runtime || runtime.status !== 'stopped') continue;
    try {
      await ensureAppRuntimeRunning({ app, deployment, runtime }, hosting);
      started += 1;
    } catch (error) {
      // Over budget, unfunded or at the account's App cap: it stays stopped
      // until that changes, and the next pass tries again.
      logger.warn('[apps] always-on App could not start', {
        appId: app.appId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { budgetStopped, started, refreshed };
}

export { startAppIdleReaper, stopAppIdleReaper } from '../workers/app-idle-reaper-worker';
