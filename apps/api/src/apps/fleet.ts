/**
 * The machines of an App, as the HTTP surface sees them (`machines`,
 * `scale`, `exec`): list, start, stop, restart and destroy one machine, set the
 * machine count per process group, run one command in a machine, and restore a
 * volume (stop its machine, restore, bring the machine back on it). Plain
 * values in, plain values out; ./fleet-routes.ts is the HTTP layer.
 */
import { appDeployments, appRuntimes, appVolumes, apps } from '@kortix/db';
import { appMountFor } from '@kortix/shared/app-config';
import { and, asc, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { type SandboxProviderName } from '../config';
import { logger } from '../lib/logger';
import { db } from '../shared/db';
import { AppHostingProvider, instanceMachine } from './hosting';
import {
  RELEASE_COMMAND_GROUP,
  destroyInstance,
  machineIdOf,
  reconcileAppMachines,
  stopInstance,
  type InstanceRow,
} from './machines';
import { ensureAppRuntimeRunning } from './public-proxy-runtime';
import { releaseConfigOf } from './release-config';
import { getAppVolume, restoreVolumeSnapshot } from './volumes';

type AppRow = typeof apps.$inferSelect;
type DeploymentRow = typeof appDeployments.$inferSelect;

/** Machines a group may run (`kortix apps scale count`). */
export const MAX_GROUP_SCALE = 20;
/** Output kept from one `exec`, per stream. */
const EXEC_OUTPUT_BYTES = 1024 * 1024;

export class AppFleetError extends Error {
  constructor(readonly status: 400 | 404 | 409, readonly code: string, message: string) {
    super(message);
    this.name = 'AppFleetError';
  }
}

async function activeRelease(app: AppRow): Promise<DeploymentRow> {
  const [release] = app.activeDeploymentId
    ? await db.select().from(appDeployments).where(eq(appDeployments.deploymentId, app.activeDeploymentId)).limit(1)
    : [];
  if (!release || release.hostingType === 'static') {
    throw new AppFleetError(409, 'app_no_machines', 'This App runs no machines: deploy a server release first.');
  }
  return release;
}

/** Every live instance of the App (any release), newest first; the release command's box is not a machine. */
async function liveInstances(appId: string): Promise<Array<{ instance: InstanceRow; release: DeploymentRow }>> {
  return db.select({ instance: appRuntimes, release: appDeployments })
    .from(appRuntimes)
    .innerJoin(appDeployments, eq(appDeployments.deploymentId, appRuntimes.deploymentId))
    .where(and(
      eq(appDeployments.appId, appId),
      notInArray(appRuntimes.status, ['deleted', 'error']),
      notInArray(appRuntimes.processGroup, [RELEASE_COMMAND_GROUP]),
    ))
    .orderBy(asc(appRuntimes.processGroup), desc(appRuntimes.createdAt));
}

/** Machine states, from instance statuses. */
function machineState(status: string): string {
  switch (status) {
    case 'running': return 'started';
    case 'provisioning':
    case 'starting': return 'starting';
    default: return status;
  }
}

export async function listAppMachines(app: AppRow) {
  const rows = await liveInstances(app.appId);
  const volumeIds = rows.map((row) => row.instance.volumeId).filter((id): id is string => !!id);
  const volumes = volumeIds.length
    ? await db.select({ volumeId: appVolumes.volumeId, name: appVolumes.name }).from(appVolumes).where(inArray(appVolumes.volumeId, volumeIds))
    : [];
  const volumeName = new Map(volumes.map((volume) => [volume.volumeId, volume.name]));
  return rows.map(({ instance, release }) => {
    const machine = instanceMachine(instance, app);
    return {
      machine_id: machineIdOf(instance),
      instance_id: instance.runtimeId,
      process_group: instance.processGroup,
      state: machineState(instance.status),
      release: { deployment_id: release.deploymentId, version: release.version },
      vm: { cpu: machine.cpuCores, memory_gb: machine.memoryGb, disk_gb: machine.diskGb },
      volume: instance.volumeId ? { volume_id: instance.volumeId, name: volumeName.get(instance.volumeId) ?? null } : null,
      created_at: instance.createdAt.toISOString(),
      started_at: instance.startedAt?.toISOString() ?? null,
      stopped_at: instance.stoppedAt?.toISOString() ?? null,
    };
  });
}

async function machineInstance(app: AppRow, machineId: string): Promise<{ instance: InstanceRow; release: DeploymentRow }> {
  const found = (await liveInstances(app.appId)).find(({ instance }) => machineIdOf(instance) === machineId);
  if (!found) throw new AppFleetError(404, 'machine_not_found', 'Machine not found.');
  return found;
}

export async function startMachine(app: AppRow, machineId: string, hosting = new AppHostingProvider()): Promise<void> {
  const { instance, release } = await machineInstance(app, machineId);
  if (instance.status === 'running') return;
  await ensureAppRuntimeRunning({ app, deployment: release, runtime: instance }, hosting);
}

export async function stopMachine(app: AppRow, machineId: string, hosting = new AppHostingProvider()): Promise<void> {
  const { instance } = await machineInstance(app, machineId);
  if (instance.status === 'stopped') return;
  await stopInstance(hosting, instance);
}

export async function restartMachine(app: AppRow, machineId: string, hosting = new AppHostingProvider()): Promise<void> {
  await stopMachine(app, machineId, hosting);
  const { instance, release } = await machineInstance(app, machineId);
  await ensureAppRuntimeRunning({ app, deployment: release, runtime: instance }, hosting);
}

/** Destroy a machine: its box goes, its volume stays, and its group runs one machine fewer. */
export async function destroyMachine(app: AppRow, machineId: string, hosting = new AppHostingProvider()): Promise<void> {
  const { instance, release } = await machineInstance(app, machineId);
  const mount = appMountFor(releaseConfigOf(release, app), instance.processGroup);
  await destroyInstance(hosting, instance, mount?.destination ?? null);
  const group = instance.processGroup;
  const current = (app.scale as Record<string, number>)[group];
  const remaining = (await liveInstances(app.appId)).filter(({ instance: other }) => other.processGroup === group).length;
  await db.update(apps).set({
    scale: { ...(app.scale as Record<string, number>), [group]: Math.max(0, Math.min(current ?? remaining, remaining)) },
    updatedAt: new Date(),
  }).where(eq(apps.appId, app.appId));
}

/**
 * Set the machine count of process groups and reconcile in the background.
 * A group the active release does not have is refused. A group with a volume
 * runs one machine unless `newVolumes` accepts that every further machine
 * gets its own, empty volume: the machines then serve different data behind
 * one URL, which splits a database (Convex, Postgres, SQLite) in two.
 */
export async function setAppScale(
  app: AppRow,
  counts: Record<string, number>,
  options: { newVolumes?: boolean } = {},
): Promise<Record<string, number>> {
  const release = await activeRelease(app);
  const releaseConfig = releaseConfigOf(release, app);
  const groups = Object.keys(releaseConfig.processes);
  for (const [group, count] of Object.entries(counts)) {
    if (!groups.includes(group)) {
      throw new AppFleetError(400, 'process_group_unknown', `The active release has no process group "${group}" (it has ${groups.join(', ')}).`);
    }
    if (!Number.isInteger(count) || count < 0 || count > MAX_GROUP_SCALE) {
      throw new AppFleetError(400, 'scale_out_of_range', `A group runs 0 to ${MAX_GROUP_SCALE} machines.`);
    }
    if (count > 1 && !options.newVolumes && appMountFor(releaseConfig, group)) {
      throw new AppFleetError(
        409,
        'volume_single_machine',
        `Process group "${group}" mounts a volume, so it runs one machine. A second machine would get its own empty ` +
          'volume and serve different data. Scale up the machine size instead, or pass new_volumes to accept separate volumes.',
      );
    }
  }
  const scale = { ...(app.scale as Record<string, number>), ...counts };
  await db.update(apps).set({ scale, updatedAt: new Date() }).where(eq(apps.appId, app.appId));
  void reconcileAppMachines(app.appId).catch((error) => {
    logger.error('[apps] scale reconcile failed', { appId: app.appId, error: String(error) });
  });
  return scale;
}

function clip(text: string): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= EXEC_OUTPUT_BYTES) return { text, truncated: false };
  return { text: bytes.subarray(0, EXEC_OUTPUT_BYTES).toString(), truncated: true };
}

/** Run one command in a machine (a running one of the active release unless `machineId` names one). */
export async function execInMachine(
  app: AppRow,
  input: { command: string[]; machineId?: string; timeoutS?: number },
  hosting = new AppHostingProvider(),
) {
  if (input.command.length === 0) throw new AppFleetError(400, 'command_required', 'command needs at least one word.');
  let target: InstanceRow;
  if (input.machineId) {
    target = (await machineInstance(app, input.machineId)).instance;
  } else {
    const release = await activeRelease(app);
    const running = (await liveInstances(app.appId))
      .find(({ instance }) => instance.deploymentId === release.deploymentId && instance.status === 'running');
    if (!running) throw new AppFleetError(409, 'machine_not_running', 'No machine of the active release is running; start one first.');
    target = running.instance;
  }
  if (target.status !== 'running') throw new AppFleetError(409, 'machine_not_running', 'That machine is not running; start it first.');
  const timeoutMs = Math.min(300, Math.max(1, input.timeoutS ?? 60)) * 1000;
  const result = await hosting.exec(target.provider as SandboxProviderName, target.externalId, input.command, timeoutMs);
  const stdout = clip(result.stdout ?? '');
  const stderr = clip(result.stderr ?? '');
  return {
    machine_id: machineIdOf(target),
    exit_code: result.exitCode,
    stdout: stdout.text,
    stderr: stderr.text,
    truncated: stdout.truncated || stderr.truncated,
  };
}

/**
 * Restore a volume to a snapshot: its machine is destroyed (stop, commit,
 * detach), the volume is restored, and the machine is recreated on it in the
 * background. A volume no machine mounts is restored in place.
 */
export async function restoreAppVolume(app: AppRow, volumeId: string, snapshotId: string, hosting = new AppHostingProvider()): Promise<void> {
  const volume = await getAppVolume(app.appId, volumeId);
  if (volume.attachedRuntimeId) {
    const [holder] = await db.select({ instance: appRuntimes, release: appDeployments })
      .from(appRuntimes)
      .innerJoin(appDeployments, eq(appDeployments.deploymentId, appRuntimes.deploymentId))
      .where(eq(appRuntimes.runtimeId, volume.attachedRuntimeId))
      .limit(1);
    if (holder) {
      const mount = appMountFor(releaseConfigOf(holder.release, app), holder.instance.processGroup);
      await destroyInstance(hosting, holder.instance, mount?.destination ?? null);
    }
  }
  await restoreVolumeSnapshot(app.appId, volumeId, snapshotId);
  void reconcileAppMachines(app.appId, { hosting }).catch((error) => {
    logger.error('[apps] machine recreate after a volume restore failed', { appId: app.appId, volumeId, error: String(error) });
  });
}
