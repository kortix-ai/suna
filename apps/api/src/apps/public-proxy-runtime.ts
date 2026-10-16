import { randomUUID } from 'node:crypto';
import { appDeployments, appRuntimes, apps, projects } from '@kortix/db';
import { and, desc, eq, inArray, isNull, lt, notInArray, or, sql } from 'drizzle-orm';
import { pauseComputeSession, startComputeSession } from '../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../config';
import { db } from '../shared/db';
import { assertAppComputeAllowed } from './limits';
import { AppHostingProvider, instanceMachine } from './hosting';
import { appWakeSupersededResponse } from './public-proxy-status';
import { logger } from '../lib/logger';
import { releaseConfigOf, servingGroups } from './release-config';
const WAKE_LEASE_MS = 2 * 60_000;

/**
 * One query for the App and its active deployment. A static deployment needs
 * nothing more, so a static asset costs one query (the manifest and blobs are
 * cached per replica). Only a server App reads its runtime. The App row is
 * never cached: an access change, a rollback and a delete take effect on the
 * next request on every replica.
 */
/**
 * The App behind a host and the machine that serves it. `service`: the host's
 * service; its process groups choose the machine. `service` is null when the
 * active release has no such service.
 */
export async function loadPublicAppState(routeKey: string, serviceName = 'http') {
  const [loaded] = await db
    .select({ app: apps, active: appDeployments })
    .from(apps)
    .innerJoin(projects, eq(projects.projectId, apps.projectId))
    .leftJoin(appDeployments, eq(appDeployments.deploymentId, apps.activeDeploymentId))
    // An App of a deleted workspace is not served (KRTX-1714).
    .where(and(eq(apps.routeKey, routeKey), isNull(apps.deletedAt), eq(projects.status, 'active')))
    .limit(1);
  if (!loaded) return null;
  const app = loaded.app;
  let deployment = loaded.active ?? undefined;
  if (!deployment) {
    [deployment] = await db.select().from(appDeployments)
      .where(eq(appDeployments.appId, app.appId))
      .orderBy(desc(appDeployments.createdAt))
      .limit(1);
  }
  const releaseConfig = deployment && deployment.hostingType !== 'static' ? releaseConfigOf(deployment, app) : null;
  const service = releaseConfig?.services.find((entry) => entry.name === serviceName) ?? null;
  const groups = service ? service.processes : releaseConfig ? servingGroups(releaseConfig) : [];
  const runtime = deployment && releaseServes(deployment, app.activeDeploymentId) && deployment.hostingType !== 'static'
    && (service || serviceName === 'http')
    ? await pickServingInstance(deployment, groups)
    : null;
  return {
    app,
    deployment: deployment ?? null,
    runtime: runtime ?? null,
    service,
    /** A governed agent is judged as itself (§2.5); there is no off switch. */
    agentPrincipal: true,
  };
}

/**
 * Does this release take traffic? A ready one, and the active one while a
 * rolling release is still replacing machines (traffic moves with its first
 * healthy machine).
 */
export function releaseServes(
  deployment: Pick<typeof appDeployments.$inferSelect, 'deploymentId' | 'status'>,
  activeDeploymentId: string | null,
): boolean {
  return deployment.status === 'ready'
    || (deployment.status === 'checking' && deployment.deploymentId === activeDeploymentId);
}

/**
 * The instance a request goes to: one of the release's machines in the group
 * that serves the App's host. A running one first, the least recently used
 * of those (requests spread over the machines); else a stopped one to wake.
 */
async function pickServingInstance(deployment: typeof appDeployments.$inferSelect, groups: string[]) {
  const [runtime] = await db.select().from(appRuntimes)
    .where(and(
      eq(appRuntimes.deploymentId, deployment.deploymentId),
      inArray(appRuntimes.processGroup, groups),
      notInArray(appRuntimes.status, ['deleted', 'error']),
    ))
    .orderBy(
      sql`case ${appRuntimes.status} when 'running' then 0 when 'starting' then 1 when 'provisioning' then 1 else 2 end`,
      sql`${appRuntimes.lastRequestAt} asc nulls first`,
      desc(appRuntimes.createdAt),
    )
    .limit(1);
  return runtime ?? null;
}

export async function loadPublicApp(routeKey: string, service = 'http') {
  const state = await loadPublicAppState(routeKey, service);
  if (
    !state?.app.activeDeploymentId ||
    state.deployment?.deploymentId !== state.app.activeDeploymentId ||
    !releaseServes(state.deployment, state.app.activeDeploymentId) ||
    !state.runtime
  ) return null;
  return {
    app: state.app,
    deployment: state.deployment,
    runtime: state.runtime,
    service: state.service,
    agentPrincipal: state.agentPrincipal,
  };
}

async function waitForWake(runtimeId: string, deadline: number) {
  while (Date.now() < deadline) {
    const [runtime] = await db
      .select()
      .from(appRuntimes)
      .where(eq(appRuntimes.runtimeId, runtimeId))
      .limit(1);
    if (!runtime) throw new Error('App runtime disappeared while waking');
    if (runtime.status === 'running') return runtime;
    if (
      runtime.status === 'stopped' &&
      (!runtime.wakeLeaseUntil || runtime.wakeLeaseUntil.getTime() <= Date.now())
    ) {
      throw new Error('App wake lease ended before readiness');
    }
    if (runtime.status === 'error' || runtime.status === 'deleted') {
      throw new Error(`App runtime cannot wake from ${runtime.status}`);
    }
    await Bun.sleep(250);
  }
  throw new Error('App cold start timed out');
}

/**
 * Must this request start (or re-check) the runtime before it is proxied? A
 * stopped one, yes. A running on-demand one past its idle deadline, yes: the
 * idle reaper may be stopping it. A running always-on one never: nothing
 * idle-stops it, and the keep-alive pass confirms it with the provider.
 */
export function appRuntimeNeedsWake(
  runtime: Pick<typeof appRuntimes.$inferSelect, 'status' | 'idleDeadlineAt'>,
  now = new Date(),
  alwaysOn = false,
): boolean {
  if (runtime.status !== 'running') return true;
  if (alwaysOn) return false;
  return Boolean(runtime.idleDeadlineAt && runtime.idleDeadlineAt.getTime() <= now.getTime());
}

type LoadedApp = Omit<NonNullable<Awaited<ReturnType<typeof loadPublicApp>>>, 'agentPrincipal' | 'service'>;
type Runtime = LoadedApp['runtime'];
type App = LoadedApp['app'];

async function claimWakeLease(runtimeId: string) {
  const owner = `${config.INTERNAL_KORTIX_ENV}:${process.pid}:${randomUUID()}`;
  const now = new Date();
  const [leased] = await db.update(appRuntimes).set({
    status: 'starting', wakeLeaseOwner: owner,
    wakeLeaseUntil: new Date(now.getTime() + WAKE_LEASE_MS), updatedAt: now,
  }).where(and(eq(appRuntimes.runtimeId, runtimeId),
    or(isNull(appRuntimes.wakeLeaseUntil), lt(appRuntimes.wakeLeaseUntil, now)))).returning();
  return { owner, leased };
}

async function stopWakingRuntime(runtimeId: string, owner: string) {
  const stoppedAt = new Date();
  await db.update(appRuntimes).set({
    status: 'stopped', stoppedAt, activityLeaseUntil: null, idleDeadlineAt: null,
    wakeLeaseOwner: null, wakeLeaseUntil: null, updatedAt: stoppedAt,
  }).where(and(eq(appRuntimes.runtimeId, runtimeId), eq(appRuntimes.wakeLeaseOwner, owner)));
  return stoppedAt;
}

async function publishWake(app: App, loaded: LoadedApp, leased: Runtime, owner: string, hosting: AppHostingProvider) {
  const provider = leased.provider as SandboxProviderName;
  const [currentApp] = await db.select({ desiredState: apps.desiredState, deletedAt: apps.deletedAt })
    .from(apps).where(eq(apps.appId, app.appId)).limit(1);
  if (!currentApp || currentApp.deletedAt || currentApp.desiredState !== 'running') {
    await hosting.stop(provider, leased.externalId);
    const stoppedAt = await stopWakingRuntime(leased.runtimeId, owner);
    await pauseComputeSession(leased.runtimeId, stoppedAt);
    throw appWakeSupersededResponse();
  }
  const readyAt = new Date();
  const [running] = await db.update(appRuntimes).set({
    status: 'running', startedAt: readyAt, stoppedAt: null, wakeLeaseOwner: null,
    wakeLeaseUntil: null, idleDeadlineAt: new Date(readyAt.getTime() + app.idleTimeoutSeconds * 1000),
    updatedAt: readyAt,
  }).where(and(eq(appRuntimes.runtimeId, leased.runtimeId), eq(appRuntimes.wakeLeaseOwner, owner))).returning();
  if (!running) throw new Error('App wake lease was lost after provider start');
  await startComputeSession({
    sandboxId: running.runtimeId, accountId: running.accountId, provider,
    spec: { ...hosting.effectiveMachine(provider, instanceMachine(running, app)), gpuCount: 0 },
    workloadType: 'app', appRuntimeId: running.runtimeId,
    metadata: { appId: app.appId, deploymentId: loaded.deployment.deploymentId },
  });
  return running;
}

export async function ensureAppRuntimeRunning(
  loaded: LoadedApp,
  hosting: AppHostingProvider,
  options: { forceProviderStart?: boolean } = {},
) {
  let app = loaded.app;
  if (app.desiredState !== 'running') {
    const [reactivated] = await db
      .update(apps)
      .set({ desiredState: 'running', updatedAt: new Date() })
      .where(and(eq(apps.appId, app.appId), isNull(apps.deletedAt)))
      .returning();
    if (!reactivated) throw new Error('App no longer exists');
    app = reactivated;
  }
  if (!appRuntimeNeedsWake(loaded.runtime, new Date(), app.alwaysOn)) return loaded.runtime;
  if (loaded.runtime.status === 'deleted') {
    throw new Error('App runtime cannot wake from deleted');
  }
  // Account entitlement, then account App-concurrency. The runtime being woken is excluded from the concurrency count —
  // it already holds its own live row, and counting it would stop an account at
  // exactly the cap from waking the very App it owns.
  await assertAppComputeAllowed(app, { excludeRuntimeId: loaded.runtime.runtimeId });

  const { owner, leased } = await claimWakeLease(loaded.runtime.runtimeId);
  if (!leased) return waitForWake(loaded.runtime.runtimeId, Date.now() + WAKE_LEASE_MS);

  try {
    const provider = leased.provider as SandboxProviderName;
    if (options.forceProviderStart) await hosting.start(provider, leased.externalId);
    else await hosting.ensureRunning(provider, leased.externalId);
    await hosting.waitUntilReady(provider, leased.externalId, leased.runtimeId, 120_000);

    return await publishWake(app, loaded, leased, owner, hosting);
  } catch (error) {
    const stoppedAt = await stopWakingRuntime(loaded.runtime.runtimeId, owner);
    await pauseComputeSession(loaded.runtime.runtimeId, stoppedAt).catch((pauseErr) =>
      // compute-invariant-sweep closes it later; until then the window bills.
      logger.error('[apps] failed wake left the compute window open', {
        runtimeId: loaded.runtime.runtimeId,
        error: pauseErr instanceof Error ? pauseErr.message : String(pauseErr),
      }),
    );
    throw error;
  }
}
