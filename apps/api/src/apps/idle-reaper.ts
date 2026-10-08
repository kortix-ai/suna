import { appDeploymentEvents, appDeployments, appRuntimes, apps } from '@kortix/db';
import { and, asc, desc, eq, gt, isNull, lt, lte, or } from 'drizzle-orm';
import { markComputeSessionAlive, pauseComputeSession } from '../billing/services/compute-metering';
import { type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
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
    return { candidates: rows.length, stopped, errors };
  } finally {
    running = false;
  }
}

const KEEP_ALIVE_EVERY_MS = 5 * 60_000;
const KEEP_ALIVE_CONCURRENCY = 8;
const KEEP_ALIVE_PAGE = 200;
/**
 * Supervisor refreshes queued per pass. A release with a new supervisor
 * rebuilds every always-on App, each a provider image build and a restart;
 * spread over passes, they never all land at once.
 */
export const KEEP_ALIVE_REFRESHES_PER_PASS = 5;
// replica-local: the reaper runs only on the leader, so one replica holds the
// last pass time; a leadership change runs one pass early, which is harmless.
let lastKeepAliveAt = 0;
let keepAliveRunning = false;

type RuntimeRow = typeof appRuntimes.$inferSelect;
type AppRow = typeof apps.$inferSelect;

export interface AppKeepAliveResult {
  budgetStopped: number;
  unfundedStopped: number;
  started: number;
  refreshed: number;
  refreshDeferred: number;
  confirmed: number;
  /** Rows that said running while the provider said otherwise. */
  lost: number;
}

/**
 * The always-on lifecycle, every 5 minutes. It runs beside the idle reaper,
 * not inside it, so a slow start never holds up idle stops.
 *   1. Cost: a running App (either mode) is stopped when its account can no
 *      longer pay (the same check session create runs) or when its
 *      month-to-date compute reached `monthly_budget_usd`. An App that never
 *      sleeps never passes the wake gate again, so the check runs here.
 *   2. Refresh: an always-on App never cold-starts, so its stale supervisor
 *      (or its static App still on a sandbox) is queued for the rebuild a cold
 *      start would queue, at most `KEEP_ALIVE_REFRESHES_PER_PASS` per pass.
 *   3. Keep running: the provider is asked about every always-on runtime the
 *      database records as running. Running: compute liveness is stamped, so
 *      billing continues without inbound traffic, and on Daytona and E2B the
 *      provider's idle timer is renewed. Not running: the row is corrected and
 *      the App is started through the wake gate (entitlement, concurrency,
 *      budget), like an App whose row already said stopped.
 */
export async function runAppKeepAlive(now = new Date(), force = false): Promise<AppKeepAliveResult | null> {
  if (keepAliveRunning) return null;
  if (!force && now.getTime() - lastKeepAliveAt < KEEP_ALIVE_EVERY_MS) return null;
  lastKeepAliveAt = now.getTime();
  keepAliveRunning = true;
  try {
    const hosting = new AppHostingProvider();
    const cost = await stopUnaffordableRuntimes(hosting, now);
    const alwaysOn = await keepAlwaysOnAppsRunning(hosting, now);
    return { ...cost, ...alwaysOn };
  } finally {
    keepAliveRunning = false;
  }
}

/** Every row of a query, in pages ordered by a unique id, so none is skipped. */
async function forEachPage<T>(
  load: (after: string | null) => Promise<T[]>,
  idOf: (row: T) => string,
  visit: (rows: T[]) => Promise<void>,
): Promise<void> {
  let after: string | null = null;
  for (;;) {
    const rows = await load(after);
    if (rows.length > 0) await visit(rows);
    if (rows.length < KEEP_ALIVE_PAGE) return;
    after = idOf(rows[rows.length - 1]!);
  }
}

async function stopUnaffordableRuntimes(hosting: AppHostingProvider, now: Date) {
  const { assertAppBudgetAvailable, AppBudgetExceededError } = await import('./budget');
  const { assertAppAccountFunded, AppAccountUnfundedError } = await import('./limits');
  // One entitlement check per account per pass, however many Apps it runs.
  const funding = new Map<string, Promise<string | null>>();
  const unfunded = (accountId: string) => {
    let verdict = funding.get(accountId);
    if (!verdict) {
      verdict = assertAppAccountFunded(accountId).then(
        () => null,
        (error) => (error instanceof AppAccountUnfundedError ? error.message : null),
      );
      funding.set(accountId, verdict);
    }
    return verdict;
  };
  let budgetStopped = 0;
  let unfundedStopped = 0;
  await forEachPage(
    (after) => db
      .select({ runtime: appRuntimes, app: apps })
      .from(appRuntimes)
      .innerJoin(appDeployments, eq(appRuntimes.deploymentId, appDeployments.deploymentId))
      .innerJoin(apps, eq(appDeployments.appId, apps.appId))
      .where(and(
        eq(appRuntimes.status, 'running'),
        isNull(apps.deletedAt),
        after ? gt(appRuntimes.runtimeId, after) : undefined,
      ))
      .orderBy(asc(appRuntimes.runtimeId))
      .limit(KEEP_ALIVE_PAGE),
    (row) => row.runtime.runtimeId,
    (rows) => mapWithConcurrency(rows, KEEP_ALIVE_CONCURRENCY, async ({ runtime, app }) => {
      try {
        const unfundedReason = await unfunded(app.accountId);
        if (unfundedReason) {
          await stopForCost(hosting, runtime, 'app_stopped_unfunded', `Stopped: ${unfundedReason}`);
          unfundedStopped += 1;
          logger.warn('[apps] App stopped: its account cannot pay for compute', { appId: app.appId });
          return;
        }
        await assertAppBudgetAvailable(app.appId, Number(app.monthlyBudgetUsd), now);
      } catch (error) {
        if (!(error instanceof AppBudgetExceededError)) {
          logger.error('[apps] cost check failed', { appId: app.appId, error: String(error) });
          return;
        }
        try {
          await stopForCost(hosting, runtime, 'app_stopped_budget', `Stopped: ${error.message}`);
          budgetStopped += 1;
          logger.warn('[apps] App stopped at its monthly budget', { appId: app.appId, budgetUsd: app.monthlyBudgetUsd });
        } catch (stopError) {
          logger.error('[apps] budget stop failed', { appId: app.appId, error: String(stopError) });
        }
      }
    }).then(() => undefined),
  );
  return { budgetStopped, unfundedStopped };
}

async function stopForCost(hosting: AppHostingProvider, runtime: RuntimeRow, type: string, message: string) {
  await hosting.stop(runtime.provider as SandboxProviderName, runtime.externalId);
  const stoppedAt = new Date();
  await db.update(appRuntimes).set({
    status: 'stopped', stoppedAt, activityLeaseUntil: null, idleDeadlineAt: null, updatedAt: stoppedAt,
  }).where(eq(appRuntimes.runtimeId, runtime.runtimeId));
  await pauseComputeSession(runtime.runtimeId, stoppedAt);
  await db.insert(appDeploymentEvents).values({
    deploymentId: runtime.deploymentId, runtimeId: runtime.runtimeId, level: 'warn', type, message,
  });
}

async function keepAlwaysOnAppsRunning(hosting: AppHostingProvider, now: Date) {
  const { ensureAppRuntimeRunning } = await import('./public-proxy-runtime');
  const { enqueueCurrentAppRuntime } = await import('./deployment-worker');
  let started = 0;
  let refreshed = 0;
  let refreshDeferred = 0;
  let confirmed = 0;
  let lost = 0;

  const keepRunning = async (app: AppRow, deployment: typeof appDeployments.$inferSelect) => {
    let [runtime] = await db.select().from(appRuntimes)
      .where(eq(appRuntimes.deploymentId, deployment.deploymentId))
      .orderBy(desc(appRuntimes.createdAt))
      .limit(1);
    if (!runtime) return;
    const provider = runtime.provider as SandboxProviderName;
    if (runtime.status === 'running') {
      const status = await hosting.providerStatus(provider, runtime.externalId);
      if (status === 'unknown') return; // the provider did not answer; the next pass asks again
      if (status === 'running') {
        await markComputeSessionAlive(runtime.runtimeId, now);
        // Platinum runs an always-on App as a persistent VM. Daytona and E2B
        // keep their idle backstop; renewing it here keeps the VM up.
        if (provider !== 'platinum') {
          await hosting.renewLifecycle(provider, runtime.externalId).catch((error) =>
            logger.warn('[apps] always-on lifecycle renewal failed', { appId: app.appId, error: String(error) }));
        }
        confirmed += 1;
        return;
      }
      // The row says running; the provider says it is not. Record the truth,
      // close the compute window, then start it through the wake gate.
      const stoppedAt = new Date();
      const [corrected] = await db.update(appRuntimes).set({
        status: 'stopped', stoppedAt, activityLeaseUntil: null, idleDeadlineAt: null, updatedAt: stoppedAt,
      }).where(and(eq(appRuntimes.runtimeId, runtime.runtimeId), eq(appRuntimes.status, 'running'))).returning();
      if (!corrected) return;
      await pauseComputeSession(runtime.runtimeId, stoppedAt);
      runtime = corrected;
      lost += 1;
    }
    if (runtime.status !== 'stopped') return;
    await ensureAppRuntimeRunning({ app, deployment, runtime }, hosting);
    started += 1;
  };

  await forEachPage(
    (after) => db
      .select({ app: apps, deployment: appDeployments })
      .from(apps)
      .innerJoin(appDeployments, eq(appDeployments.deploymentId, apps.activeDeploymentId))
      .where(and(
        eq(apps.alwaysOn, true),
        eq(apps.desiredState, 'running'),
        isNull(apps.deletedAt),
        eq(appDeployments.status, 'ready'),
        eq(appDeployments.hostingType, 'sandbox'),
        after ? gt(apps.appId, after) : undefined,
      ))
      .orderBy(asc(apps.appId))
      .limit(KEEP_ALIVE_PAGE),
    (row) => row.app.appId,
    async (rows) => {
      for (const { app, deployment } of rows) {
        if (refreshed >= KEEP_ALIVE_REFRESHES_PER_PASS) {
          refreshDeferred += 1;
          continue;
        }
        if (await enqueueCurrentAppRuntime(app, deployment, now).catch(() => false)) refreshed += 1;
      }
      await mapWithConcurrency(rows, KEEP_ALIVE_CONCURRENCY, async ({ app, deployment }) => {
        try {
          await keepRunning(app, deployment);
        } catch (error) {
          // Over budget, unfunded, at the account's App cap, or a provider
          // failure: it stays stopped and the next pass tries again.
          logger.warn('[apps] always-on App could not be kept running', {
            appId: app.appId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    },
  );
  if (refreshDeferred > 0) logger.info('[apps] keep-alive deferred runtime refreshes', { refreshed, refreshDeferred });
  return { started, refreshed, refreshDeferred, confirmed, lost };
}
