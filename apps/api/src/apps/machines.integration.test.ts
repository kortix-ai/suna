/**
 * Machines and volumes, against a real PostgreSQL: release
 * strategies (bluegreen, rolling with a volume), the single-writer handover
 * of a volume between a machine's instances, a failed rolling release that
 * returns traffic and the machine's volume to the release before it, and
 * scale reconcile. Provider calls are recorded fakes; rows, locks and the
 * deploy pointer are real.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { accounts, appArtifacts, appDeployments, appLinks, appRuntimes, appVolumes, apps, projects } from '@kortix/db';
import { resolveAppReleaseConfig, type AppReleaseConfig } from '@kortix/shared/app-config';
import { and, asc, eq, inArray, notInArray } from 'drizzle-orm';

process.env.KORTIX_APPS_WORKER_ENABLED = 'false';

/** Every provider call, in order. */
const calls: string[] = [];
let createdBoxes = 0;
let failReadyFor = new Set<string>();

const realHosting = await import('./hosting');
mock.module('./hosting', () => ({
  ...realHosting,
  AppHostingProvider: class {
    async createRuntime(input: { runtimeId: string; volumes?: Record<string, { volume: string }> }) {
      createdBoxes += 1;
      const externalId = `box-${createdBoxes}`;
      const mounts = Object.entries(input.volumes ?? {}).map(([path, spec]) => `${path}=${spec.volume}`);
      calls.push(`create ${externalId}${mounts.length ? ` mount ${mounts.join(',')}` : ''}`);
      return { externalId, controlTokenHash: `hash-${input.runtimeId}`, metadata: {} };
    }
    async waitUntilReady(_provider: string, externalId: string) {
      calls.push(`ready? ${externalId}`);
      if (failReadyFor.has(externalId)) throw new Error('kortix-appd failed: exit 1');
    }
    async stop(_provider: string, externalId: string) { calls.push(`stop ${externalId}`); }
    async start(_provider: string, externalId: string) { calls.push(`start ${externalId}`); }
  },
}));
const realProviders = await import('../platform/providers');
mock.module('../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({ remove: async (externalId: string) => { calls.push(`remove ${externalId}`); } }),
}));
mock.module('./volume-store', () => ({
  AppVolumeStoreError: class extends Error {},
  appVolumeStore: {
    open: async (name: string) => { calls.push(`volume open ${name}`); },
    detach: async (externalId: string, path: string) => { calls.push(`detach ${externalId} ${path}`); },
    tag: async (_name: string, tag: string) => ({ name: tag, commit_id: 'c1', created_at: new Date().toISOString() }),
    info: async () => ({ size_gb: 50, used_bytes: 1024, last_commit_at: null }),
    tags: async () => [],
    untag: async () => {},
    restore: async () => {},
    fork: async () => {},
    remove: async () => {},
  },
}));
const realTokens = await import('./tokens');
mock.module('./tokens', () => ({ ...realTokens, appAuthEnv: async () => ({}) }));
const realSecrets = await import('../projects/secrets');
mock.module('../projects/secrets', () => ({ ...realSecrets, listResolvedProjectSecrets: async () => [] }));
const realMetering = await import('../billing/services/compute-metering');
mock.module('../billing/services/compute-metering', () => ({
  ...realMetering,
  startComputeSession: async () => {},
  pauseComputeSession: async () => {},
}));

const { db } = await import('../shared/db');
const { AppHostingProvider } = await import('./hosting');
const machines = await import('./machines');
const volumes = await import('./volumes');
const fleet = await import('./fleet');

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000f101';
const PROJECT_ID = '00000000-0000-4000-a000-00000000f102';
const ARTIFACT_ID = '00000000-0000-4000-a000-00000000f103';
const APP_ID = '00000000-0000-4000-a000-00000000f104';
const USER_ID = '00000000-0000-4000-a000-00000000f105';
const PROVIDER = 'platinum';

async function cleanup(): Promise<void> {
  await db.update(apps).set({ activeDeploymentId: null }).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(apps).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(appArtifacts).where(eq(appArtifacts.projectId, PROJECT_ID));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function seedApp(scale: Record<string, number> = {}): Promise<void> {
  await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'machines test' });
  await db.insert(projects).values({
    projectId: PROJECT_ID, accountId: ACCOUNT_ID, name: 'machines test',
    repoUrl: 'https://example.test/machines.git', metadata: { experimental: { apps: true } },
  });
  await db.insert(appArtifacts).values({ artifactId: ARTIFACT_ID, accountId: ACCOUNT_ID, projectId: PROJECT_ID, kind: 'archive', status: 'ready' });
  await db.insert(apps).values({
    appId: APP_ID, accountId: ACCOUNT_ID, projectId: PROJECT_ID, slug: 'machines', name: 'machines',
    routeKey: 'f1f1f1f1f1f1f1f1', alwaysOn: true, scale, createdBy: USER_ID,
  });
}

async function release(version: number, config: AppReleaseConfig, status = 'provisioning') {
  const [row] = await db.insert(appDeployments).values({
    appId: APP_ID, artifactId: ARTIFACT_ID, version, status, sourceKind: 'dockerfile', hostingType: 'sandbox',
    hostingProvider: PROVIDER, providerBuildId: `img-${version}`, runtimeVersion: 'test', createdBy: USER_ID,
    buildSpec: { environment: {}, secrets: {} }, runtimeSpec: { target_port: 3000 }, config, strategy: config.deploy.strategy,
  }).returning();
  return row!;
}

async function appRow() {
  const [row] = await db.select().from(apps).where(eq(apps.appId, APP_ID)).limit(1);
  return row!;
}

const liveInstances = (deploymentId: string) => db.select().from(appRuntimes)
  .where(and(eq(appRuntimes.deploymentId, deploymentId), notInArray(appRuntimes.status, ['deleted', 'error'])))
  .orderBy(asc(appRuntimes.createdAt));

/** Deploy a release the way the worker does: roll it out, mark it ready on activation. */
async function deploy(config: AppReleaseConfig, version: number) {
  const app = await appRow();
  const deployment = await release(version, config);
  const env = await machines.releaseEnvironment(app, deployment);
  await machines.rollOutRelease({
    hosting: new AppHostingProvider(), app, deployment, config, env,
    activate: async () => {
      await db.update(appDeployments).set({ status: 'ready' }).where(eq(appDeployments.deploymentId, deployment.deploymentId));
      await machines.pointTraffic(APP_ID, deployment.deploymentId);
    },
  });
  return deployment;
}

const stateless = resolveAppReleaseConfig({ port: 3000 });
const stateful = resolveAppReleaseConfig({ port: 3000, mounts: [{ source: 'data', destination: '/data', initial_size_gb: 10 }] });

withDb('machines and volumes — real PostgreSQL', () => {
  beforeEach(async () => {
    calls.length = 0;
    createdBoxes = 0;
    failReadyFor = new Set();
    await cleanup();
  });
  afterEach(cleanup);

  test('bluegreen, two machines: the new release keeps both machine ids, all are healthy before traffic moves, then the old instances go', async () => {
    await seedApp({ app: 2 });
    const v1 = await deploy(stateless, 1);
    const first = await liveInstances(v1.deploymentId);
    expect(first.map((instance) => instance.status)).toEqual(['running', 'running']);
    calls.length = 0;

    const v2 = await deploy(stateless, 2);
    const second = await liveInstances(v2.deploymentId);
    expect(second.map((instance) => instance.machineId).sort()).toEqual(first.map((instance) => instance.machineId).sort());
    expect((await appRow()).activeDeploymentId).toBe(v2.deploymentId);
    expect(await liveInstances(v1.deploymentId)).toEqual([]);
    // Both new instances are created and healthy before either old instance is removed.
    const lastReady = Math.max(calls.indexOf('ready? box-3'), calls.indexOf('ready? box-4'));
    expect(lastReady).toBeLessThan(calls.indexOf('remove box-1'));
    expect(lastReady).toBeLessThan(calls.indexOf('remove box-2'));
  });

  test('rolling with a volume: the old instance stops and detaches BEFORE the new one mounts the same volume (single writer); the machine keeps its id and volume', async () => {
    await seedApp();
    const v1 = await deploy(stateful, 1);
    const [old] = await liveInstances(v1.deploymentId);
    const [volume] = await db.select().from(appVolumes).where(eq(appVolumes.appId, APP_ID));
    expect(volume!.attachedRuntimeId).toBe(old!.runtimeId);
    expect(old!.volumeId).toBe(volume!.volumeId);
    calls.length = 0;

    const v2 = await deploy(stateful, 2);
    const [next] = await liveInstances(v2.deploymentId);
    expect(calls.slice(0, 4)).toEqual([
      'stop box-1',
      'detach box-1 /data',
      'remove box-1',
      `create box-2 mount /data=${volume!.externalId}`,
    ]);
    expect(next!.machineId).toBe(old!.machineId);
    expect(next!.volumeId).toBe(volume!.volumeId);
    const [after] = await db.select().from(appVolumes).where(eq(appVolumes.volumeId, volume!.volumeId));
    expect(after!.attachedRuntimeId).toBe(next!.runtimeId);
    expect(await db.select().from(appVolumes).where(eq(appVolumes.appId, APP_ID))).toHaveLength(1);
  });

  test('the volume lock refuses a second writer until the first lets go', async () => {
    await seedApp();
    await deploy(stateful, 1);
    const [volume] = await db.select().from(appVolumes).where(eq(appVolumes.appId, APP_ID));
    const other = '00000000-0000-4000-a000-00000000f1ff';
    await expect(volumes.acquireVolume(volume!.volumeId, other)).rejects.toMatchObject({ status: 409, code: 'volume_attached' });
    await volumes.releaseVolume(volume!.volumeId, volume!.attachedRuntimeId!);
    await volumes.acquireVolume(volume!.volumeId, other);
    const [taken] = await db.select().from(appVolumes).where(eq(appVolumes.volumeId, volume!.volumeId));
    expect(taken!.attachedRuntimeId).toBe(other);
  });

  test('a rolling release that never gets healthy: traffic stays on v1 and v1 gets its machine back on the same volume', async () => {
    await seedApp();
    const v1 = await deploy(stateful, 1);
    const [old] = await liveInstances(v1.deploymentId);
    const [volume] = await db.select().from(appVolumes).where(eq(appVolumes.appId, APP_ID));
    failReadyFor = new Set(['box-2']);

    const app = await appRow();
    const v2 = await release(2, stateful);
    await expect(machines.rollOutRelease({
      hosting: new AppHostingProvider(), app, deployment: v2, config: stateful,
      env: await machines.releaseEnvironment(app, v2), activate: async () => {},
    })).rejects.toThrow('kortix-appd failed');
    await db.update(appDeployments).set({ status: 'failed' }).where(eq(appDeployments.deploymentId, v2.deploymentId));
    await machines.abandonRelease(APP_ID, v2.deploymentId, new AppHostingProvider());

    expect((await appRow()).activeDeploymentId).toBe(v1.deploymentId);
    expect(await liveInstances(v2.deploymentId)).toEqual([]);
    const [restored] = await liveInstances(v1.deploymentId);
    expect(restored!.machineId).toBe(old!.machineId);
    expect(restored!.volumeId).toBe(volume!.volumeId);
    expect(restored!.status).toBe('running');
    const [after] = await db.select().from(appVolumes).where(eq(appVolumes.volumeId, volume!.volumeId));
    expect(after!.attachedRuntimeId).toBe(restored!.runtimeId);
  });

  test('scale reconcile: up creates machines (a mounted group gets one new volume each), down destroys the newest and keeps their volumes', async () => {
    await seedApp();
    const v1 = await deploy(stateful, 1);
    await db.update(apps).set({ scale: { app: 3 } }).where(eq(apps.appId, APP_ID));
    expect(await machines.reconcileAppMachines(APP_ID, { hosting: new AppHostingProvider() })).toEqual({ created: 2, destroyed: 0 });
    expect(await liveInstances(v1.deploymentId)).toHaveLength(3);
    expect(await db.select().from(appVolumes).where(eq(appVolumes.appId, APP_ID))).toHaveLength(3);

    await db.update(apps).set({ scale: { app: 1 } }).where(eq(apps.appId, APP_ID));
    expect(await machines.reconcileAppMachines(APP_ID, { hosting: new AppHostingProvider() })).toEqual({ created: 0, destroyed: 2 });
    expect(await liveInstances(v1.deploymentId)).toHaveLength(1);
    const kept = await db.select().from(appVolumes).where(eq(appVolumes.appId, APP_ID));
    expect(kept).toHaveLength(3);
    expect(kept.filter((row) => row.attachedRuntimeId)).toHaveLength(1);
  });

  test('a machine gets KORTIX_USES_URL_<SLUG> for every live App its App uses (a server reaches a backend without the browser binding)', async () => {
    await seedApp();
    const BACKEND_ID = '00000000-0000-4000-a000-00000000f106';
    const GONE_ID = '00000000-0000-4000-a000-00000000f107';
    await db.insert(apps).values([
      { appId: BACKEND_ID, accountId: ACCOUNT_ID, projectId: PROJECT_ID, slug: 'crm-data', name: 'crm-data', routeKey: 'f2f2f2f2f2f2f2f2', createdBy: USER_ID },
      { appId: GONE_ID, accountId: ACCOUNT_ID, projectId: PROJECT_ID, slug: 'old-db', name: 'old-db', routeKey: 'f3f3f3f3f3f3f3f3', createdBy: USER_ID, deletedAt: new Date() },
    ]);
    await db.insert(appLinks).values([{ appId: APP_ID, usesAppId: BACKEND_ID }, { appId: APP_ID, usesAppId: GONE_ID }]);
    const env = (await machines.releaseEnvironment(await appRow(), await release(1, stateless))).env;
    expect(env.KORTIX_USES_URL_CRM_DATA).toContain('f2f2f2f2f2f2f2f2');
    expect(env.KORTIX_USES_URL_OLD_DB).toBeUndefined();
  });

  test('scale: a group with a volume runs one machine unless new_volumes accepts one new, empty volume per machine', async () => {
    await seedApp();
    await deploy(stateful, 1);
    await expect(fleet.setAppScale(await appRow(), { app: 2 })).rejects.toMatchObject({ status: 409, code: 'volume_single_machine' });
    expect((await appRow()).scale).toEqual({});
    expect(await fleet.setAppScale(await appRow(), { app: 2 }, { newVolumes: true })).toEqual({ app: 2 });
    expect(await fleet.setAppScale(await appRow(), { app: 1 })).toEqual({ app: 1 });
  });

  test('scale: a group without a volume scales freely', async () => {
    await seedApp();
    await deploy(stateless, 1);
    expect(await fleet.setAppScale(await appRow(), { app: 3 })).toEqual({ app: 3 });
  });

  test('extend: a volume is the size the provider allots; a larger size is refused, never recorded', async () => {
    await seedApp();
    await deploy(stateful, 1);
    const [volume] = await db.select().from(appVolumes).where(eq(appVolumes.appId, APP_ID));
    expect(volume!.sizeGb).toBe(10);
    await expect(volumes.updateAppVolume(APP_ID, volume!.volumeId, { sizeGb: 60 })).rejects.toMatchObject({ status: 400, code: 'volume_fixed_size' });
    expect((await db.select().from(appVolumes).where(eq(appVolumes.volumeId, volume!.volumeId)))[0]!.sizeGb).toBe(10);
    expect((await volumes.updateAppVolume(APP_ID, volume!.volumeId, { sizeGb: 20 })).sizeGb).toBe(50);
    expect((await volumes.updateAppVolume(APP_ID, volume!.volumeId, { retentionDays: 30 })).snapshotRetentionDays).toBe(30);
  });

  test('scaling back up reuses an unattached volume of a gone machine before creating a new one', async () => {
    await seedApp({ app: 2 });
    const v1 = await deploy(stateful, 1);
    await db.update(apps).set({ scale: { app: 1 } }).where(eq(apps.appId, APP_ID));
    await machines.reconcileAppMachines(APP_ID, { hosting: new AppHostingProvider() });
    await db.update(apps).set({ scale: { app: 2 } }).where(eq(apps.appId, APP_ID));
    await machines.reconcileAppMachines(APP_ID, { hosting: new AppHostingProvider() });
    expect(await liveInstances(v1.deploymentId)).toHaveLength(2);
    const rows = await db.select().from(appVolumes).where(eq(appVolumes.appId, APP_ID));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.attachedRuntimeId)).toBe(true);
    const runtimeIds = (await liveInstances(v1.deploymentId)).map((instance) => instance.runtimeId);
    expect(rows.map((row) => row.attachedRuntimeId).sort()).toEqual([...runtimeIds].sort());
    expect(await db.select().from(appRuntimes).where(inArray(appRuntimes.runtimeId, runtimeIds))).toHaveLength(2);
  });
});
