/**
 * `loadReferencedSnapshotNames` must protect a `ready` App-deployment's
 * snapshot (a live rollback target — `routes.ts`'s
 * `POST /apps/{appId}/rollback` requires `status = 'ready'`) and must NOT
 * protect one that is `failed`/`cancelled` or whose row no longer exists.
 *
 * Runs against a real PostgreSQL only: the property under test is a DB read,
 * not pure logic (see `unit-quota-gc-select.test.ts` for the pure selection
 * rule this feeds).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { accounts, appArtifacts, appDeployments, apps, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { db } from '../shared/db';
import { appDeploymentSnapshotName, loadReferencedSnapshotNames } from './quota-gc';

const confirmed = Boolean(
  process.env.TEST_DATABASE_URL &&
    process.env.KORTIX_TEST_DB_CONFIRM === 'I_UNDERSTAND_THIS_DELETES_TEST_DATA' &&
    process.env.INTERNAL_KORTIX_ENV !== 'prod',
);
const withDb = confirmed ? describe : describe.skip;

const ACCOUNT_ID = '00000000-0000-4000-a000-00000000b901';
const PROJECT_ID = '00000000-0000-4000-a000-00000000b902';
const APP_ID = '00000000-0000-4000-a000-00000000b903';
const ARTIFACT_ID = '00000000-0000-4000-a000-00000000b904';
const READY_DEPLOYMENT_ID = '00000000-0000-4000-a000-00000000b905';
const FAILED_DEPLOYMENT_ID = '00000000-0000-4000-a000-00000000b906';
const ORPHAN_DEPLOYMENT_ID = '00000000-0000-4000-a000-00000000b907';
const ROUTE_KEY = 'bbbbbbbbbbbbbbbb';

async function cleanup(): Promise<void> {
  await db.update(apps).set({ activeDeploymentId: null }).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(apps).where(eq(apps.projectId, PROJECT_ID));
  await db.delete(appArtifacts).where(eq(appArtifacts.projectId, PROJECT_ID));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_ID));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_ID));
}

withDb('loadReferencedSnapshotNames — App deployment protection', () => {
  beforeEach(async () => {
    await cleanup();
    await db.insert(accounts).values({ accountId: ACCOUNT_ID, name: 'quota-gc app-deployment test' });
    await db.insert(projects).values({
      projectId: PROJECT_ID,
      accountId: ACCOUNT_ID,
      name: 'quota-gc app-deployment test',
      repoUrl: 'https://example.test/quota-gc-app-deployment.git',
      metadata: { experimental: { apps: true } },
    });
    await db.insert(apps).values({
      appId: APP_ID,
      accountId: ACCOUNT_ID,
      projectId: PROJECT_ID,
      slug: 'quota-gc-app-deployment-test',
      name: 'quota-gc app-deployment test',
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
    // A live rollback target.
    await db.insert(appDeployments).values({
      deploymentId: READY_DEPLOYMENT_ID,
      appId: APP_ID,
      artifactId: ARTIFACT_ID,
      version: 1,
      status: 'ready',
      sourceKind: 'oci_image',
      hostingType: 'sandbox',
      hostingProvider: 'daytona',
      runtimeVersion: 'test',
      createdBy: PROJECT_ID,
    });
    // Exhausted retries — never a valid rollback target (route requires `ready`).
    await db.insert(appDeployments).values({
      deploymentId: FAILED_DEPLOYMENT_ID,
      appId: APP_ID,
      artifactId: ARTIFACT_ID,
      version: 2,
      status: 'failed',
      sourceKind: 'oci_image',
      hostingType: 'sandbox',
      hostingProvider: 'daytona',
      runtimeVersion: 'test',
      createdBy: PROJECT_ID,
    });
    // ORPHAN_DEPLOYMENT_ID is never inserted — models a hard-deleted App whose
    // `app_deployments` rows cascaded away, leaving only the provider snapshot.
  });

  afterEach(cleanup);

  test('protects the ready deployment, not the failed or the nonexistent one', async () => {
    const referenced = await loadReferencedSnapshotNames(Date.now());

    expect(referenced.has(appDeploymentSnapshotName(READY_DEPLOYMENT_ID))).toBe(true);
    expect(referenced.has(appDeploymentSnapshotName(FAILED_DEPLOYMENT_ID))).toBe(false);
    expect(referenced.has(appDeploymentSnapshotName(ORPHAN_DEPLOYMENT_ID))).toBe(false);
  });
});
