/**
 * The App image sweep's database reads, against a real PostgreSQL.
 *
 * The property under test is SQL, not logic (`images.test.ts` covers the
 * logic): which deployments the sweep may delete an image for, which runtimes
 * still pin one, and that a removed runtime is recorded `deleted`. A mocked
 * database cannot prove any of it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, appArtifacts, appDeployments, appRuntimes, apps, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { appDeploymentSnapshotName } from '../snapshots/quota-gc-select';
import {
  appImageReclaimIo,
  reclaimAppDeploymentImages,
  teardownAppRuntimes,
  type AppImageProvider,
} from './images';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000c901';
const PROJECT_ID = '00000000-0000-4000-a000-00000000c902';
const LIVE_APP_ID = '00000000-0000-4000-a000-00000000c903';
const DELETED_APP_ID = '00000000-0000-4000-a000-00000000c904';
const ARTIFACT_ID = '00000000-0000-4000-a000-00000000c905';
// Live App: a superseded rollback target, a failed build whose runtime row
// still exists, an owner-deleted deployment, and a build still in progress.
const READY = '00000000-0000-4000-a000-00000000c911';
const FAILED = '00000000-0000-4000-a000-00000000c912';
const DELETED = '00000000-0000-4000-a000-00000000c913';
const QUEUED = '00000000-0000-4000-a000-00000000c914';
// Deleted App: a former rollback target whose runtime is already gone.
const DELETED_APP_READY = '00000000-0000-4000-a000-00000000c915';
// An image whose deployment lives in another environment's database.
const FOREIGN = '00000000-0000-4000-a000-00000000c9ff';
const READY_RUNTIME = '00000000-0000-4000-a000-00000000c921';
const FAILED_RUNTIME = '00000000-0000-4000-a000-00000000c922';
const GONE_RUNTIME = '00000000-0000-4000-a000-00000000c923';

async function cleanup(): Promise<void> {
  await db.update(apps).set({ activeDeploymentId: null }).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(apps).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(appArtifacts).where(eq(appArtifacts.projectId, PROJECT_ID));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

function deployment(deploymentId: string, appId: string, version: number, status: string, provider: string | null) {
  return {
    deploymentId,
    appId,
    artifactId: ARTIFACT_ID,
    version,
    status,
    sourceKind: 'oci_image',
    hostingType: 'sandbox',
    hostingProvider: provider,
    runtimeVersion: 'test',
    createdBy: PROJECT_ID,
  };
}

function runtime(runtimeId: string, deploymentId: string, status: string) {
  return {
    runtimeId,
    deploymentId,
    accountId: ACCOUNT_ID,
    provider: 'platinum',
    externalId: `box-${runtimeId.slice(-4)}`,
    status,
    controlTokenHash: 'test',
  };
}

function providerWith(images: string[]): AppImageProvider & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    isConfigured: () => true,
    listSnapshots: async () => images.map((name) => ({ name })),
    deleteSnapshot: async (name) => { deleted.push(name); },
  };
}

withDb('App image reclaim — database reads', () => {
  beforeEach(async () => {
    await cleanup();
    await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'app image reclaim test' });
    await db.insert(projects).values({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'app image reclaim test',
      repoUrl: 'https://example.test/app-image-reclaim.git',
      metadata: { experimental: { apps: true } },
    });
    await db.insert(apps).values([
      {
        appId: LIVE_APP_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        slug: 'app-image-reclaim-live',
        name: 'live',
        routeKey: 'cccccccccccccc01',
        desiredState: 'running',
        idleTimeoutSeconds: 300,
        monthlyBudgetUsd: '5.00',
      },
      {
        appId: DELETED_APP_ID,
        accountId: ACCOUNT_ID,
        projectId: PROJECT_ID,
        slug: 'app-image-reclaim-gone',
        name: 'gone',
        routeKey: 'cccccccccccccc02',
        desiredState: 'stopped',
        idleTimeoutSeconds: 300,
        monthlyBudgetUsd: '5.00',
        deletedAt: new Date(),
      },
    ]);
    await db.insert(appArtifacts).values({
      artifactId: ARTIFACT_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      kind: 'oci_image',
      status: 'ready',
      imageReference: 'docker.io/library/nginx:alpine',
    });
    await db.insert(appDeployments).values([
      deployment(READY, LIVE_APP_ID, 1, 'ready', 'platinum'),
      deployment(FAILED, LIVE_APP_ID, 2, 'failed', 'platinum'),
      deployment(DELETED, LIVE_APP_ID, 3, 'deleted', 'platinum'),
      deployment(QUEUED, LIVE_APP_ID, 4, 'queued', null),
      deployment(DELETED_APP_READY, DELETED_APP_ID, 1, 'ready', 'platinum'),
    ]);
    await db.insert(appRuntimes).values([
      runtime(READY_RUNTIME, READY, 'stopped'),
      runtime(FAILED_RUNTIME, FAILED, 'error'),
      runtime(GONE_RUNTIME, DELETED_APP_READY, 'deleted'),
    ]);
  });

  afterEach(cleanup);

  test('only unservable deployments with no remaining runtime are reclaimable, and a foreign id never is', async () => {
    const reclaimable = await appImageReclaimIo.loadReclaimableDeploymentIds([
      READY, FAILED, DELETED, QUEUED, DELETED_APP_READY, FOREIGN,
    ]);
    // FAILED is unservable but its runtime row still exists, so its image may
    // still be pinned: it waits for the runtime teardown.
    expect([...reclaimable].sort()).toEqual([DELETED, DELETED_APP_READY].sort());
  });

  test('a runtime that still pins an unservable deployment is lingering; a rollback target is not', async () => {
    const lingering = await appImageReclaimIo.loadLingeringRuntimes(50);
    expect(lingering.map((row) => row.runtimeId)).toEqual([FAILED_RUNTIME]);
  });

  test('one pass removes the lingering runtime, then deletes exactly the three unservable images', async () => {
    const provider = providerWith([
      READY, FAILED, DELETED, QUEUED, DELETED_APP_READY, FOREIGN,
    ].map(appDeploymentSnapshotName));
    const result = await reclaimAppDeploymentImages({}, {
      ...appImageReclaimIo,
      providers: () => [{ name: 'platinum', adapter: provider }],
      // The real database write; only the provider call is stubbed.
      teardownRuntimes: (runtimes) => teardownAppRuntimes(runtimes, async () => true),
    });

    expect(provider.deleted.sort()).toEqual(
      [FAILED, DELETED, DELETED_APP_READY].map(appDeploymentSnapshotName).sort(),
    );
    expect(result).toMatchObject({ listed: 6, reclaimable: 3, released: 3, runtimesRemoved: 1, errors: 0 });

    const [failedRuntime] = await db.select().from(appRuntimes).where(eq(appRuntimes.runtimeId, FAILED_RUNTIME));
    expect(failedRuntime?.status).toBe('deleted');
    expect(failedRuntime?.stoppedAt).toBeInstanceOf(Date);
    const [readyRuntime] = await db.select().from(appRuntimes).where(eq(appRuntimes.runtimeId, READY_RUNTIME));
    expect(readyRuntime?.status).toBe('stopped');
  });
});
