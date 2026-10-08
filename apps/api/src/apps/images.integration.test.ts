/**
 * The App image sweep's database reads, against a real PostgreSQL.
 *
 * The property under test is SQL, not logic (`images.test.ts` covers the
 * logic): which deployments the sweep may delete an image for, which runtimes
 * still pin one, and that a removed runtime is recorded `deleted`. A mocked
 * database cannot prove any of it.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, appArtifacts, appDeployments, appImages, appRuntimes, apps, projects } from '@kortix/db';
import { eq, like, sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { appDeploymentSnapshotName } from '../snapshots/quota-gc-select';
import { SnapshotInUseError } from '../snapshots/providers/errors';
import {
  appImageReclaimIo,
  claimAppImage,
  markAppImageReady,
  reclaimAppDeploymentImages,
  releaseAppImage,
  releaseDeploymentImage,
  releaseDeploymentImages,
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
  await db.delete(appImages).where(like(appImages.imageName, 'kortix-appimg-test-%'));
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

// Shared images: deployments on two Apps of one account that built from the
// same inputs. The provider is stubbed; every decision is the real SQL.
const SHARED = 'kortix-appimg-test-aaaaaaaaaaaaaaaaaaaaaaaa';
const OTHER_SHARED = 'kortix-appimg-test-bbbbbbbbbbbbbbbbbbbbbbbb';
const SECOND_APP_ID = '00000000-0000-4000-a000-00000000c906';
const BUILDER = '00000000-0000-4000-a000-00000000c931';
const FOLLOWER = '00000000-0000-4000-a000-00000000c932';
const OTHER_APP_DEPLOYMENT = '00000000-0000-4000-a000-00000000c933';
const DELETED_APP_BUILDING = '00000000-0000-4000-a000-00000000c934';
const OWNER_A = 'worker-a';
const OWNER_B = 'worker-b';

function leased(owner: string, ms = 60_000) {
  return { leaseOwner: owner, leaseExpiresAt: new Date(Date.now() + ms) };
}

async function buildIdOf(deploymentId: string): Promise<string | null> {
  const [row] = await db.select({ id: appDeployments.providerBuildId }).from(appDeployments)
    .where(eq(appDeployments.deploymentId, deploymentId));
  return row?.id ?? null;
}

async function imageRow(imageName: string) {
  const [row] = await db.select().from(appImages).where(eq(appImages.imageName, imageName));
  return row ?? null;
}

withDb('Shared App images — claim, reference count, release', () => {
  beforeEach(async () => {
    await cleanup();
    await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'shared app image test' });
    await db.insert(projects).values({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'shared app image test',
      repoUrl: 'https://example.test/shared-app-image.git',
      metadata: { experimental: { apps: true } },
    });
    const app = (appId: string, slug: string, routeKey: string, deletedAt: Date | null = null) => ({
      appId,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      slug,
      name: slug,
      routeKey,
      desiredState: 'running',
      idleTimeoutSeconds: 300,
      monthlyBudgetUsd: '5.00',
      deletedAt,
    });
    await db.insert(apps).values([
      app(LIVE_APP_ID, 'shared-image-one', 'cccccccccccccc11'),
      app(SECOND_APP_ID, 'shared-image-two', 'cccccccccccccc12'),
      app(DELETED_APP_ID, 'shared-image-gone', 'cccccccccccccc13', new Date()),
    ]);
    await db.insert(appArtifacts).values({
      artifactId: ARTIFACT_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      kind: 'oci_image',
      status: 'ready',
      imageReference: `ghcr.io/example/app@sha256:${'0f'.repeat(32)}`,
    });
    await db.insert(appDeployments).values([
      { ...deployment(BUILDER, LIVE_APP_ID, 1, 'building', 'platinum'), ...leased(OWNER_A) },
      { ...deployment(FOLLOWER, LIVE_APP_ID, 2, 'building', 'platinum'), ...leased(OWNER_B) },
      { ...deployment(OTHER_APP_DEPLOYMENT, SECOND_APP_ID, 1, 'building', 'platinum'), ...leased(OWNER_B) },
    ]);
  });

  afterEach(cleanup);

  test('the first deployment builds; a second waits on its live lease, then reuses the ready image', async () => {
    expect(await claimAppImage({ imageName: SHARED, provider: 'platinum', deploymentId: BUILDER, leaseOwner: OWNER_A }))
      .toBe('build');
    expect((await imageRow(SHARED))?.status).toBe('building');
    expect(await buildIdOf(BUILDER)).toBe(SHARED);

    expect(await claimAppImage({ imageName: SHARED, provider: 'platinum', deploymentId: FOLLOWER, leaseOwner: OWNER_B }))
      .toBe('wait');
    // A waiting deployment does not hold the image yet.
    expect(await buildIdOf(FOLLOWER)).toBeNull();

    await markAppImageReady(SHARED, 'platinum');
    expect(await claimAppImage({ imageName: SHARED, provider: 'platinum', deploymentId: FOLLOWER, leaseOwner: OWNER_B }))
      .toBe('reuse');
    expect(await buildIdOf(FOLLOWER)).toBe(SHARED);
    const row = await imageRow(SHARED);
    expect(row?.status).toBe('ready');
    expect(row?.readyAt).toBeInstanceOf(Date);
  });

  test('a builder whose lease lapsed hands the build to the next deployment', async () => {
    await claimAppImage({ imageName: SHARED, provider: 'platinum', deploymentId: BUILDER, leaseOwner: OWNER_A });
    await db.update(appDeployments).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(appDeployments.deploymentId, BUILDER));
    expect(await claimAppImage({ imageName: SHARED, provider: 'platinum', deploymentId: FOLLOWER, leaseOwner: OWNER_B }))
      .toBe('build');
    expect(await buildIdOf(FOLLOWER)).toBe(SHARED);
  });

  test('a claim by a worker that lost the deployment lease fails and records nothing', async () => {
    await expect(claimAppImage({ imageName: SHARED, provider: 'platinum', deploymentId: BUILDER, leaseOwner: 'stale-worker' }))
      .rejects.toThrow('lost deployment lease');
    expect(await imageRow(SHARED)).toBeNull();
  });

  test('an image two Apps share is deleted only after its last deployment is gone', async () => {
    await markAppImageReady(SHARED, 'platinum');
    await db.update(appDeployments).set({ status: 'ready', providerBuildId: SHARED, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(appDeployments.deploymentId, BUILDER));
    await db.update(appDeployments).set({ status: 'ready', providerBuildId: SHARED, leaseOwner: null, leaseExpiresAt: null })
      .where(eq(appDeployments.deploymentId, OTHER_APP_DEPLOYMENT));
    const provider = providerWith([]);

    await db.update(appDeployments).set({ status: 'deleted' }).where(eq(appDeployments.deploymentId, BUILDER));
    expect(await releaseDeploymentImage(
      { deploymentId: BUILDER, hostingProvider: 'platinum', providerBuildId: SHARED },
      () => provider,
    )).toBe('none');
    expect(provider.deleted).toEqual([]);
    expect(await appImageReclaimIo.loadUnusedImages(50, ['platinum'])).toEqual([]);

    // The other App's deployment still has a runtime: it pins the image even once deleted.
    await db.insert(appRuntimes).values(runtime(READY_RUNTIME, OTHER_APP_DEPLOYMENT, 'stopped'));
    await db.update(appDeployments).set({ status: 'deleted' }).where(eq(appDeployments.deploymentId, OTHER_APP_DEPLOYMENT));
    expect(await appImageReclaimIo.loadUnusedImages(50, ['platinum'])).toEqual([]);

    await db.update(appRuntimes).set({ status: 'deleted' }).where(eq(appRuntimes.runtimeId, READY_RUNTIME));
    expect(await appImageReclaimIo.loadUnusedImages(50, ['platinum'])).toEqual([{ imageName: SHARED, provider: 'platinum' }]);
    expect(await releaseDeploymentImage(
      { deploymentId: OTHER_APP_DEPLOYMENT, hostingProvider: 'platinum', providerBuildId: SHARED },
      () => provider,
    )).toBe('released');
    expect(provider.deleted).toEqual([SHARED]);
    expect(await imageRow(SHARED)).toBeNull();
  });

  test('deployments that share an image release it once', async () => {
    await markAppImageReady(SHARED, 'platinum');
    await db.update(appDeployments).set({ status: 'deleted', providerBuildId: SHARED, leaseOwner: null, leaseExpiresAt: null });
    const provider = providerWith([]);
    const summary = await releaseDeploymentImages([
      { deploymentId: BUILDER, hostingProvider: 'platinum', providerBuildId: SHARED },
      { deploymentId: FOLLOWER, hostingProvider: 'platinum', providerBuildId: SHARED },
      { deploymentId: OTHER_APP_DEPLOYMENT, hostingProvider: 'platinum', providerBuildId: SHARED },
    ], () => provider);
    expect(summary).toEqual({ released: 1, pending: 0 });
    expect(provider.deleted).toEqual([SHARED]);
  });

  test('a deleted App still building under a live lease keeps its image; maintenance frees it after', async () => {
    await db.insert(appDeployments).values({
      ...deployment(DELETED_APP_BUILDING, DELETED_APP_ID, 1, 'building', 'platinum'),
      ...leased(OWNER_A),
      providerBuildId: OTHER_SHARED,
    });
    await db.insert(appImages).values({ imageName: OTHER_SHARED, provider: 'platinum', status: 'building' });
    expect(await appImageReclaimIo.loadUnusedImages(50, ['platinum'])).toEqual([]);

    await db.update(appDeployments).set({ status: 'failed', leaseOwner: null, leaseExpiresAt: null })
      .where(eq(appDeployments.deploymentId, DELETED_APP_BUILDING));
    const provider = providerWith([]);
    const result = await reclaimAppDeploymentImages({}, {
      ...appImageReclaimIo,
      providers: () => [{ name: 'platinum', adapter: provider }],
      releaseImage: (image) => releaseDeploymentImage(
        { deploymentId: DELETED_APP_BUILDING, hostingProvider: image.provider, providerBuildId: image.imageName },
        () => provider,
      ),
    });
    expect(provider.deleted).toEqual([OTHER_SHARED]);
    expect(result).toMatchObject({ reclaimable: 1, released: 1, errors: 0 });
    expect(await imageRow(OTHER_SHARED)).toBeNull();
  });

  test('two retrying deployments that both used the image never wait on each other', async () => {
    // BUILDER claimed the build, its lease lapsed, FOLLOWER took it over, then
    // FOLLOWER failed retryably. Both rows keep provider_build_id = SHARED.
    await claimAppImage({ imageName: SHARED, provider: 'platinum', deploymentId: BUILDER, leaseOwner: OWNER_A });
    await db.update(appDeployments).set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(appDeployments.deploymentId, BUILDER));
    expect(await claimAppImage({ imageName: SHARED, provider: 'platinum', deploymentId: FOLLOWER, leaseOwner: OWNER_B }))
      .toBe('build');
    // Both retry at once: each is `building` under a live lease before it claims.
    await db.update(appDeployments).set({ status: 'building', ...leased(OWNER_A) })
      .where(eq(appDeployments.deploymentId, BUILDER));
    const claims = [
      await claimAppImage({ imageName: SHARED, provider: 'platinum', deploymentId: BUILDER, leaseOwner: OWNER_A }),
      await claimAppImage({ imageName: SHARED, provider: 'platinum', deploymentId: FOLLOWER, leaseOwner: OWNER_B }),
    ];
    expect(claims).toEqual(['wait', 'build']);
    expect((await imageRow(SHARED))?.builderDeploymentId).toBe(FOLLOWER);
  });

  test('a release calls the provider with no transaction or image lock held; a claim meanwhile waits', async () => {
    await markAppImageReady(SHARED, 'platinum');
    const seen: Array<{ lockFree: boolean; status: string | undefined; claim: string | null }> = [];
    const provider: AppImageProvider = {
      isConfigured: () => true,
      listSnapshots: async () => [],
      deleteSnapshot: async (name) => {
        const lockFree = await db.transaction(async (tx) => {
          const [row] = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${`app-image:${name}`})) as ok`) as unknown as Array<{ ok: boolean }>;
          return Boolean(row?.ok);
        });
        // Only probe a claim when it cannot block on a lock this release holds.
        const claim = lockFree
          ? await claimAppImage({ imageName: name, provider: 'platinum', deploymentId: FOLLOWER, leaseOwner: OWNER_B })
          : null;
        seen.push({ lockFree, status: (await imageRow(name))?.status, claim });
      },
    };
    expect(await releaseAppImage({ imageName: SHARED, provider: 'platinum' }, () => provider)).toBe('released');
    expect(seen).toEqual([{ lockFree: true, status: 'deleting', claim: 'wait' }]);
    expect(await imageRow(SHARED)).toBeNull();
    expect(await buildIdOf(FOLLOWER)).toBeNull();
  });

  test('an image the provider keeps is restored and rotated, so the next pass reaches the next image', async () => {
    await db.insert(appImages).values([
      { imageName: SHARED, provider: 'platinum', status: 'ready', updatedAt: new Date(Date.now() - 120_000) },
      { imageName: OTHER_SHARED, provider: 'platinum', status: 'ready', updatedAt: new Date(Date.now() - 60_000) },
    ]);
    const deleted: string[] = [];
    const provider: AppImageProvider = {
      isConfigured: () => true,
      listSnapshots: async () => [],
      deleteSnapshot: async (name) => {
        // A sandbox this database already marks deleted still pins the oldest image.
        if (name === SHARED) throw new SnapshotInUseError(name, 1);
        deleted.push(name);
      },
    };
    const io = {
      ...appImageReclaimIo,
      providers: () => [{ name: 'platinum', adapter: provider }],
      releaseImage: (image: { imageName: string; provider: string }) => releaseAppImage(image, () => provider),
    };
    expect(await reclaimAppDeploymentImages({ maxPerPass: 1 }, io)).toMatchObject({ released: 0, pending: 1 });
    expect((await imageRow(SHARED))?.status).toBe('ready');
    expect(await reclaimAppDeploymentImages({ maxPerPass: 1 }, io)).toMatchObject({ released: 1, pending: 0 });
    expect(deleted).toEqual([OTHER_SHARED]);
  });

  test('an image on a provider not configured here never takes a reclaim slot', async () => {
    await db.insert(appImages).values([
      { imageName: SHARED, provider: 'daytona', status: 'ready', updatedAt: new Date(Date.now() - 120_000) },
      { imageName: OTHER_SHARED, provider: 'platinum', status: 'ready', updatedAt: new Date(Date.now() - 60_000) },
    ]);
    const provider = providerWith([]);
    const result = await reclaimAppDeploymentImages({ maxPerPass: 1 }, {
      ...appImageReclaimIo,
      providers: () => [{ name: 'platinum', adapter: provider }],
      releaseImage: (image) => releaseAppImage(image, (name) => {
        if (name !== 'platinum') throw new Error(`provider ${name} is not configured`);
        return provider;
      }),
    });
    expect(provider.deleted).toEqual([OTHER_SHARED]);
    expect(result).toMatchObject({ released: 1, deferred: 0 });
    expect((await imageRow(SHARED))?.provider).toBe('daytona');
  });

  test('a build that finishes after a release removed its row records the image again', async () => {
    await markAppImageReady(SHARED, 'platinum');
    expect((await imageRow(SHARED))?.status).toBe('ready');
    await db.delete(appImages).where(eq(appImages.imageName, SHARED));
    await markAppImageReady(SHARED, 'platinum');
    expect((await imageRow(SHARED))?.status).toBe('ready');
  });
});
