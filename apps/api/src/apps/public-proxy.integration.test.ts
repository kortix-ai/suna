import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  accounts,
  appArtifacts,
  appDeployments,
  appRuntimes,
  apps,
  createDb,
  type Database,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import type { AppHostingProvider, AppdStatus } from './hosting';
import { ensureAppRuntimeRunning, loadPublicApp } from './public-proxy';

const CONFIRMATION = 'I_UNDERSTAND_THIS_DELETES_TEST_DATA';
const HAS_CONFIRMED_TEST_DB = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === CONFIRMATION &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const describeWithDb = HAS_CONFIRMED_TEST_DB ? describe : describe.skip;

let integrationDb: Database | null = null;
function testDb(): Database {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is required');
  if (!integrationDb) integrationDb = createDb(url, { max: 4 });
  return integrationDb;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000a901';
const PROJECT_ID = '00000000-0000-4000-a000-00000000a902';
const APP_ID = '00000000-0000-4000-a000-00000000a903';
const ARTIFACT_ID = '00000000-0000-4000-a000-00000000a904';
const DEPLOYMENT_ID = '00000000-0000-4000-a000-00000000a905';
const RUNTIME_ID = '00000000-0000-4000-a000-00000000a906';
const ROUTE_KEY = 'aaaaaaaaaaaaaaaa';

async function cleanup(): Promise<void> {
  const db = testDb();
  await db.update(apps)
    .set({ activeDeploymentId: null })
    .where(eq(apps.projectId, PROJECT_ID));
  await db.delete(apps).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(appArtifacts).where(eq(appArtifacts.projectId, PROJECT_ID));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

async function seedStoppedRuntime() {
  const db = testDb();
  await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'App lifecycle race test' });
  await db.insert(projects).values({
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'App lifecycle race test',
    repoUrl: 'https://example.test/app-lifecycle-race.git',
  });
  await db.insert(apps).values({
    appId: APP_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    slug: 'app-lifecycle-race',
    name: 'App lifecycle race',
    routeKey: ROUTE_KEY,
    desiredState: 'running',
    idleTimeoutSeconds: 300,
    monthlyBudgetUsd: '5.00',
  });
  await db.insert(appArtifacts).values({
    artifactId: ARTIFACT_ID,
    accountId: ACCOUNT_ID,
    projectId: PROJECT_ID,
    kind: 'oci_image',
    status: 'ready',
    imageReference: 'docker.io/library/nginx:alpine',
  });
  await db.insert(appDeployments).values({
    deploymentId: DEPLOYMENT_ID,
    appId: APP_ID,
    artifactId: ARTIFACT_ID,
    version: 1,
    status: 'ready',
    sourceKind: 'oci_image',
    hostingType: 'sandbox',
    hostingProvider: 'local-docker',
    runtimeVersion: 'test',
  });
  await db.insert(appRuntimes).values({
    runtimeId: RUNTIME_ID,
    deploymentId: DEPLOYMENT_ID,
    accountId: ACCOUNT_ID,
    provider: 'local-docker',
    externalId: 'app-lifecycle-race-runtime',
    status: 'stopped',
    controlTokenHash: '0'.repeat(64),
  });
  await db.update(apps)
    .set({ activeDeploymentId: DEPLOYMENT_ID })
    .where(eq(apps.appId, APP_ID));

  const loaded = await loadPublicApp(ROUTE_KEY);
  if (!loaded) throw new Error('seeded App did not resolve');
  return loaded;
}

function readyStatus(): AppdStatus {
  return { status: 'running', ready: true };
}

describeWithDb('App wake lifecycle races — real PostgreSQL', () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  test('concurrent cold requests acquire one wake lease and both observe the running row', async () => {
    const loaded = await seedStoppedRuntime();
    const readinessStarted = deferred<void>();
    const releaseReadiness = deferred<AppdStatus>();
    let ensureCalls = 0;
    const hosting = {
      ensureRunning: async () => {
        ensureCalls += 1;
      },
      waitUntilReady: async () => {
        readinessStarted.resolve();
        return releaseReadiness.promise;
      },
      stop: async () => {},
    } as unknown as AppHostingProvider;

    const first = ensureAppRuntimeRunning(loaded, hosting);
    await readinessStarted.promise;
    const second = ensureAppRuntimeRunning(loaded, hosting);
    await Bun.sleep(25);
    releaseReadiness.resolve(readyStatus());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult.status).toBe('running');
    expect(secondResult.status).toBe('running');
    expect(ensureCalls).toBe(1);

    const [runtime] = await testDb().select().from(appRuntimes)
      .where(eq(appRuntimes.runtimeId, RUNTIME_ID));
    expect(runtime?.status).toBe('running');
    expect(runtime?.wakeLeaseOwner).toBeNull();
    expect(runtime?.wakeLeaseUntil).toBeNull();
  });

  test('a manual stop during provider readiness wins and cannot be overwritten by the wake owner', async () => {
    const loaded = await seedStoppedRuntime();
    const readinessStarted = deferred<void>();
    const releaseReadiness = deferred<AppdStatus>();
    let stopCalls = 0;
    const hosting = {
      ensureRunning: async () => {},
      waitUntilReady: async () => {
        readinessStarted.resolve();
        return releaseReadiness.promise;
      },
      stop: async () => {
        stopCalls += 1;
      },
    } as unknown as AppHostingProvider;

    const wake = ensureAppRuntimeRunning(loaded, hosting).catch((error) => error);
    await readinessStarted.promise;
    const stoppedAt = new Date();
    await testDb().update(apps)
      .set({ desiredState: 'stopped', updatedAt: stoppedAt })
      .where(eq(apps.appId, APP_ID));
    await testDb().update(appRuntimes)
      .set({
        status: 'stopped',
        stoppedAt,
        activityLeaseUntil: null,
        idleDeadlineAt: null,
        wakeLeaseOwner: null,
        wakeLeaseUntil: null,
        updatedAt: stoppedAt,
      })
      .where(eq(appRuntimes.runtimeId, RUNTIME_ID));
    releaseReadiness.resolve(readyStatus());

    const error = await wake;
    expect(error).toBeInstanceOf(Response);
    expect((error as Response).status).toBe(503);
    expect(await (error as Response).json()).toEqual({ error: 'App is stopped', code: 'app_stopped' });
    expect(stopCalls).toBe(1);

    const [runtime] = await testDb().select().from(appRuntimes)
      .where(eq(appRuntimes.runtimeId, RUNTIME_ID));
    expect(runtime?.status).toBe('stopped');
    expect(runtime?.wakeLeaseOwner).toBeNull();
    expect(runtime?.wakeLeaseUntil).toBeNull();
  });
});
