/**
 * Machines. A release runs `apps.scale[group] ?? 1` machines per
 * process group. Each machine has a stable `machine_id`; each box that runs it
 * is an instance, one `app_runtimes` row. A new release's instance inherits
 * the machine id (and the volume) of the instance it replaces.
 *
 * Deploy strategies (`deploy.strategy`, spec §5):
 *   - bluegreen (default without mounts): every new instance is created and
 *     healthy, then traffic moves, then the old instances go.
 *   - immediate: every new instance is created and traffic moves at once,
 *     without waiting for checks.
 *   - rolling (default with mounts) and canary: one machine at a time; a
 *     machine with a mount stops its old instance and detaches the volume
 *     before the new instance mounts it (RULE 1, single writer). Traffic moves
 *     when the first new instance is healthy. Canary is refused with mounts.
 * A failed release is abandoned (`abandonRelease`): its instances go, traffic
 * returns to the release before it, and that release gets its machines back
 * (a machine whose old instance was replaced restarts on its own volume).
 */
import { randomUUID } from 'node:crypto';
import { appDeploymentEvents, appDeployments, appLinks, appRuntimes, appVolumes, apps } from '@kortix/db';
import {
  appMountFor,
  appServicesFor,
  appVmFor,
  type AppReleaseConfig,
} from '@kortix/shared/app-config';
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { pauseComputeSession, startComputeSession } from '../billing/services/compute-metering';
import { type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { qualifiedColumn } from '../shared/sql-qualified-column';
import { resolveAppRuntimeEnvironment } from './environment';
import { AppHostingProvider, type AppMachineSpec } from './hosting';
import { teardownAppRuntimes } from './images';
import { groupAlwaysOn, groupScale, releaseConfigOf } from './release-config';
import { appRuntimeIdentityEnv } from './viewer';
import { appServiceUrl } from './hostnames';
import { acquireVolume, detachVolume, ensureMachineVolume, releaseVolume } from './volumes';

type AppRow = typeof apps.$inferSelect;
type DeploymentRow = typeof appDeployments.$inferSelect;
export type InstanceRow = typeof appRuntimes.$inferSelect;

/** Instance states that still hold a machine (a stopped one wakes on demand). */
const GONE = ['deleted', 'error'] as const;
/** The process group of a release command's temporary machine. Never a user group (they start with a letter). */
export const RELEASE_COMMAND_GROUP = '_release';
const LIVE_RELEASE_STATUSES = ['queued', 'validating', 'building', 'provisioning', 'checking'] as const;

export const machineIdOf = (instance: Pick<InstanceRow, 'machineId' | 'runtimeId'>) => instance.machineId ?? instance.runtimeId;

async function event(deploymentId: string, type: string, message: string, data: Record<string, unknown> = {}, runtimeId?: string, level: 'info' | 'warn' | 'error' = 'info') {
  await db.insert(appDeploymentEvents).values({ deploymentId, runtimeId, level, type, message, data });
}

export interface ReleaseEnvironment {
  env: Record<string, string>;
  secretIdentifiers: string[];
  environmentKeys: string[];
}

/**
 * Where the App answers, for code that must know its own URL (a backend that
 * advertises its origin): `KORTIX_APP_SLUG`, `KORTIX_APP_URL` (the `http`
 * service) and `KORTIX_SERVICE_URL_<NAME>` for every other service (`-` → `_`).
 */
export function appUrlEnv(app: AppRow, config: AppReleaseConfig): Record<string, string> {
  const env: Record<string, string> = { KORTIX_APP_SLUG: app.slug, KORTIX_APP_URL: appServiceUrl(app, 'http') ?? '' };
  for (const service of config.services) {
    if (service.name === 'http' || service.protocol !== 'http') continue;
    const url = appServiceUrl(app, service.name);
    if (url) env[`KORTIX_SERVICE_URL_${service.name.toUpperCase().replace(/-/g, '_')}`] = url;
  }
  return env;
}

/**
 * `KORTIX_USES_URL_<SLUG>` (`-` → `_`) for every live App this App uses: a
 * server calls a backend there with a member token. The browser binding
 * (`/_kortix/apps/<slug>`) needs the viewer's App cookie, which a server has
 * not. Links change with a deploy, which makes new machines.
 */
export async function usesUrlEnv(appId: string): Promise<Record<string, string>> {
  const used = await db.select({ slug: apps.slug, routeKey: apps.routeKey })
    .from(appLinks)
    .innerJoin(apps, eq(apps.appId, appLinks.usesAppId))
    .where(and(eq(appLinks.appId, appId), isNull(apps.deletedAt)));
  const env: Record<string, string> = {};
  for (const row of used) {
    const url = appServiceUrl(row, 'http');
    if (url) env[`KORTIX_USES_URL_${row.slug.toUpperCase().replace(/-/g, '_')}`] = url;
  }
  return env;
}

/** Everything a machine of this release runs with: its env, its secrets and the App's identity. */
export async function releaseEnvironment(app: AppRow, deployment: DeploymentRow): Promise<ReleaseEnvironment> {
  const buildSpec = deployment.buildSpec as { environment?: Record<string, string>; secrets?: Record<string, string> };
  // Loaded here, not at module load: the public proxy imports this module (through
  // the deployment worker) and must not pull the whole projects module with it.
  const { listResolvedProjectSecrets } = await import('../projects/surface');
  const resolved = resolveAppRuntimeEnvironment({
    environment: buildSpec.environment ?? {},
    secrets: buildSpec.secrets ?? {},
    availableSecrets: await listResolvedProjectSecrets(app.projectId, deployment.createdBy),
  });
  return {
    // `KORTIX_*` is reserved from user env, so the identity cannot be shadowed.
    env: {
      ...resolved.env,
      ...appRuntimeIdentityEnv(app),
      ...(await import('./events')).appEventEnv(app),
      ...(await (await import('./tokens')).appAuthEnv(app)),
      ...appUrlEnv(app, releaseConfigOf(deployment, app)),
      ...(await usesUrlEnv(app.appId)),
    },
    secretIdentifiers: resolved.secretIdentifiers,
    environmentKeys: Object.keys(resolved.env).sort(),
  };
}

/**
 * The supervisor spec (`KORTIX_APP_SPEC`) of a machine of `group`, or null when
 * the image's own spec already says it: an App on today's single-service
 * shape gets exactly the supervisor behavior it had.
 */
export function machineAppSpec(
  config: AppReleaseConfig,
  group: string,
  runtimeSpec: Record<string, unknown>,
): Record<string, unknown> | null {
  if (runtimeSpec.static_root) return null;
  const services = appServicesFor(config, group).filter((service) => service.protocol === 'http');
  const primary = services.find((service) => service.name === 'http') ?? services[0];
  const command = config.processes[group]?.trim();
  const mount = appMountFor(config, group);
  const checks = appServicesFor(config, group).flatMap((service) => service.checks.map((check, index) => ({
    name: `${service.name}-${index}`,
    ...check,
    port: check.port ?? service.internal_port,
  })));
  const targetPort = primary?.internal_port ?? 0;
  if (!command && !mount && checks.length === 0 && targetPort === runtimeSpec.target_port) return null;
  return {
    ...runtimeSpec,
    target_port: targetPort,
    ...(command ? { command: ['sh', '-c', command] } : {}),
    mounts: mount ? [mount.destination] : [],
    checks,
  };
}

/** The size of a machine of `group`. Daytona sizes from the template, which carries the App's size. */
export function machineSize(app: AppRow, config: AppReleaseConfig, group: string, provider: string): AppMachineSpec {
  if (provider !== 'platinum') return { cpuCores: app.cpuCores, memoryGb: app.memoryGb, diskGb: app.diskGb };
  const vm = appVmFor(config, group);
  return { cpuCores: vm.cpu, memoryGb: vm.memory_gb, diskGb: vm.disk_gb };
}

/** The live instances of a release (stopped ones included). */
export async function releaseInstances(deploymentId: string): Promise<InstanceRow[]> {
  return db.select().from(appRuntimes)
    .where(and(eq(appRuntimes.deploymentId, deploymentId), notInArray(appRuntimes.status, [...GONE])))
    .orderBy(asc(appRuntimes.createdAt));
}

/** Create one instance of a release for a machine: its volume (locked first), its box, its row and its meter. */
export async function createInstance(input: {
  hosting: AppHostingProvider;
  app: AppRow;
  deployment: DeploymentRow;
  config: AppReleaseConfig;
  env: ReleaseEnvironment;
  group: string;
  machineId: string;
}): Promise<InstanceRow> {
  const { hosting, app, deployment, config, env, group, machineId } = input;
  const provider = deployment.hostingProvider as SandboxProviderName;
  if (!deployment.providerBuildId) throw new Error(`Release ${deployment.deploymentId} has no image`);
  const mount = appMountFor(config, group);
  const volume = mount
    ? await ensureMachineVolume({ appId: app.appId, accountId: app.accountId, mount, group, machineId })
    : null;
  const runtimeId = randomUUID();
  if (volume) await acquireVolume(volume.volumeId, runtimeId);
  const machine = machineSize(app, config, group, provider);
  const spec = machineAppSpec(config, group, deployment.runtimeSpec as Record<string, unknown>);
  let handle;
  try {
    handle = await hosting.createRuntime({
      provider,
      runtimeId,
      accountId: app.accountId,
      userId: deployment.createdBy,
      name: `app-${app.routeKey}-v${deployment.version}-${group}`,
      snapshotName: deployment.providerBuildId,
      machine,
      alwaysOn: groupAlwaysOn(app, config, group),
      envVars: {
        ...env.env,
        KORTIX_MACHINE_ID: machineId,
        KORTIX_PROCESS_GROUP: group,
        ...(spec ? { KORTIX_APP_SPEC: JSON.stringify(spec) } : {}),
      },
      ...(volume && mount ? { volumes: { [mount.destination]: { volume: volume.externalId } } } : {}),
    });
  } catch (error) {
    if (volume) await releaseVolume(volume.volumeId, runtimeId);
    throw error;
  }
  const now = new Date();
  const [row] = await db.insert(appRuntimes).values({
    runtimeId,
    deploymentId: deployment.deploymentId,
    accountId: app.accountId,
    provider,
    externalId: handle.externalId,
    status: 'starting',
    controlTokenHash: handle.controlTokenHash,
    machineId,
    processGroup: group,
    volumeId: volume?.volumeId ?? null,
    idleDeadlineAt: new Date(now.getTime() + app.idleTimeoutSeconds * 1000),
    startedAt: now,
    metadata: { ...handle.metadata, machine, secretIdentifiers: env.secretIdentifiers, environmentKeys: env.environmentKeys },
  }).returning().catch(async (error) => {
    await hosting.remove(provider, handle.externalId).catch(() => {});
    if (volume) await releaseVolume(volume.volumeId, runtimeId);
    throw error;
  });
  await startComputeSession({
    sandboxId: runtimeId,
    accountId: app.accountId,
    actorUserId: deployment.createdBy,
    provider,
    spec: { ...machine, gpuCount: 0 },
    workloadType: 'app',
    appRuntimeId: runtimeId,
    metadata: { deploymentId: deployment.deploymentId, appId: app.appId, machineId, processGroup: group },
  });
  await event(deployment.deploymentId, 'runtime_created', `Machine ${machineId.slice(0, 8)} (${group}) created`, {
    provider, externalId: handle.externalId, machineId, processGroup: group, volumeId: volume?.volumeId ?? null,
  }, runtimeId);
  return row!;
}

/**
 * Wait until an instance's supervisor reports ready, then mark it running. A
 * volume that is not mounted in the guest (RULE 2: an in-guest reboot leaves it
 * unmounted while the provider says mounted) gets one provider stop and start.
 */
export async function waitInstanceReady(hosting: AppHostingProvider, instance: InstanceRow): Promise<void> {
  const provider = instance.provider as SandboxProviderName;
  try {
    await hosting.waitUntilReady(provider, instance.externalId, instance.runtimeId);
  } catch (error) {
    if (!(error instanceof Error && error.message.includes('mount_missing'))) throw error;
    await event(instance.deploymentId, 'machine_remount', 'A volume was not mounted in the machine; restarting it', {}, instance.runtimeId, 'warn');
    await hosting.stop(provider, instance.externalId);
    await hosting.start(provider, instance.externalId);
    await hosting.waitUntilReady(provider, instance.externalId, instance.runtimeId);
  }
  const now = new Date();
  await db.update(appRuntimes).set({ status: 'running', startedAt: now, stoppedAt: null, updatedAt: now })
    .where(and(eq(appRuntimes.runtimeId, instance.runtimeId), ne(appRuntimes.status, 'deleted')));
}

/** Stop an instance's box and close its meter. Idempotent. */
export async function stopInstance(hosting: AppHostingProvider, instance: InstanceRow): Promise<void> {
  await hosting.stop(instance.provider as SandboxProviderName, instance.externalId);
  const now = new Date();
  await db.update(appRuntimes).set({
    status: 'stopped', stoppedAt: now, activityLeaseUntil: null, idleDeadlineAt: null,
    wakeLeaseOwner: null, wakeLeaseUntil: null, updatedAt: now,
  }).where(and(eq(appRuntimes.runtimeId, instance.runtimeId), ne(appRuntimes.status, 'deleted')));
  await pauseComputeSession(instance.runtimeId, now);
}

/**
 * Destroy an instance and give its volume back: stop (Platinum commits the
 * mount), detach, then remove the box. Its volume stays with its machine.
 */
export async function destroyInstance(
  hosting: AppHostingProvider,
  instance: InstanceRow,
  mountPath: string | null,
): Promise<void> {
  if (instance.volumeId) {
    await stopInstance(hosting, instance);
    if (mountPath) await detachVolume(instance, mountPath);
  }
  const { failed } = await teardownAppRuntimes([instance]);
  if (failed > 0) throw new Error(`Machine ${machineIdOf(instance)} could not be removed`);
}

/** The release that served before this one: the active one, else the newest other ready release. */
export async function previousReleaseId(appId: string, deploymentId: string): Promise<string | null> {
  const [app] = await db.select({ active: apps.activeDeploymentId }).from(apps).where(eq(apps.appId, appId)).limit(1);
  if (app?.active && app.active !== deploymentId) return app.active;
  const [ready] = await db.select({ id: appDeployments.deploymentId }).from(appDeployments)
    .where(and(eq(appDeployments.appId, appId), eq(appDeployments.status, 'ready'), ne(appDeployments.deploymentId, deploymentId)))
    .orderBy(desc(appDeployments.version)).limit(1);
  return ready?.id ?? null;
}

/** Point the App's traffic at a release (under the App's deploy lock, like every pointer move). */
export async function pointTraffic(appId: string, deploymentId: string | null, onlyFrom?: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${appId}))`);
    await tx.update(apps).set({ activeDeploymentId: deploymentId, updatedAt: new Date() })
      .where(and(eq(apps.appId, appId), onlyFrom ? eq(apps.activeDeploymentId, onlyFrom) : undefined));
  });
}

interface Slot {
  group: string;
  machineId: string;
  /** The previous release's instance of this machine. */
  old: InstanceRow | null;
  /** This release's instance from an attempt that died. */
  current: InstanceRow | null;
}

/** Which machines this release runs: the previous release's machines first (they keep their ids and volumes). */
export function planMachines(
  config: AppReleaseConfig,
  scale: unknown,
  previous: InstanceRow[],
  mine: InstanceRow[],
  newId: () => string = randomUUID,
): { slots: Slot[]; leftovers: InstanceRow[] } {
  const slots: Slot[] = [];
  for (const group of Object.keys(config.processes)) {
    const old = previous.filter((instance) => instance.processGroup === group);
    const own = mine.filter((instance) => instance.processGroup === group);
    const ids = [...new Set([...old.map(machineIdOf), ...own.map(machineIdOf)])].slice(0, groupScale(scale, group));
    while (ids.length < groupScale(scale, group)) ids.push(newId());
    for (const machineId of ids) {
      slots.push({
        group,
        machineId,
        old: old.find((instance) => machineIdOf(instance) === machineId) ?? null,
        current: own.find((instance) => machineIdOf(instance) === machineId) ?? null,
      });
    }
  }
  const kept = new Set(slots.flatMap((slot) => [slot.old?.runtimeId, slot.current?.runtimeId]));
  return { slots, leftovers: [...previous, ...mine].filter((instance) => !kept.has(instance.runtimeId)) };
}

async function firstRejection<T>(results: PromiseSettledResult<T>[]): Promise<T[]> {
  const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failed) throw failed.reason;
  return results.map((result) => (result as PromiseFulfilledResult<T>).value);
}

/**
 * Roll a built release out on its strategy. `activate` moves traffic for good
 * (the caller marks the release ready); it runs before the previous release's
 * instances go, so traffic never points at nothing. A throw leaves cleanup to
 * `abandonRelease`.
 */
export async function rollOutRelease(input: {
  hosting: AppHostingProvider;
  app: AppRow;
  deployment: DeploymentRow;
  config: AppReleaseConfig;
  env: ReleaseEnvironment;
  activate: () => Promise<void>;
}): Promise<{ previousDeploymentId: string | null }> {
  const { hosting, app, deployment, config, env } = input;
  const previousId = await previousReleaseId(app.appId, deployment.deploymentId);
  const [previous] = previousId
    ? await db.select().from(appDeployments).where(eq(appDeployments.deploymentId, previousId)).limit(1)
    : [];
  const previousConfig = previous ? releaseConfigOf(previous, app) : null;
  const { slots, leftovers } = planMachines(
    config,
    app.scale,
    previous ? await releaseInstances(previous.deploymentId) : [],
    await releaseInstances(deployment.deploymentId),
  );
  const strategy = config.deploy.strategy;
  await event(deployment.deploymentId, 'rollout_started', `Rolling out ${slots.length} machine(s) (${strategy})`, {
    strategy, machines: slots.map((slot) => ({ group: slot.group, machineId: slot.machineId })),
  });

  const launch = async (slot: Slot): Promise<InstanceRow> => {
    // RULE 1: the old instance lets go of the volume before the new one mounts it.
    if (slot.old && appMountFor(config, slot.group)) {
      await destroyInstance(hosting, slot.old, previousConfig ? appMountFor(previousConfig, slot.old.processGroup)?.destination ?? null : null);
      slot.old = null;
    }
    if (slot.current) {
      if (slot.current.status !== 'running') await hosting.start(slot.current.provider as SandboxProviderName, slot.current.externalId);
      return slot.current;
    }
    slot.current = await createInstance({ hosting, app, deployment, config, env, group: slot.group, machineId: slot.machineId });
    return slot.current;
  };

  if (strategy === 'rolling' || strategy === 'canary') {
    let switched = false;
    for (const slot of slots) {
      await waitInstanceReady(hosting, await launch(slot));
      if (!switched) {
        // Traffic moves with the first healthy machine; the release keeps rolling.
        await pointTraffic(app.appId, deployment.deploymentId);
        switched = true;
      }
    }
  } else {
    const instances = await firstRejection(await Promise.allSettled(slots.map(launch)));
    if (strategy === 'immediate') {
      const now = new Date();
      if (instances.length > 0) {
        await db.update(appRuntimes).set({ status: 'running', updatedAt: now })
          .where(inArray(appRuntimes.runtimeId, instances.map((instance) => instance.runtimeId)));
      }
    } else {
      await firstRejection(await Promise.allSettled(instances.map((instance) => waitInstanceReady(hosting, instance))));
    }
  }
  await input.activate();
  const retired = [...slots.flatMap((slot) => (slot.old ? [slot.old] : [])), ...leftovers];
  await teardownAppRuntimes(retired);
  return { previousDeploymentId: previousId };
}

/**
 * A release failed: its instances go (deleting a box commits its volume),
 * traffic returns to the release before it, and that release gets back every
 * machine it lost (a replaced machine restarts on its own volume).
 */
export async function abandonRelease(appId: string, deploymentId: string, hosting = new AppHostingProvider()): Promise<void> {
  await teardownAppRuntimes(await releaseInstances(deploymentId));
  const [app] = await db.select({ active: apps.activeDeploymentId }).from(apps).where(eq(apps.appId, appId)).limit(1);
  if (app?.active !== deploymentId) {
    if (app?.active) await reconcileAppMachines(appId, { hosting, exceptDeploymentId: deploymentId });
    return;
  }
  const previousId = await previousReleaseId(appId, deploymentId);
  await pointTraffic(appId, previousId, deploymentId);
  await event(deploymentId, 'traffic_reverted', 'Traffic returned to the previous release', { previousDeploymentId: previousId }, undefined, 'warn');
  if (previousId) await reconcileAppMachines(appId, { hosting, exceptDeploymentId: deploymentId });
}

/** Machine ids of a group's volumes whose machine has no live instance: a new machine takes these first. */
async function orphanedMachineIds(appId: string, group: string): Promise<string[]> {
  const rows = await db.select({ machineId: appVolumes.machineId }).from(appVolumes).where(and(
    eq(appVolumes.appId, appId),
    eq(appVolumes.processGroup, group),
    isNull(appVolumes.deletedAt),
    isNull(appVolumes.attachedRuntimeId),
    sql`${qualifiedColumn(appVolumes.machineId)} is not null and not exists (
      select 1 from ${appRuntimes} r
      where coalesce(r.machine_id, r.runtime_id) = ${qualifiedColumn(appVolumes.machineId)} and r.status not in ('deleted', 'error')
    )`,
  )).orderBy(asc(appVolumes.createdAt));
  return rows.map((row) => row.machineId!);
}

/**
 * Bring the active release to `apps.scale`: create the machines a group is
 * missing (a mounted group takes its unattached volumes first, else gets new
 * empty ones), destroy the ones above the count (their volumes stay), and
 * destroy machines of groups the release no longer has. Skipped while a
 * release rolls out (it plans machines itself) and for a stopped App.
 */
export async function reconcileAppMachines(
  appId: string,
  options: { hosting?: AppHostingProvider; exceptDeploymentId?: string } = {},
): Promise<{ created: number; destroyed: number; skipped?: string }> {
  const hosting = options.hosting ?? new AppHostingProvider();
  const [app] = await db.select().from(apps).where(and(eq(apps.appId, appId), isNull(apps.deletedAt))).limit(1);
  if (!app?.activeDeploymentId) return { created: 0, destroyed: 0, skipped: 'no_release' };
  const [deployment] = await db.select().from(appDeployments).where(eq(appDeployments.deploymentId, app.activeDeploymentId)).limit(1);
  if (!deployment || deployment.status !== 'ready' || deployment.hostingType === 'static') {
    return { created: 0, destroyed: 0, skipped: 'not_running' };
  }
  const [rolling] = await db.select({ id: appDeployments.deploymentId }).from(appDeployments).where(and(
    eq(appDeployments.appId, appId),
    inArray(appDeployments.status, [...LIVE_RELEASE_STATUSES]),
    options.exceptDeploymentId ? ne(appDeployments.deploymentId, options.exceptDeploymentId) : undefined,
  )).limit(1);
  if (rolling) return { created: 0, destroyed: 0, skipped: 'deploying' };

  const config = releaseConfigOf(deployment, app);
  const instances = (await releaseInstances(deployment.deploymentId)).filter((instance) => instance.processGroup !== RELEASE_COMMAND_GROUP);
  let created = 0;
  let destroyed = 0;
  const destroy = async (instance: InstanceRow) => {
    await destroyInstance(hosting, instance, appMountFor(config, instance.processGroup)?.destination ?? null);
    destroyed += 1;
  };
  let env: ReleaseEnvironment | null = null;
  for (const group of Object.keys(config.processes)) {
    const own = instances.filter((instance) => instance.processGroup === group);
    const target = groupScale(app.scale, group);
    for (const extra of own.slice(target).reverse()) await destroy(extra);
    if (own.length >= target || app.desiredState !== 'running') continue;
    env ??= await releaseEnvironment(app, deployment);
    const reuse = appMountFor(config, group) ? await orphanedMachineIds(appId, group) : [];
    for (let index = own.length; index < target; index++) {
      const instance = await createInstance({
        hosting, app, deployment, config, env, group, machineId: reuse.shift() ?? randomUUID(),
      });
      await waitInstanceReady(hosting, instance);
      created += 1;
    }
  }
  for (const stray of instances.filter((instance) => !(instance.processGroup in config.processes))) await destroy(stray);
  if (created + destroyed > 0) {
    await event(deployment.deploymentId, 'machines_reconciled', `Scaled: ${created} created, ${destroyed} destroyed`, { created, destroyed });
  }
  return { created, destroyed };
}

/**
 * The release command (`deploy.release_command`): once per release, before
 * any machine changes, in a temporary machine from the new image with the
 * release's env and secrets and no volume. The box is always
 * removed. Returns the exit code and output; the caller fails the release on a
 * non-zero exit.
 */
export async function runReleaseCommand(input: {
  hosting: AppHostingProvider;
  app: AppRow;
  deployment: DeploymentRow;
  config: AppReleaseConfig;
  env: ReleaseEnvironment;
  command: string;
  timeoutMs?: number;
}): Promise<{ exitCode: number; output: string }> {
  const { hosting, app, deployment, config, env } = input;
  const provider = deployment.hostingProvider as SandboxProviderName;
  const runtimeSpec = deployment.runtimeSpec as Record<string, unknown>;
  const group = Object.keys(config.processes)[0]!;
  const runtimeId = randomUUID();
  const machine = machineSize(app, config, group, provider);
  // The supervisor runs a sleep, not the App: the temporary machine serves nothing.
  const spec = { ...runtimeSpec, command: ['sleep', 'infinity'], target_port: 0, mounts: [], checks: [] };
  const handle = await hosting.createRuntime({
    provider,
    runtimeId,
    accountId: app.accountId,
    userId: deployment.createdBy,
    name: `app-${app.routeKey}-v${deployment.version}-release`,
    snapshotName: deployment.providerBuildId!,
    machine,
    envVars: { ...env.env, KORTIX_APP_SPEC: JSON.stringify(spec) },
  });
  const [row] = await db.insert(appRuntimes).values({
    runtimeId,
    deploymentId: deployment.deploymentId,
    accountId: app.accountId,
    provider,
    externalId: handle.externalId,
    status: 'running',
    controlTokenHash: handle.controlTokenHash,
    machineId: runtimeId,
    processGroup: RELEASE_COMMAND_GROUP,
    startedAt: new Date(),
    metadata: { ...handle.metadata, machine, role: 'release_command' },
  }).returning().catch(async (error) => {
    await hosting.remove(provider, handle.externalId).catch(() => {});
    throw error;
  });
  try {
    await startComputeSession({
      sandboxId: runtimeId, accountId: app.accountId, actorUserId: deployment.createdBy, provider,
      spec: { ...machine, gpuCount: 0 },
      workloadType: 'app', appRuntimeId: runtimeId,
      metadata: { deploymentId: deployment.deploymentId, appId: app.appId, role: 'release_command' },
    });
    const workdir = typeof runtimeSpec.workdir === 'string' ? runtimeSpec.workdir : null;
    const quoted = workdir ? `cd '${workdir.replace(/'/g, `'\\''`)}' && ` : '';
    const result = await hosting.exec(provider, handle.externalId, ['sh', '-c', `${quoted}${input.command}`], input.timeoutMs ?? 300_000);
    return { exitCode: result.exitCode, output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim() };
  } finally {
    await teardownAppRuntimes([row!]).catch((error) => {
      logger.error('[apps] release command machine removal failed', { runtimeId, error: String(error) });
    });
  }
}
