/**
 * Always-on Apps against a real PostgreSQL: the idle reaper leaves them
 * running, the keep-alive pass restarts a stopped one, and the monthly budget
 * stops any running App that reached it. Provider calls are recorded fakes.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { accounts, appArtifacts, appDeployments, appRuntimes, apps, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';

const stops: string[] = [];
const wakes: string[] = [];
const ensured: string[] = [];
mock.module('./hosting', () => ({
  AppHostingProvider: class {
    async stop(_provider: string, externalId: string) { stops.push(externalId); }
    async ensureRunning(_provider: string, externalId: string) { ensured.push(externalId); }
  },
}));
mock.module('./public-proxy-runtime', () => ({
  ensureAppRuntimeRunning: async (loaded: { runtime: { externalId: string } }) => {
    wakes.push(loaded.runtime.externalId);
    return loaded.runtime;
  },
}));
mock.module('./deployment-worker', () => ({ enqueueCurrentAppRuntime: async () => false }));

const { db } = await import('../shared/db');
const { runAppIdleReaper, runAppKeepAlive } = await import('./idle-reaper');

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000e901';
const PROJECT_ID = '00000000-0000-4000-a000-00000000e902';
const ARTIFACT_ID = '00000000-0000-4000-a000-00000000e903';
const ALWAYS = { app: '00000000-0000-4000-a000-00000000e911', dep: '00000000-0000-4000-a000-00000000e921', rt: '00000000-0000-4000-a000-00000000e931' };
const DEMAND = { app: '00000000-0000-4000-a000-00000000e912', dep: '00000000-0000-4000-a000-00000000e922', rt: '00000000-0000-4000-a000-00000000e932' };

async function cleanup(): Promise<void> {
  await db.update(apps).set({ activeDeploymentId: null }).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(apps).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(appArtifacts).where(eq(appArtifacts.projectId, PROJECT_ID));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function seed(ids: typeof ALWAYS, alwaysOn: boolean, runtime: { status: string; idleDeadlineAt: Date | null }, budget = '1000.00') {
  await db.insert(apps).values({
    appId: ids.app, accountId: ACCOUNT_ID, projectId: PROJECT_ID,
    slug: `keep-alive-${ids.app.slice(-3)}`, name: 'keep-alive', routeKey: `eeeeeeeeeeee${ids.app.slice(-4)}`,
    alwaysOn, monthlyBudgetUsd: budget,
  });
  await db.insert(appDeployments).values({
    deploymentId: ids.dep, appId: ids.app, artifactId: ARTIFACT_ID, version: 1, status: 'ready',
    sourceKind: 'dockerfile', hostingType: 'sandbox', hostingProvider: 'platinum', runtimeVersion: 'test', createdBy: PROJECT_ID,
  });
  await db.update(apps).set({ activeDeploymentId: ids.dep }).where(eq(apps.appId, ids.app));
  await db.insert(appRuntimes).values({
    runtimeId: ids.rt, deploymentId: ids.dep, accountId: ACCOUNT_ID, provider: 'platinum',
    externalId: `box-${ids.rt.slice(-3)}`, status: runtime.status, controlTokenHash: 'test', idleDeadlineAt: runtime.idleDeadlineAt,
  });
}

const status = async (runtimeId: string) =>
  (await db.select({ status: appRuntimes.status }).from(appRuntimes).where(eq(appRuntimes.runtimeId, runtimeId)))[0]?.status;

withDb('always-on Apps', () => {
  beforeEach(async () => {
    stops.length = 0;
    wakes.length = 0;
    ensured.length = 0;
    await cleanup();
    await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'keep-alive test' });
    await db.insert(projects).values({
      projectId: PROJECT_ID, accountId: ACCOUNT_ID, name: 'keep-alive test',
      repoUrl: 'https://example.test/keep-alive.git', metadata: { experimental: { apps: true } },
    });
    await db.insert(appArtifacts).values({ artifactId: ARTIFACT_ID, accountId: ACCOUNT_ID, projectId: PROJECT_ID, kind: 'archive', status: 'ready' });
  });
  afterEach(cleanup);

  test('the idle reaper stops an idle on-demand App and leaves an idle always-on App running', async () => {
    const past = new Date(Date.now() - 60_000);
    await seed(ALWAYS, true, { status: 'running', idleDeadlineAt: past });
    await seed(DEMAND, false, { status: 'running', idleDeadlineAt: past });

    await runAppIdleReaper();

    expect(await status(DEMAND.rt)).toBe('stopped');
    expect(await status(ALWAYS.rt)).toBe('running');
    expect(stops).toEqual([`box-${DEMAND.rt.slice(-3)}`]);
  });

  test('keep-alive starts a stopped always-on App, and leaves a stopped on-demand App for its next request', async () => {
    await seed(ALWAYS, true, { status: 'stopped', idleDeadlineAt: null });
    await seed(DEMAND, false, { status: 'stopped', idleDeadlineAt: null });

    const result = await runAppKeepAlive(new Date(), true);

    expect(result?.started).toBe(1);
    expect(wakes).toEqual([`box-${ALWAYS.rt.slice(-3)}`]);
  });

  test('a running App at its monthly budget is stopped, whatever its mode', async () => {
    await seed(ALWAYS, true, { status: 'running', idleDeadlineAt: null }, '0.00');

    const result = await runAppKeepAlive(new Date(), true);

    expect(result?.budgetStopped).toBe(1);
    expect(await status(ALWAYS.rt)).toBe('stopped');
    expect(stops).toEqual([`box-${ALWAYS.rt.slice(-3)}`]);
  });
});

withDb('always-on Apps: the provider is the truth', () => {
  beforeEach(async () => {
    stops.length = 0;
    wakes.length = 0;
    ensured.length = 0;
    await cleanup();
    await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'keep-alive test' });
    await db.insert(projects).values({
      projectId: PROJECT_ID, accountId: ACCOUNT_ID, name: 'keep-alive test',
      repoUrl: 'https://example.test/keep-alive.git', metadata: { experimental: { apps: true } },
    });
    await db.insert(appArtifacts).values({ artifactId: ARTIFACT_ID, accountId: ACCOUNT_ID, projectId: PROJECT_ID, kind: 'archive', status: 'ready' });
  });
  afterEach(cleanup);

  test('an always-on runtime recorded running is confirmed with the provider (a VM that died is started); on-demand is left alone', async () => {
    await seed(ALWAYS, true, { status: 'running', idleDeadlineAt: null });
    await seed(DEMAND, false, { status: 'running', idleDeadlineAt: new Date(Date.now() + 600_000) });

    const result = await runAppKeepAlive(new Date(), true);

    expect(ensured).toEqual([`box-${ALWAYS.rt.slice(-3)}`]);
    expect(result?.confirmed).toBe(1);
  });
});
