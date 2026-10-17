import { beforeEach, expect, mock, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import type { App, AppDisplay, AppReleaseConfig, AppServiceSummary, CreateAppDeploymentInput, UpdateAppInput } from './apps';
import {
  createAppVolume,
  createAppVolumeSnapshot,
  destroyAppMachine,
  destroyAppVolume,
  execInApp,
  forkAppVolume,
  listAppMachines,
  listAppVolumeSnapshots,
  listAppVolumes,
  restartAppMachine,
  restoreAppVolume,
  scaleApp,
  startAppMachine,
  stopAppMachine,
  updateAppVolume,
  type AppExecResult,
  type AppMachine,
  type AppVolume,
  type AppVolumeSnapshot,
} from './apps-fleet';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let responses: Array<{ status?: number; body: unknown }> = [];

beforeEach(() => {
  calls = [];
  responses = [];
  configureKortix({ backendUrl: 'http://backend.test/v1', getToken: async () => 'token' });
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawBody = init?.body;
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: typeof rawBody === 'string' ? JSON.parse(rawBody) : undefined });
    const response = responses.shift() ?? { body: {} };
    return new Response(JSON.stringify(response.body), { status: response.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
});

const last = () => calls.at(-1)!;
const base = 'http://backend.test/v1/projects/p1/apps/a1';

const machine: AppMachine = {
  machine_id: 'm1', instance_id: 'i1', process_group: 'app', state: 'started',
  release: { deployment_id: 'd1', version: 3 }, vm: { cpu: 1, memory_gb: 1, disk_gb: 10 },
  volume: { volume_id: 'v1', name: 'data' }, created_at: 't', started_at: 't', stopped_at: null,
};
const volume: AppVolume = {
  volume_id: 'v1', name: 'data', process_group: 'app', machine_id: 'm1', size_gb: 10, status: 'ready',
  attached: true, snapshot_retention_days: 5, created_at: 't',
};

test('machines: list, start, stop, restart and destroy hit the machine routes', async () => {
  responses.push({ body: { machines: [machine] } }, { body: { machines: [machine] } }, { body: { machines: [] } }, { body: { machines: [] } }, { body: { machines: [] } });
  expect(await listAppMachines('p1', 'a1')).toEqual([machine]);
  expect(last()).toMatchObject({ url: `${base}/machines`, method: 'GET' });
  await startAppMachine('p1', 'a1', 'm1');
  expect(last()).toMatchObject({ url: `${base}/machines/m1/start`, method: 'POST' });
  await stopAppMachine('p1', 'a1', 'm1');
  expect(last()).toMatchObject({ url: `${base}/machines/m1/stop`, method: 'POST' });
  await restartAppMachine('p1', 'a1', 'm1');
  expect(last()).toMatchObject({ url: `${base}/machines/m1/restart`, method: 'POST' });
  await destroyAppMachine('p1', 'a1', 'm1');
  expect(last()).toMatchObject({ url: `${base}/machines/m1`, method: 'DELETE' });
});

test('scale and exec send the documented bodies', async () => {
  responses.push({ status: 202, body: { scale: { app: 3 }, machines: [] } }, { body: { machine_id: 'm1', exit_code: 0, stdout: 'ok', stderr: '', truncated: false } });
  expect((await scaleApp('p1', 'a1', { app: 3 })).scale).toEqual({ app: 3 });
  expect(last()).toMatchObject({ url: `${base}/scale`, method: 'PUT', body: { count: { app: 3 } } });
  const result: AppExecResult = await execInApp('p1', 'a1', { command: ['ls', '-la'], timeout_s: 30 });
  expect(result.stdout).toBe('ok');
  expect(last()).toMatchObject({ url: `${base}/exec`, method: 'POST', body: { command: ['ls', '-la'], timeout_s: 30 } });
});

test('scale with newVolumes accepts one new, empty volume per machine; without it the body is unchanged', async () => {
  responses.push({ status: 202, body: { scale: { app: 2 }, machines: [] } }, { status: 202, body: { scale: { app: 1 }, machines: [] } });
  await scaleApp('p1', 'a1', { app: 2 }, { newVolumes: true });
  expect(last()).toMatchObject({ url: `${base}/scale`, method: 'PUT', body: { count: { app: 2 }, new_volumes: true } });
  await scaleApp('p1', 'a1', { app: 1 });
  expect(last().body).toEqual({ count: { app: 1 } });
});

test('a volume carries its live use and last commit (null when the provider did not answer)', () => {
  const live: AppVolume = { ...volume, size_gb: 100, used_bytes: 1_048_576, last_commit_at: '2026-10-14T16:00:00.000Z' };
  const usedIsNullable: Equal<AppVolume['used_bytes'], number | null | undefined> = true;
  const commitIsNullable: Equal<AppVolume['last_commit_at'], string | null | undefined> = true;
  expect([live.used_bytes, usedIsNullable, commitIsNullable]).toEqual([1_048_576, true, true]);
});

test('volumes: list, create, extend, destroy (with confirm), snapshots, restore and fork', async () => {
  const snapshot: AppVolumeSnapshot = { snapshot_id: 'daily-20261010', kind: 'daily', commit_id: 'c1', created_at: 't' };
  responses.push(
    { body: { volumes: [volume] } }, { status: 201, body: volume }, { body: { ...volume, size_gb: 20 } }, { body: {} },
    { body: { snapshots: [snapshot] } }, { status: 201, body: snapshot }, { status: 202, body: volume }, { status: 201, body: { ...volume, name: 'copy' } },
  );
  expect(await listAppVolumes('p1', 'a1')).toEqual([volume]);
  expect(last().url).toBe(`${base}/volumes`);
  await createAppVolume('p1', 'a1', { name: 'data', size_gb: 10 });
  expect(last()).toMatchObject({ method: 'POST', body: { name: 'data', size_gb: 10 } });
  expect((await updateAppVolume('p1', 'a1', 'v1', { size_gb: 20 })).size_gb).toBe(20);
  expect(last()).toMatchObject({ url: `${base}/volumes/v1`, method: 'PATCH', body: { size_gb: 20 } });
  await destroyAppVolume('p1', 'a1', 'v1', 'data');
  expect(last()).toMatchObject({ url: `${base}/volumes/v1?confirm=data`, method: 'DELETE' });
  expect(await listAppVolumeSnapshots('p1', 'a1', 'v1')).toEqual([snapshot]);
  expect(last().url).toBe(`${base}/volumes/v1/snapshots`);
  await createAppVolumeSnapshot('p1', 'a1', 'v1');
  expect(last()).toMatchObject({ url: `${base}/volumes/v1/snapshots`, method: 'POST' });
  await restoreAppVolume('p1', 'a1', 'v1', 'daily-20261010');
  expect(last()).toMatchObject({ url: `${base}/volumes/v1/restore`, method: 'POST', body: { snapshot_id: 'daily-20261010' } });
  expect((await forkAppVolume('p1', 'a1', 'v1', { name: 'copy' })).name).toBe('copy');
  expect(last()).toMatchObject({ url: `${base}/volumes/v1/fork`, method: 'POST', body: { name: 'copy' } });
});

test('the App and its inputs carry labels, scale, services, machines, volumes, config; deploy takes a config', () => {
  const labels: Equal<App['labels'], string[] | undefined> = true;
  const scale: Equal<App['scale'], Record<string, number> | undefined> = true;
  const services: Equal<App['services'], AppServiceSummary[] | undefined> = true;
  const config: Equal<App['config'], AppReleaseConfig | null | undefined> = true;
  const updateLabels: Equal<UpdateAppInput['labels'], string[] | undefined> = true;
  const deployConfig: CreateAppDeploymentInput = {
    artifact_id: 'a', source: { kind: 'oci_image', image: 'x', port: 3210, command: ['/start.sh'] },
    config: { mounts: [{ source: 'data', destination: '/data' }], services: [{ name: 'site', internal_port: 3211, access: 'public' }] },
  };
  expect([labels, scale, services, config, updateLabels]).toEqual([true, true, true, true, true]);
  expect(deployConfig.config?.mounts?.[0]?.destination).toBe('/data');
});

test('the App and its update input carry display: listed, preview (live | none), parent', () => {
  const display: Equal<App['display'], AppDisplay | undefined> = true;
  const updateDisplay: Equal<UpdateAppInput['display'], AppDisplay | undefined> = true;
  const tab: AppDisplay = { parent: 'crm-data', preview: 'none', listed: false };
  expect([display, updateDisplay, tab.parent]).toEqual([true, true, 'crm-data']);
});
