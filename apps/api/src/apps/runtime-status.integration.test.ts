/**
 * App runtime status writes are compare-and-set transitions (real PostgreSQL).
 *
 * The idle reaper claims a runtime (`running -> stopping`), stops the box at
 * the provider, then wrote `stopped` with `WHERE runtime_id = ?` only. A
 * public-proxy wake that leased the row while the provider stop ran (the
 * lease did not check the status) started the box again, and the reaper's
 * late write marked it `stopped` over a running, billing box. The reaper now
 * finishes only its own `stopping` claim, and `deleted` is terminal.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { accounts, appArtifacts, appDeployments, appRuntimes, apps, projects } from '@kortix/db';
import { eq, inArray } from 'drizzle-orm';

process.env.KORTIX_APPS_WORKER_ENABLED = 'false';

/** Runs inside the fake provider stop: a concurrent writer's commit. */
let duringStop: (() => Promise<void>) | null = null;

mock.module('./hosting', () => ({
  AppHostingProvider: class {
    async stop() {
      await duringStop?.();
    }
  },
}));
const realMetering = await import('../billing/services/compute-metering');
const paused: string[] = [];
mock.module('../billing/services/compute-metering', () => ({
  ...realMetering,
  pauseComputeSession: async (runtimeId: string) => {
    paused.push(runtimeId);
  },
}));

const { db } = await import('../shared/db');
const { runAppIdleReaper } = await import('./idle-reaper');
const { transitionAppRuntimes } = await import('./runtime-status');
const { APP_RUNTIME_VERSION } = await import('./deployment-worker');

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000f701';
const PROJECT_ID = '00000000-0000-4000-a000-00000000f702';
const ARTIFACT_ID = '00000000-0000-4000-a000-00000000f703';
const APP_ID = '00000000-0000-4000-a000-00000000f704';
const DEPLOYMENT_ID = '00000000-0000-4000-a000-00000000f705';
const RUNTIME_ID = '00000000-0000-4000-a000-00000000f706';

async function cleanup(): Promise<void> {
  await db.update(apps).set({ activeDeploymentId: null }).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(apps).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(appArtifacts).where(eq(appArtifacts.projectId, PROJECT_ID));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await db.delete(accounts).where(inArray(accounts.accountId, [ACCOUNT_ID]));
}

async function seed(status: string, idleDeadlineAt: Date | null): Promise<void> {
  await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'runtime status test' });
  await db.insert(projects).values({
    projectId: PROJECT_ID, accountId: ACCOUNT_ID, name: 'runtime status test',
    repoUrl: 'https://example.test/runtime-status.git', metadata: { experimental: { apps: true } },
  });
  await db.insert(appArtifacts).values({ artifactId: ARTIFACT_ID, accountId: ACCOUNT_ID, projectId: PROJECT_ID, kind: 'archive', status: 'ready' });
  await db.insert(apps).values({
    appId: APP_ID, accountId: ACCOUNT_ID, projectId: PROJECT_ID,
    slug: 'runtime-status', name: 'runtime-status', routeKey: 'ffffffffffff0001', alwaysOn: false,
  });
  await db.insert(appDeployments).values({
    deploymentId: DEPLOYMENT_ID, appId: APP_ID, artifactId: ARTIFACT_ID, version: 1, status: 'ready',
    sourceKind: 'dockerfile', hostingType: 'sandbox', hostingProvider: 'platinum', runtimeVersion: APP_RUNTIME_VERSION, createdBy: PROJECT_ID,
  });
  await db.update(apps).set({ activeDeploymentId: DEPLOYMENT_ID }).where(eq(apps.appId, APP_ID));
  await db.insert(appRuntimes).values({
    runtimeId: RUNTIME_ID, deploymentId: DEPLOYMENT_ID, accountId: ACCOUNT_ID, provider: 'platinum',
    externalId: 'box-runtime-status', status, controlTokenHash: 'test', idleDeadlineAt,
  });
}

const statusOf = async () =>
  (await db.select({ status: appRuntimes.status }).from(appRuntimes).where(eq(appRuntimes.runtimeId, RUNTIME_ID)))[0]?.status;

withDb('App runtime status transitions', () => {
  beforeEach(async () => {
    duringStop = null;
    paused.length = 0;
    await cleanup();
  });
  afterEach(cleanup);

  test('a wake that leased the row while the idle stop ran keeps it; the reaper closes no meter', async () => {
    await seed('running', new Date(Date.now() - 60_000));
    duringStop = async () => {
      await db
        .update(appRuntimes)
        .set({ status: 'starting', wakeLeaseOwner: 'test-waker', wakeLeaseUntil: new Date(Date.now() + 120_000) })
        .where(eq(appRuntimes.runtimeId, RUNTIME_ID));
    };
    const result = await runAppIdleReaper();
    expect(result.candidates).toBe(1);
    expect(await statusOf()).toBe('starting');
    expect(paused).toEqual([]);
  });

  test('an unraced idle stop still ends stopped and closes the meter', async () => {
    await seed('running', new Date(Date.now() - 60_000));
    const result = await runAppIdleReaper();
    expect(result.stopped).toBe(1);
    expect(await statusOf()).toBe('stopped');
    expect(paused).toEqual([RUNTIME_ID]);
  });

  test('a deleted runtime is never marked running or stopped again', async () => {
    await seed('deleted', null);
    expect(await transitionAppRuntimes('ready', eq(appRuntimes.runtimeId, RUNTIME_ID))).toEqual([]);
    expect(await transitionAppRuntimes('stop', eq(appRuntimes.runtimeId, RUNTIME_ID))).toEqual([]);
    expect(await transitionAppRuntimes('wake', eq(appRuntimes.runtimeId, RUNTIME_ID))).toEqual([]);
    expect(await statusOf()).toBe('deleted');
  });

  test('a wake lease never takes a row the idle reaper is stopping', async () => {
    await seed('stopping', null);
    expect(await transitionAppRuntimes('wake', eq(appRuntimes.runtimeId, RUNTIME_ID))).toEqual([]);
    expect(await statusOf()).toBe('stopping');
  });
});
