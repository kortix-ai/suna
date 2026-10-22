/**
 * The machines, scale, exec and volumes of an App. An App
 * runs one or more machines per process group; a machine may mount a volume
 * that outlives every release. See `docs/sdk/apps` for the model.
 */
import { backendApi } from '../../http/api-client';
import { unwrap } from './shared';

export type AppMachineState = 'started' | 'starting' | 'stopped' | 'stopping' | 'provisioning';

export interface AppMachine {
  /** Stable across releases: a new release's instance of this machine keeps the id and the volume. */
  machine_id: string;
  /** The box running it now; a new release replaces it. */
  instance_id: string;
  process_group: string;
  state: AppMachineState;
  release: { deployment_id: string; version: number };
  vm: { cpu: number; memory_gb: number; disk_gb: number };
  volume: { volume_id: string; name: string | null } | null;
  created_at: string;
  started_at: string | null;
  stopped_at: string | null;
}

export interface AppVolume {
  volume_id: string;
  /** The mount `source` it serves. */
  name: string;
  process_group: string;
  /** The machine it belongs to; null for an unattached (pre-created or forked) volume. */
  machine_id: string | null;
  /** The size the provider allots at create (fixed: a volume cannot grow). */
  size_gb: number;
  /** Bytes in use, read live from the provider; null when unknown. */
  used_bytes?: number | null;
  /** When the provider last committed the volume's contents; null when unknown. */
  last_commit_at?: string | null;
  status: 'creating' | 'ready' | 'destroying' | 'destroyed' | 'error';
  /** A machine mounts it now (one writer at a time). */
  attached: boolean;
  snapshot_retention_days: number;
  created_at: string;
}

export interface AppVolumeSnapshot {
  snapshot_id: string;
  /** `daily` (automatic, kept `snapshot_retention_days`), `manual`, or `final` (taken when the volume was destroyed). */
  kind: 'daily' | 'manual' | 'final';
  commit_id: string;
  created_at: string;
}

export interface AppExecInput {
  command: string[];
  /** A machine of the App; default a running machine of the active release. */
  machine_id?: string;
  /** 1-300 s, default 60. */
  timeout_s?: number;
}

export interface AppExecResult {
  machine_id: string;
  exit_code: number;
  /** Up to 1 MiB each; `truncated` says when one was cut. */
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface CreateAppVolumeInput {
  name: string;
  size_gb: number;
  process_group?: string;
  snapshot_retention_days?: number;
}

const app = (projectId: string, appId: string) => `/projects/${projectId}/apps/${appId}`;

export async function listAppMachines(projectId: string, appId: string): Promise<AppMachine[]> {
  return unwrap(await backendApi.get<{ machines: AppMachine[] }>(`${app(projectId, appId)}/machines`), 'Failed to list machines').machines;
}

async function machineAction(projectId: string, appId: string, machineId: string, action: 'start' | 'stop' | 'restart'): Promise<AppMachine[]> {
  return unwrap(
    await backendApi.post<{ machines: AppMachine[] }>(`${app(projectId, appId)}/machines/${machineId}/${action}`, {}),
    `Failed to ${action} the machine`,
  ).machines;
}

export const startAppMachine = (projectId: string, appId: string, machineId: string) => machineAction(projectId, appId, machineId, 'start');
export const stopAppMachine = (projectId: string, appId: string, machineId: string) => machineAction(projectId, appId, machineId, 'stop');
export const restartAppMachine = (projectId: string, appId: string, machineId: string) => machineAction(projectId, appId, machineId, 'restart');

/** Destroy a machine: its volume stays, and its group runs one machine fewer. */
export async function destroyAppMachine(projectId: string, appId: string, machineId: string): Promise<AppMachine[]> {
  return unwrap(
    await backendApi.delete<{ machines: AppMachine[] }>(`${app(projectId, appId)}/machines/${machineId}`),
    'Failed to destroy the machine',
  ).machines;
}

/**
 * Machines per process group (0-20). Applied in the background. A group with a
 * volume runs one machine unless `newVolumes` accepts that each new machine
 * gets its own, empty volume (and serves different data).
 */
export async function scaleApp(
  projectId: string,
  appId: string,
  count: Record<string, number>,
  options: { newVolumes?: boolean } = {},
): Promise<{ scale: Record<string, number>; machines: AppMachine[] }> {
  return unwrap(
    await backendApi.put<{ scale: Record<string, number>; machines: AppMachine[] }>(
      `${app(projectId, appId)}/scale`,
      { count, ...(options.newVolumes ? { new_volumes: true } : {}) },
    ),
    'Failed to scale the App',
  );
}

/** Run one command in a machine. Project admins only. */
export async function execInApp(projectId: string, appId: string, input: AppExecInput): Promise<AppExecResult> {
  return unwrap(await backendApi.post<AppExecResult>(`${app(projectId, appId)}/exec`, input), 'Failed to run the command');
}

export async function listAppVolumes(projectId: string, appId: string): Promise<AppVolume[]> {
  return unwrap(await backendApi.get<{ volumes: AppVolume[] }>(`${app(projectId, appId)}/volumes`), 'Failed to list volumes').volumes;
}

export async function createAppVolume(projectId: string, appId: string, input: CreateAppVolumeInput): Promise<AppVolume> {
  return unwrap(await backendApi.post<AppVolume>(`${app(projectId, appId)}/volumes`, input), 'Failed to create the volume');
}

/** Change a volume's snapshot retention. A `size_gb` above its fixed size is refused (`volume_fixed_size`). */
export async function updateAppVolume(
  projectId: string,
  appId: string,
  volumeId: string,
  input: { size_gb?: number; snapshot_retention_days?: number },
): Promise<AppVolume> {
  return unwrap(await backendApi.patch<AppVolume>(`${app(projectId, appId)}/volumes/${volumeId}`, input), 'Failed to update the volume');
}

/** Destroy a volume: `confirmName` must be its name. A final snapshot is kept 7 days. Project admins only. */
export async function destroyAppVolume(projectId: string, appId: string, volumeId: string, confirmName: string): Promise<void> {
  unwrap(
    await backendApi.delete<unknown>(`${app(projectId, appId)}/volumes/${volumeId}?confirm=${encodeURIComponent(confirmName)}`),
    'Failed to destroy the volume',
  );
}

export async function listAppVolumeSnapshots(projectId: string, appId: string, volumeId: string): Promise<AppVolumeSnapshot[]> {
  return unwrap(
    await backendApi.get<{ snapshots: AppVolumeSnapshot[] }>(`${app(projectId, appId)}/volumes/${volumeId}/snapshots`),
    'Failed to list snapshots',
  ).snapshots;
}

export async function createAppVolumeSnapshot(projectId: string, appId: string, volumeId: string): Promise<AppVolumeSnapshot> {
  return unwrap(
    await backendApi.post<AppVolumeSnapshot>(`${app(projectId, appId)}/volumes/${volumeId}/snapshots`, {}),
    'Failed to take the snapshot',
  );
}

/** Restore a volume to a snapshot; its machine stops and comes back on it. Project admins only. */
export async function restoreAppVolume(projectId: string, appId: string, volumeId: string, snapshotId: string): Promise<AppVolume> {
  return unwrap(
    await backendApi.post<AppVolume>(`${app(projectId, appId)}/volumes/${volumeId}/restore`, { snapshot_id: snapshotId }),
    'Failed to restore the volume',
  );
}

/** A new, unattached volume from a snapshot (or the current contents). */
export async function forkAppVolume(
  projectId: string,
  appId: string,
  volumeId: string,
  input: { name: string; snapshot_id?: string },
): Promise<AppVolume> {
  return unwrap(await backendApi.post<AppVolume>(`${app(projectId, appId)}/volumes/${volumeId}/fork`, input), 'Failed to fork the volume');
}
