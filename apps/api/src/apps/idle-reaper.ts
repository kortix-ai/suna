import { appDeploymentEvents, appDeployments, appRuntimes, apps } from '@kortix/db';
import { and, asc, count, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import { markComputeSessionAlive, pauseComputeSession } from '../billing/services/compute-metering';
import { type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import { clearAppCrashAlerts, raiseAppCrashAlerts } from '../projects/surface';
import { db } from '../shared/db';
import { mapWithConcurrency } from '../shared/map-with-concurrency';
import { type AppdStatus, AppHostingProvider } from './hosting';
import { groupAlwaysOn, groupMinRunning, releaseConfigOf } from './release-config';
import { transitionAppRuntime, transitionAppRuntimes } from './runtime-status';

/** Does keep-alive look after this release: an always-on group, or a group with `min_machines_running`? */
function releaseKeptUp(app: typeof apps.$inferSelect, deployment: typeof appDeployments.$inferSelect): boolean {
  const config = releaseConfigOf(deployment, app);
  return Object.keys(config.processes).some((group) => groupAlwaysOn(app, config, group) || groupMinRunning(config, group) > 0);
}

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
    await transitionAppRuntimes(
      'releaseIdleStop',
      lt(appRuntimes.updatedAt, new Date(now.getTime() - STALE_STOPPING_MS)),
      { updatedAt: now },
    );
    const rows = await db
      .select({ runtime: appRuntimes, app: apps, deployment: appDeployments })
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
    for (const { runtime, app, deployment } of rows) {
      try {
        // A worker group, an autostop-off service, or `min_machines_running` keeps the machine up.
        const config = releaseConfigOf(deployment, app);
        if (groupAlwaysOn(app, config, runtime.processGroup)) continue;
        const min = groupMinRunning(config, runtime.processGroup);
        if (min > 0) {
          const [{ running: runningCount } = { running: 0 }] = await db.select({ running: count() }).from(appRuntimes).where(and(
            eq(appRuntimes.deploymentId, runtime.deploymentId),
            eq(appRuntimes.processGroup, runtime.processGroup),
            eq(appRuntimes.status, 'running'),
          ));
          if (runningCount <= min) continue;
        }
        const claimed = await transitionAppRuntime(
          'claimIdleStop',
          and(
            eq(appRuntimes.runtimeId, runtime.runtimeId),
            lte(appRuntimes.idleDeadlineAt, now),
            or(isNull(appRuntimes.activityLeaseUntil), lt(appRuntimes.activityLeaseUntil, now)),
          ),
          { updatedAt: now },
        );
        if (!claimed) continue;
        await hosting.stop(claimed.provider as SandboxProviderName, claimed.externalId);
        const stoppedAt = new Date();
        // Only this reaper's own claim: a wake that leased the row while the
        // provider stop ran started the box again, and its `running` stands.
        const finished = await transitionAppRuntime(
          'finishIdleStop',
          eq(appRuntimes.runtimeId, claimed.runtimeId),
          { stoppedAt, activityLeaseUntil: null, updatedAt: stoppedAt },
        );
        if (!finished) continue;
        await pauseComputeSession(claimed.runtimeId, stoppedAt);
        stopped += 1;
      } catch (error) {
        errors += 1;
        await transitionAppRuntime('releaseIdleStop', eq(appRuntimes.runtimeId, runtime.runtimeId), { updatedAt: new Date() })
          .catch(() => null);
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
  unfundedStopped: number;
  started: number;
  refreshed: number;
  refreshDeferred: number;
  confirmed: number;
  /** Rows that said running while the provider said otherwise. */
  lost: number;
  /** Running VMs whose supervisor (kortix-appd) was down and was started again. */
  revived: number;
}

/** Supervisor restarts per runtime in any hour; past it the App stays down until a person or a deploy acts. */
export const APPD_REVIVES_PER_HOUR = 3;
const HOUR_MS = 60 * 60_000;

/**
 * Supervisor restarts of `runtimeId` in the hour before `now`: its
 * `supervisor_restarted` events. Durable: a count in the leader's memory
 * started from 0 on every leader change (each API deploy on dev), so a crash
 * loop got 3 more restarts per deploy and its crash alert waited.
 */
export async function appdRevivesInLastHour(runtimeId: string, now: Date): Promise<number> {
  const [row] = await db.select({ n: count() }).from(appDeploymentEvents).where(and(
    eq(appDeploymentEvents.runtimeId, runtimeId),
    eq(appDeploymentEvents.type, 'supervisor_restarted'),
    gt(appDeploymentEvents.createdAt, new Date(now.getTime() - HOUR_MS)),
  ));
  return Number(row?.n ?? 0);
}

// replica-local: the crash episode each always-on App is in (App id → when it
// began), so kortix.app.crashed is one event per episode and a crash after a
// recovery is a new one. A leader change forgets it: at most one repeat event.
const crashEpisodes = new Map<string, number>();

/** Forget every crash episode (a DB suite that reuses App ids between tests). */
export function resetCrashEpisodesForTest(): void {
  crashEpisodes.clear();
}

/**
 * One App's health this pass, across its machines: down past the restart
 * budget on any machine opens (or keeps) its crash episode; every checked
 * machine ready ends it. Deciding per App, not per machine, keeps a healthy
 * machine from clearing what a crashed one raised on every pass.
 */
export function crashVerdict(machines: readonly MachineHealth[]): 'crashed' | 'ready' | 'unknown' {
  if (machines.includes('spent')) return 'crashed';
  return machines.length > 0 && machines.every((health) => health === 'ready') ? 'ready' : 'unknown';
}

/** What one machine's keep-alive found: down past the budget, ready, or neither (restarted, starting, not asked). */
export type MachineHealth = 'spent' | 'ready' | 'other';

/**
 * Whether a running VM's supervisor needs a start. kortix-appd exits once its
 * App used its restart budget, and an always-on App takes no wake on a
 * request, so nothing else would start it again: unreachable means down. A
 * `failed` status that names a reason (a missing volume) is not fixed by a
 * restart and is left alone.
 */
export function supervisorNeedsStart(status: AppdStatus | null): boolean {
  if (!status) return true;
  return status.status === 'failed' && !status.reason;
}

/**
 * The always-on lifecycle, every 5 minutes. It runs beside the idle reaper,
 * not inside it, so a slow start never holds up idle stops.
 *   1. Cost: a running App (either mode) is stopped when its account can no
 *      longer pay (the same check session create runs).
 *   2. Refresh: an always-on App never cold-starts, so its stale supervisor
 *      (or its static App still on a sandbox) is queued for the rebuild a cold
 *      start would queue, at most `KEEP_ALIVE_REFRESHES_PER_PASS` per pass.
 *   3. Keep running: the provider is asked about every always-on runtime the
 *      database records as running. Running: compute liveness is stamped, so
 *      billing continues without inbound traffic, and on Daytona the
 *      provider's idle timer is renewed. Not running: the row is corrected and
 *      the App is started through the wake gate (entitlement, concurrency),
 *      like an App whose row already said stopped.
 */
export async function runAppKeepAlive(now = new Date(), force = false): Promise<AppKeepAliveResult | null> {
  if (keepAliveRunning) return null;
  if (!force && now.getTime() - lastKeepAliveAt < KEEP_ALIVE_EVERY_MS) return null;
  lastKeepAliveAt = now.getTime();
  keepAliveRunning = true;
  try {
    const hosting = new AppHostingProvider();
    const cost = await stopUnaffordableRuntimes(hosting);
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

async function stopUnaffordableRuntimes(hosting: AppHostingProvider) {
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
        if (!unfundedReason) return;
        await stopForCost(hosting, runtime, 'app_stopped_unfunded', `Stopped: ${unfundedReason}`);
        unfundedStopped += 1;
        logger.warn('[apps] App stopped: its account cannot pay for compute', { appId: app.appId });
      } catch (error) {
        logger.error('[apps] cost check failed', { appId: app.appId, error: String(error) });
      }
    }).then(() => undefined),
  );
  return { unfundedStopped };
}

async function stopForCost(hosting: AppHostingProvider, runtime: RuntimeRow, type: string, message: string) {
  await hosting.stop(runtime.provider as SandboxProviderName, runtime.externalId);
  const stoppedAt = new Date();
  await transitionAppRuntime('stop', eq(appRuntimes.runtimeId, runtime.runtimeId), {
    stoppedAt, activityLeaseUntil: null, idleDeadlineAt: null, updatedAt: stoppedAt,
  });
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
  let revived = 0;

  const keepInstanceRunning = async (app: AppRow, deployment: typeof appDeployments.$inferSelect, instance: RuntimeRow): Promise<MachineHealth> => {
    let runtime = instance;
    const provider = runtime.provider as SandboxProviderName;
    if (runtime.status === 'running') {
      const status = await hosting.providerStatus(provider, runtime.externalId);
      if (status === 'unknown') return 'other'; // the provider did not answer; the next pass asks again
      if (status === 'running') {
        await markComputeSessionAlive(runtime.runtimeId, now);
        // Platinum runs an always-on App as a persistent VM. Daytona keeps
        // its idle backstop; renewing it here keeps the VM up.
        if (provider !== 'platinum') {
          await hosting.renewLifecycle(provider, runtime.externalId).catch((error) =>
            logger.warn('[apps] always-on lifecycle renewal failed', { appId: app.appId, error: String(error) }));
        }
        confirmed += 1;
        // The VM runs; does its App? A crash-looping App ends its supervisor.
        const appd = await hosting.status(provider, runtime.externalId, runtime.runtimeId).catch(() => null);
        if (supervisorNeedsStart(appd)) {
          if ((await appdRevivesInLastHour(runtime.runtimeId, now)) >= APPD_REVIVES_PER_HOUR) {
            logger.warn('[apps] always-on App supervisor is down and its restart budget is spent', { appId: app.appId, runtimeId: runtime.runtimeId });
            return 'spent';
          }
          // Only the supervisor: a VM that stopped meanwhile refuses it, and the
          // next pass starts that VM through the wake gate.
          await hosting.startSupervisor(provider, runtime.externalId).then(
            async () => {
              revived += 1;
              // The record is the budget (appdRevivesInLastHour).
              await db.insert(appDeploymentEvents).values({
                deploymentId: runtime.deploymentId, runtimeId: runtime.runtimeId, level: 'warn', type: 'supervisor_restarted',
                message: `The App's process had stopped; Kortix started it again (at most ${APPD_REVIVES_PER_HOUR} times an hour).`,
              }).catch(() => undefined);
            },
            (error) => logger.warn('[apps] always-on App supervisor could not be started', { appId: app.appId, error: String(error) }),
          );
          return 'other';
        }
        return appd?.ready ? 'ready' : 'other';
      }
      // The row says running; the provider says it is not. Record the truth,
      // close the compute window, then start it through the wake gate.
      const stoppedAt = new Date();
      const corrected = await transitionAppRuntime('lost', eq(appRuntimes.runtimeId, runtime.runtimeId), {
        stoppedAt, activityLeaseUntil: null, idleDeadlineAt: null, updatedAt: stoppedAt,
      });
      if (!corrected) return 'other';
      await pauseComputeSession(runtime.runtimeId, stoppedAt);
      runtime = corrected;
      lost += 1;
    }
    if (runtime.status !== 'stopped') return 'other';
    await ensureAppRuntimeRunning({ app, deployment, runtime }, hosting);
    started += 1;
    return 'other';
  };

  /**
   * Every machine of an always-on group stays up; a group with
   * `min_machines_running` keeps that many up (running ones first).
   */
  const keepRunning = async (app: AppRow, deployment: typeof appDeployments.$inferSelect) => {
    const config = releaseConfigOf(deployment, app);
    const instances = await db.select().from(appRuntimes)
      .where(and(eq(appRuntimes.deploymentId, deployment.deploymentId), inArray(appRuntimes.status, ['running', 'stopped'])))
      .orderBy(desc(appRuntimes.status), asc(appRuntimes.createdAt));
    const health: MachineHealth[] = [];
    for (const group of Object.keys(config.processes)) {
      const own = instances.filter((instance) => instance.processGroup === group);
      const keep = groupAlwaysOn(app, config, group) ? own : own.slice(0, groupMinRunning(config, group));
      for (const instance of keep) health.push(await keepInstanceRunning(app, deployment, instance));
    }
    // The App's health, once per pass (app-health-alerts.ts): the triggers that
    // name it hear a crash once per episode, and a repair trigger gets
    // kortix.app.crashed; all machines ready again ends it.
    const verdict = crashVerdict(health);
    if (verdict === 'crashed') {
      const episode = crashEpisodes.get(app.appId) ?? now.getTime();
      crashEpisodes.set(app.appId, episode);
      await raiseAppCrashAlerts({ projectId: app.projectId, appSlug: app.slug, episode: `${app.appId}:${episode}`, restarts: APPD_REVIVES_PER_HOUR, now })
        .catch((error) => logger.warn('[apps] crash alert failed', { appId: app.appId, error: String(error) }));
    } else if (verdict === 'ready') {
      crashEpisodes.delete(app.appId);
      await clearAppCrashAlerts({ projectId: app.projectId, appSlug: app.slug, now })
        .catch((error) => logger.warn('[apps] crash recovery failed', { appId: app.appId, error: String(error) }));
    }
  };

  await forEachPage(
    (after) => db
      .select({ app: apps, deployment: appDeployments })
      .from(apps)
      .innerJoin(appDeployments, eq(appDeployments.deploymentId, apps.activeDeploymentId))
      .where(and(
        // A release with a config may have a worker group or `min_machines_running`.
        or(eq(apps.alwaysOn, true), isNotNull(appDeployments.config)),
        eq(apps.desiredState, 'running'),
        isNull(apps.deletedAt),
        eq(appDeployments.status, 'ready'),
        eq(appDeployments.hostingType, 'sandbox'),
        after ? gt(apps.appId, after) : undefined,
      ))
      .orderBy(asc(apps.appId))
      .limit(KEEP_ALIVE_PAGE),
    (row) => row.app.appId,
    async (page) => {
      const rows = page.filter(({ app, deployment }) => releaseKeptUp(app, deployment));
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
          // Unfunded, at the account's App cap, or a provider
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
  if (revived > 0) logger.info('[apps] keep-alive started stopped supervisors', { revived });
  return { started, refreshed, refreshDeferred, confirmed, lost, revived };
}
