/**
 * Integration test (real local DB): purging a project removes its connector
 * rows (KRTX-1907). `DELETE /v1/projects/:projectId` archives the project row
 * (`status = 'archived'`), so the `connectors.project_id` FK cascade never
 * fires: the connector rows outlived the purged project and
 * `GET /v1/connectors/projects/:projectId/connectors` kept serving them.
 *
 * The purge runs on the delete route before the archive — after it the project
 * answers 404, so a failed purge could never be retried. The route's access
 * layer is mocked (no authenticated principal in a DB suite); the database,
 * the delete route and its FK cascades are real.
 *
 * Runs in the `db-suites` lane of `pnpm test` (one throwaway database per
 * file). It writes and deletes rows with fixed ids.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  accounts,
  accountTokens,
  connectorConnections,
  connectorPolicies,
  connectionCredentials,
  connectors,
  projectSessionConnectorBindings,
  projectSessions,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';

const ACCOUNT = '00000000-0000-4000-a000-00000000c1a1';
const PROJECT = '00000000-0000-4000-a000-00000000c1a2';
const SESSION = '00000000-0000-4000-a000-00000000c1a3';
const OWNER = '00000000-0000-4000-a000-00000000c1a4';
const CONNECTOR = '00000000-0000-4000-a000-00000000c1a5';
const CONNECTION = '00000000-0000-4000-a000-00000000c1a6';
const CREDENTIAL = '00000000-0000-4000-a000-00000000c1a7';

const realAccess = await import('../projects/lib/access');
mock.module('../projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    userId: OWNER,
    row: { projectId: PROJECT, accountId: ACCOUNT, metadata: {} },
  }),
  assertProjectCapability: async () => {},
}));

const { db } = await import('../shared/db');
const { projectsApp } = await import('../projects/lib/app');
(await import('../projects/routes/project-settings')).registerProjectSettingsRoutes();

async function seed(): Promise<void> {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'connector-purge-acct' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'connector-purge-project',
    repoUrl: 'https://example.test/connector-purge.git',
  });
  await db.insert(connectors).values({
    connectorId: CONNECTOR,
    accountId: ACCOUNT,
    projectId: PROJECT,
    slug: 'purge-fixture',
    name: 'Purge fixture',
    providerType: 'http',
  });
  await db.insert(connectorConnections).values({
    connectionId: CONNECTION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorId: CONNECTOR,
    label: 'Purge fixture connection',
  });
  await db.insert(connectionCredentials).values({
    credentialId: CREDENTIAL,
    connectorId: CONNECTOR,
    connectionId: CONNECTION,
    valueEnc: 'encrypted-fixture',
  });
  await db.insert(connectorPolicies).values({
    connectorId: CONNECTOR,
    match: 'purge-fixture.*',
    action: 'block',
  });
  // The bindings RESTRICT on the connector, so they are the rows that make a
  // naive connector delete fail — exactly what the purge must handle.
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: 'connector-purge',
    createdBy: OWNER,
    visibility: 'project',
  });
  await db.insert(projectSessionConnectorBindings).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorId: CONNECTOR,
    connectorAlias: 'purge-fixture',
    connectionId: CONNECTION,
  });
}

async function counts(): Promise<{
  connectors: number;
  connections: number;
  credentials: number;
  policies: number;
  bindings: number;
}> {
  const [connectorRows, connectionRows, credentialRows, policyRows, bindingRows] = await Promise.all([
    db.select().from(connectors).where(eq(connectors.projectId, PROJECT)),
    db.select().from(connectorConnections).where(eq(connectorConnections.projectId, PROJECT)),
    db.select().from(connectionCredentials).where(eq(connectionCredentials.connectorId, CONNECTOR)),
    db.select().from(connectorPolicies).where(eq(connectorPolicies.connectorId, CONNECTOR)),
    db
      .select()
      .from(projectSessionConnectorBindings)
      .where(eq(projectSessionConnectorBindings.projectId, PROJECT)),
  ]);
  return {
    connectors: connectorRows.length,
    connections: connectionRows.length,
    credentials: credentialRows.length,
    policies: policyRows.length,
    bindings: bindingRows.length,
  };
}

beforeAll(async () => {
  await seed();
});

beforeEach(async () => {
  // The delete route archives the project row; restore it so every test runs
  // the full path from an active project.
  await db.update(projects).set({ status: 'active' }).where(eq(projects.projectId, PROJECT));
});

afterAll(async () => {
  // Bindings RESTRICT the connector delete, which RESTRICTs the project-row
  // delete — purge in dependency order so cleanup works in every state.
  await db.delete(projectSessionConnectorBindings).where(eq(projectSessionConnectorBindings.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('purging a project removes its connector rows', () => {
  test('the fixture holds one connector with its connection, credential, policy and binding', async () => {
    expect(await counts()).toEqual({
      connectors: 1,
      connections: 1,
      credentials: 1,
      policies: 1,
      bindings: 1,
    });
  });

  test('DELETE /v1/projects/:projectId archives the project and purges every connector row', async () => {
    const tokenId = crypto.randomUUID();
    await db.insert(accountTokens).values({
      tokenId, accountId: ACCOUNT, userId: OWNER, projectId: PROJECT,
      sessionId: SESSION, name: 'synthetic-session',
      publicKey: `synthetic-${tokenId}`, secretKeyHash: 'synthetic-hash',
    });
    const res = await projectsApp.request(`/${PROJECT}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: true, archived: true, repo_deleted: false });

    const [row] = await db.select().from(projects).where(eq(projects.projectId, PROJECT)).limit(1);
    expect(row?.status).toBe('archived');
    const [token] = await db.select().from(accountTokens).where(eq(accountTokens.tokenId, tokenId));
    expect(token?.status).toBe('revoked');
    expect(token?.revokedAt).toBeInstanceOf(Date);

    // The connector row is gone, and the database cascaded its dependents.
    expect(await counts()).toEqual({
      connectors: 0,
      connections: 0,
      credentials: 0,
      policies: 0,
      bindings: 0,
    });
  });
});
