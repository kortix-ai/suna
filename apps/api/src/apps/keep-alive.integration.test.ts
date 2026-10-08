/**
 * Always-on Apps against a real PostgreSQL: the idle reaper leaves them
 * running; keep-alive asks the provider about each one, stamps compute
 * liveness, restarts a dead one through the wake gate, stops an App whose
 * account cannot pay or whose budget is spent, and queues supervisor
 * refreshes at a bounded rate without re-queuing a failed one. Provider
 * calls and the billing admission answer are recorded fakes; the deployment
 * queue is real.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { accounts, appArtifacts, appDeploymentEvents, appDeployments, appRuntimes, apps, projects } from '@kortix/db';
import { and, eq, inArray } from 'drizzle-orm';

process.env.KORTIX_APPS_WORKER_ENABLED = 'false';

const stops: string[] = [];
const wakes: string[] = [];
const renewals: string[] = [];
const alive: Array<{ runtimeId: string; at: Date }> = [];
/** Provider status by external id; unset means running. */
let providerStatus: Record<string, string> = {};
let unfundedAccounts = new Set<string>();

mock.module('./hosting', () => ({
  AppHostingProvider: class {
    async stop(_provider: string, externalId: string) { stops.push(externalId); }
    async providerStatus(_provider: string, externalId: string) { return providerStatus[externalId] ?? 'running'; }
    async renewLifecycle(_provider: string, externalId: string) { renewals.push(externalId); }
  },
}));
// The wake gate is real: a start runs assertAppComputeAllowed first.
mock.module('./public-proxy-runtime', () => ({
  ensureAppRuntimeRunning: async (loaded: { app: typeof apps.$inferSelect; runtime: { runtimeId: string; externalId: string } }) => {
    const { assertAppComputeAllowed } = await import('./limits');
    await assertAppComputeAllowed(loaded.app, { excludeRuntimeId: loaded.runtime.runtimeId });
    wakes.push(loaded.runtime.externalId);
    return loaded.runtime;
  },
}));
const realGate = await import('../billing/services/billing-gate');
mock.module('../billing/services/billing-gate', () => ({
  ...realGate,
  checkBillingAdmission: async (accountId: string) => unfundedAccounts.has(accountId)
    ? {
        ok: false, reason: 'insufficient_credits', balance: 0, message: 'Insufficient credits',
        billingModel: 'credits', hasSubscription: false, billingState: 'unfunded',
      }
    : { ok: true },
}));
const realMetering = await import('../billing/services/compute-metering');
mock.module('../billing/services/compute-metering', () => ({
  ...realMetering,
  markComputeSessionAlive: async (runtimeId: string, at: Date) => { alive.push({ runtimeId, at }); },
  pauseComputeSession: async () => {},
}));

const { db } = await import('../shared/db');
const { runAppIdleReaper, runAppKeepAlive, KEEP_ALIVE_REFRESHES_PER_PASS } = await import('./idle-reaper');
const { APP_RUNTIME_VERSION, REFRESH_RETRY_AFTER_MS } = await import('./deployment-worker');

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000e901';
const PROJECT_ID = '00000000-0000-4000-a000-00000000e902';
const ARTIFACT_ID = '00000000-0000-4000-a000-00000000e903';
const OTHER_ACCOUNT_ID = '00000000-0000-4000-a000-00000000e904';
const OTHER_PROJECT_ID = '00000000-0000-4000-a000-00000000e905';
const OTHER_ARTIFACT_ID = '00000000-0000-4000-a000-00000000e906';
const ids = (n: number) => ({
  app: `00000000-0000-4000-a000-0000000e${String(100 + n).padStart(4, '0')}`,
  dep: `00000000-0000-4000-a000-0000000e${String(200 + n).padStart(4, '0')}`,
  rt: `00000000-0000-4000-a000-0000000e${String(300 + n).padStart(4, '0')}`,
});
const ALWAYS = ids(1);
const DEMAND = ids(2);
const box = (id: { rt: string }) => `box-${id.rt.slice(-3)}`;

async function cleanup(): Promise<void> {
  for (const projectId of [PROJECT_ID, OTHER_PROJECT_ID]) {
    await db.update(apps).set({ activeDeploymentId: null }).where(eq(apps.projectId, projectId));
    await db.delete(apps).where(eq(apps.projectId, projectId));
    await db.delete(appArtifacts).where(eq(appArtifacts.projectId, projectId));
    await db.delete(projects).where(eq(projects.projectId, projectId));
  }
  await db.delete(accounts).where(inArray(accounts.accountId, [ACCOUNT_ID, OTHER_ACCOUNT_ID]));
}

async function seedTenant(accountId: string, projectId: string, artifactId: string): Promise<void> {
  await db.insert(accounts).values({ accountId, name: 'keep-alive test' });
  await db.insert(projects).values({
    projectId, accountId, name: 'keep-alive test',
    repoUrl: 'https://example.test/keep-alive.git', metadata: { experimental: { apps: true } },
  });
  await db.insert(appArtifacts).values({ artifactId, accountId, projectId, kind: 'archive', status: 'ready' });
}

interface SeedOptions {
  alwaysOn: boolean;
  status: string;
  idleDeadlineAt?: Date | null;
  budget?: string;
  provider?: string;
  runtimeVersion?: string;
  accountId?: string;
  projectId?: string;
  artifactId?: string;
}

async function seed(id: ReturnType<typeof ids>, options: SeedOptions) {
  const accountId = options.accountId ?? ACCOUNT_ID;
  const artifactId = options.artifactId ?? ARTIFACT_ID;
  const provider = options.provider ?? 'platinum';
  await db.insert(apps).values({
    appId: id.app, accountId, projectId: options.projectId ?? PROJECT_ID,
    slug: `keep-alive-${id.app.slice(-3)}`, name: 'keep-alive', routeKey: `eeeeeeeeeeee${id.app.slice(-4)}`,
    alwaysOn: options.alwaysOn, monthlyBudgetUsd: options.budget ?? '1000.00',
  });
  await db.insert(appDeployments).values({
    deploymentId: id.dep, appId: id.app, artifactId, version: 1, status: 'ready',
    sourceKind: 'dockerfile', hostingType: 'sandbox', hostingProvider: provider,
    runtimeVersion: options.runtimeVersion ?? APP_RUNTIME_VERSION, createdBy: PROJECT_ID,
  });
  await db.update(apps).set({ activeDeploymentId: id.dep }).where(eq(apps.appId, id.app));
  await db.insert(appRuntimes).values({
    runtimeId: id.rt, deploymentId: id.dep, accountId, provider,
    externalId: box(id), status: options.status, controlTokenHash: 'test', idleDeadlineAt: options.idleDeadlineAt ?? null,
  });
}

const status = async (runtimeId: string) =>
  (await db.select({ status: appRuntimes.status }).from(appRuntimes).where(eq(appRuntimes.runtimeId, runtimeId)))[0]?.status;

const systemDeployments = (appId: string) => db.select().from(appDeployments)
  .where(and(eq(appDeployments.appId, appId), eq(appDeployments.actorType, 'system')));

function reset(): void {
  stops.length = 0;
  wakes.length = 0;
  renewals.length = 0;
  alive.length = 0;
  providerStatus = {};
  unfundedAccounts = new Set();
}

withDb('always-on Apps', () => {
  beforeEach(async () => {
    reset();
    await cleanup();
    await seedTenant(ACCOUNT_ID, PROJECT_ID, ARTIFACT_ID);
  });
  afterEach(cleanup);

  test('the idle reaper stops an idle on-demand App and leaves an idle always-on App running', async () => {
    const past = new Date(Date.now() - 60_000);
    await seed(ALWAYS, { alwaysOn: true, status: 'running', idleDeadlineAt: past });
    await seed(DEMAND, { alwaysOn: false, status: 'running', idleDeadlineAt: past });

    await runAppIdleReaper();

    expect(await status(DEMAND.rt)).toBe('stopped');
    expect(await status(ALWAYS.rt)).toBe('running');
    expect(stops).toEqual([box(DEMAND)]);
  });

  test('keep-alive starts a stopped always-on App through the wake gate, and leaves a stopped on-demand App for its next request', async () => {
    await seed(ALWAYS, { alwaysOn: true, status: 'stopped' });
    await seed(DEMAND, { alwaysOn: false, status: 'stopped' });

    const result = await runAppKeepAlive(new Date(), true);

    expect(result?.started).toBe(1);
    expect(wakes).toEqual([box(ALWAYS)]);
  });

  test('a running App at its monthly budget is stopped, whatever its mode, and the stop is recorded on its deployment', async () => {
    await seed(ALWAYS, { alwaysOn: true, status: 'running', budget: '0.00' });

    const result = await runAppKeepAlive(new Date(), true);

    expect(result?.budgetStopped).toBe(1);
    expect(await status(ALWAYS.rt)).toBe('stopped');
    expect(stops).toEqual([box(ALWAYS)]);
    const events = await db.select({ type: appDeploymentEvents.type, level: appDeploymentEvents.level })
      .from(appDeploymentEvents).where(eq(appDeploymentEvents.deploymentId, ALWAYS.dep));
    expect(events).toEqual([{ type: 'app_stopped_budget', level: 'warn' }]);
    // The gate refuses the restart, so it stays stopped.
    expect(wakes).toEqual([]);
  });
});

withDb('always-on Apps: the provider is the truth, and liveness is stamped', () => {
  beforeEach(async () => {
    reset();
    await cleanup();
    await seedTenant(ACCOUNT_ID, PROJECT_ID, ARTIFACT_ID);
  });
  afterEach(cleanup);

  test('a running always-on runtime with no traffic is confirmed with the provider and its compute liveness stamped at the pass time; on-demand is left alone', async () => {
    await seed(ALWAYS, { alwaysOn: true, status: 'running' });
    await seed(DEMAND, { alwaysOn: false, status: 'running', idleDeadlineAt: new Date(Date.now() + 600_000) });
    const now = new Date();

    const result = await runAppKeepAlive(now, true);

    expect(result?.confirmed).toBe(1);
    expect(alive).toEqual([{ runtimeId: ALWAYS.rt, at: now }]);
    expect(await status(ALWAYS.rt)).toBe('running');
    // Platinum runs an always-on App persistent: no renewal needed.
    expect(renewals).toEqual([]);
  });

  test('on Daytona and E2B the provider idle timer is renewed every pass', async () => {
    await seed(ALWAYS, { alwaysOn: true, status: 'running', provider: 'daytona' });

    await runAppKeepAlive(new Date(), true);

    expect(renewals).toEqual([box(ALWAYS)]);
  });

  test('a row that says running for a VM the provider stopped is corrected and restarted through the wake gate', async () => {
    await seed(ALWAYS, { alwaysOn: true, status: 'running' });
    providerStatus[box(ALWAYS)] = 'stopped';

    const result = await runAppKeepAlive(new Date(), true);

    expect(result?.lost).toBe(1);
    expect(result?.started).toBe(1);
    expect(wakes).toEqual([box(ALWAYS)]);
    expect(alive).toEqual([]);
  });

  test('a provider that does not answer changes nothing; the next pass asks again', async () => {
    await seed(ALWAYS, { alwaysOn: true, status: 'running' });
    providerStatus[box(ALWAYS)] = 'unknown';

    const result = await runAppKeepAlive(new Date(), true);

    expect(result).toMatchObject({ confirmed: 0, lost: 0, started: 0 });
    expect(await status(ALWAYS.rt)).toBe('running');
    expect(wakes).toEqual([]);
  });
});

withDb('always-on Apps: an account that cannot pay', () => {
  beforeEach(async () => {
    reset();
    await cleanup();
    await seedTenant(ACCOUNT_ID, PROJECT_ID, ARTIFACT_ID);
    await seedTenant(OTHER_ACCOUNT_ID, OTHER_PROJECT_ID, OTHER_ARTIFACT_ID);
  });
  afterEach(cleanup);

  test('keep-alive stops every running App of an unfunded account, records why, and does not restart it; a funded account keeps running', async () => {
    await seed(ALWAYS, { alwaysOn: true, status: 'running' });
    await seed(DEMAND, { alwaysOn: false, status: 'running', idleDeadlineAt: new Date(Date.now() + 600_000) });
    const FUNDED = ids(3);
    await seed(FUNDED, {
      alwaysOn: true, status: 'running',
      accountId: OTHER_ACCOUNT_ID, projectId: OTHER_PROJECT_ID, artifactId: OTHER_ARTIFACT_ID,
    });
    unfundedAccounts.add(ACCOUNT_ID);

    const result = await runAppKeepAlive(new Date(), true);

    expect(result?.unfundedStopped).toBe(2);
    expect(await status(ALWAYS.rt)).toBe('stopped');
    expect(await status(DEMAND.rt)).toBe('stopped');
    expect(await status(FUNDED.rt)).toBe('running');
    expect(stops.sort()).toEqual([box(ALWAYS), box(DEMAND)].sort());
    const events = await db.select({ type: appDeploymentEvents.type }).from(appDeploymentEvents)
      .where(eq(appDeploymentEvents.deploymentId, ALWAYS.dep));
    expect(events.map((row) => row.type)).toEqual(['app_stopped_unfunded']);
    // The always-on pass tried the start; the wake gate refused it.
    expect(wakes).toEqual([]);
  });
});

withDb('always-on Apps: supervisor refreshes', () => {
  beforeEach(async () => {
    reset();
    await cleanup();
    await seedTenant(ACCOUNT_ID, PROJECT_ID, ARTIFACT_ID);
  });
  afterEach(cleanup);

  test('an API release that changes only SANDBOX_VERSION queues no refresh', async () => {
    const releaseOnly = APP_RUNTIME_VERSION.replace(/^[^:]*:/, 'some-older-release:');
    expect(releaseOnly).not.toBe(APP_RUNTIME_VERSION);
    await seed(ALWAYS, { alwaysOn: true, status: 'running', runtimeVersion: releaseOnly });

    const result = await runAppKeepAlive(new Date(), true);

    expect(result?.refreshed).toBe(0);
    expect(await systemDeployments(ALWAYS.app)).toEqual([]);
  });

  test(`a new supervisor refreshes at most ${KEEP_ALIVE_REFRESHES_PER_PASS} always-on Apps per pass`, async () => {
    const total = KEEP_ALIVE_REFRESHES_PER_PASS + 2;
    for (let n = 10; n < 10 + total; n += 1) {
      await seed(ids(n), { alwaysOn: true, status: 'running', runtimeVersion: 'older:appd-0000000000000000' });
    }

    const result = await runAppKeepAlive(new Date(), true);

    expect(result?.refreshed).toBe(KEEP_ALIVE_REFRESHES_PER_PASS);
    expect(result?.refreshDeferred).toBe(2);
    const queued = await db.select().from(appDeployments)
      .where(and(eq(appDeployments.actorType, 'system'), eq(appDeployments.status, 'queued')));
    expect(queued.length).toBe(KEEP_ALIVE_REFRESHES_PER_PASS);
    expect(new Set(queued.map((row) => row.runtimeVersion))).toEqual(new Set([APP_RUNTIME_VERSION]));
  });

  test('a refresh that failed deterministically is never queued again for the same artifact and supervisor', async () => {
    await seed(ALWAYS, { alwaysOn: true, status: 'running', runtimeVersion: 'older:appd-0000000000000000' });
    await db.insert(appDeployments).values({
      appId: ALWAYS.app, artifactId: ARTIFACT_ID, version: 2, status: 'failed', errorCode: 'invalid_site',
      failedAt: new Date(Date.now() - 2 * REFRESH_RETRY_AFTER_MS), sourceKind: 'dockerfile', hostingType: 'sandbox',
      runtimeVersion: APP_RUNTIME_VERSION, createdBy: PROJECT_ID, actorType: 'system',
    });

    for (let pass = 0; pass < 3; pass += 1) {
      expect((await runAppKeepAlive(new Date(), true))?.refreshed).toBe(0);
    }
    expect((await systemDeployments(ALWAYS.app)).map((row) => row.status)).toEqual(['failed']);
  });

  test('a refresh that failed for a reason that may pass is retried once the hour is up, not before', async () => {
    await seed(ALWAYS, { alwaysOn: true, status: 'running', runtimeVersion: 'older:appd-0000000000000000' });
    const [failed] = await db.insert(appDeployments).values({
      appId: ALWAYS.app, artifactId: ARTIFACT_ID, version: 2, status: 'failed', errorCode: 'provider_error',
      failedAt: new Date(Date.now() - 10 * 60_000), sourceKind: 'dockerfile', hostingType: 'sandbox',
      runtimeVersion: APP_RUNTIME_VERSION, createdBy: PROJECT_ID, actorType: 'system',
    }).returning();

    expect((await runAppKeepAlive(new Date(), true))?.refreshed).toBe(0);
    await db.update(appDeployments).set({ failedAt: new Date(Date.now() - REFRESH_RETRY_AFTER_MS - 60_000) })
      .where(eq(appDeployments.deploymentId, failed!.deploymentId));
    expect((await runAppKeepAlive(new Date(), true))?.refreshed).toBe(1);
    expect((await systemDeployments(ALWAYS.app)).map((row) => row.status).sort()).toEqual(['failed', 'queued']);
  });
});
