import { randomUUID } from 'node:crypto';
import { appDeployments, appRuntimes, apps, projects } from '@kortix/db';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { pauseComputeSession, startComputeSession } from '../billing/services/compute-metering';
import { config, type SandboxProviderName } from '../config';
import { db } from '../shared/db';
import { resolveFeatureFlag } from '../feature-flags/registry';
import { agentPrincipalEnabled } from './access';
import { assertAppComputeAllowed } from './limits';
import { AppHostingProvider } from './hosting';
import { appWakeSupersededResponse } from './public-proxy-status';
const WAKE_LEASE_MS = 2 * 60_000;

export async function loadPublicAppState(routeKey: string) {
  const [loaded] = await db
    .select({ app: apps, projectMetadata: projects.metadata })
    .from(apps)
    .innerJoin(projects, eq(projects.projectId, apps.projectId))
    .where(and(eq(apps.routeKey, routeKey), isNull(apps.deletedAt)))
    .limit(1);
  const app = loaded?.app;
  if (!loaded || !resolveFeatureFlag(loaded.projectMetadata, 'apps')) return null;
  if (!app) return null;
  let [deployment] = app.activeDeploymentId
    ? await db.select().from(appDeployments)
        .where(eq(appDeployments.deploymentId, app.activeDeploymentId)).limit(1)
    : [];
  if (!deployment) {
    [deployment] = await db.select().from(appDeployments)
      .where(eq(appDeployments.appId, app.appId))
      .orderBy(desc(appDeployments.createdAt))
      .limit(1);
  }
  const [runtime] = deployment?.status === 'ready'
    ? await db.select().from(appRuntimes)
        .where(eq(appRuntimes.deploymentId, deployment.deploymentId))
        .orderBy(desc(appRuntimes.createdAt)).limit(1)
    : [];
  return {
    app,
    deployment: deployment ?? null,
    runtime: runtime ?? null,
    /** The project's `agent_principal` flag — the App gate's §2.5 switch. */
    agentPrincipal: agentPrincipalEnabled(loaded.projectMetadata),
  };
}

export async function loadPublicApp(routeKey: string) {
  const state = await loadPublicAppState(routeKey);
  if (
    !state?.app.activeDeploymentId ||
    state.deployment?.deploymentId !== state.app.activeDeploymentId ||
    state.deployment.status !== 'ready' ||
    !state.runtime
  ) return null;
  return {
    app: state.app,
    deployment: state.deployment,
    runtime: state.runtime,
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

export function appRuntimeNeedsWake(
  runtime: Pick<typeof appRuntimes.$inferSelect, 'status' | 'idleDeadlineAt'>,
  now = new Date(),
): boolean {
  if (runtime.status !== 'running') return true;
  return Boolean(runtime.idleDeadlineAt && runtime.idleDeadlineAt.getTime() <= now.getTime());
}

type LoadedApp = Omit<NonNullable<Awaited<ReturnType<typeof loadPublicApp>>>, 'agentPrincipal'>;
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
    spec: {
      ...hosting.effectiveMachine(provider, {
        cpuCores: app.cpuCores, memoryGb: app.memoryGb, diskGb: app.diskGb,
      }), gpuCount: 0,
    },
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
  if (!appRuntimeNeedsWake(loaded.runtime)) return loaded.runtime;
  if (loaded.runtime.status === 'deleted') {
    throw new Error('App runtime cannot wake from deleted');
  }
  // Account entitlement, account App-concurrency, then this App's own monthly
  // budget. The runtime being woken is excluded from the concurrency count —
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
      console.error(`[apps] failed wake left the compute window open for ${loaded.runtime.runtimeId}:`, pauseErr),
    );
    throw error;
  }
}
