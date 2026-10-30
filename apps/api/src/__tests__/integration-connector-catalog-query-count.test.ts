import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, connectionCredentials, connectorConnections, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { ensureProjectComputer } from '../connectors/sync';
import { runWithContext } from '../lib/request-context';
import { stageSnapshot } from '../lib/server-timing';
import { encryptProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER_A = crypto.randomUUID();

const OPENAPI_CONNECTOR_COUNT = 4;
const COMPOSIO_CONNECTOR_COUNT = 4;

const openapiConnectorIds = Array.from({ length: OPENAPI_CONNECTOR_COUNT }, () => crypto.randomUUID());
const composioConnectorIds = Array.from({ length: COMPOSIO_CONNECTOR_COUNT }, () => crypto.randomUUID());

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'connector-list-query-count-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'connector-list-query-count-test',
    repoUrl: 'https://example.test/connector-list-query-count.git',
  });

  await db.insert(connectors).values([
    ...openapiConnectorIds.map((connectorId, i) => ({
      connectorId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: `openapi-${i}`,
      name: `OpenAPI ${i}`,
      providerType: 'openapi' as const,
      config: { baseUrl: `https://api-${i}.example.test`, auth: { type: 'bearer' } },
    })),
    ...composioConnectorIds.map((connectorId, i) => ({
      connectorId,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: `composio-${i}`,
      name: `Composio ${i}`,
      providerType: 'composio' as const,
      config: { app: `app-${i}` },
    })),
  ]);

  const openapiConnectionIds = openapiConnectorIds.map(() => crypto.randomUUID());
  const composioConnectionIds = composioConnectorIds.map(() => crypto.randomUUID());

  await db.insert(connectorConnections).values([
    ...openapiConnectorIds.map((connectorId, i) => ({
      connectionId: openapiConnectionIds[i] ?? crypto.randomUUID(),
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId,
      ownerType: 'member' as const,
      ownerId: USER_A,
      status: 'active' as const,
      label: `A's OpenAPI ${i}`,
    })),
    ...composioConnectorIds.map((connectorId, i) => ({
      connectionId: composioConnectionIds[i] ?? crypto.randomUUID(),
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId,
      ownerType: 'member' as const,
      ownerId: USER_A,
      status: 'active' as const,
      label: `a${i}@example.test`,
      metadata: { provider: 'composio', toolkit: `app-${i}`, connected_account_id: `ca_${i}` },
    })),
  ]);

  await db.insert(connectionCredentials).values(
    openapiConnectorIds.map((connectorId, i) => ({
      connectorId,
      connectionId: openapiConnectionIds[i] ?? crypto.randomUUID(),
      valueEnc: encryptProjectSecret(PROJECT, `openapi-${i}-capability`),
    })),
  );
});

afterAll(async () => {
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('listCatalog issues a bounded number of queries, not O(connector count)', () => {
  test('8 connectors (4 Composio) stay well under an O(n) ceiling', async () => {
    // Every project holds the built-in computer connector; the first listing
    // creates it once. Measure the steady state.
    await ensureProjectComputer(PROJECT, null);
    const { list: listed, dbQueryCount } = await runWithContext('GET', '/test/connectors', async () => {
      const result = await dbConnectorRouterDeps.listCatalog({
        userId: USER_A, accountId: ACCOUNT, projectId: PROJECT, sessionId: null,
        subject: { userId: USER_A, groupIds: [] },
      });
      return { list: result, dbQueryCount: stageSnapshot().db?.count ?? 0 };
    });

    // The fixture pairs no machine, so the built-in computer connector stays
    // out of the list (KRTX-1492) — hidden, not absent from the query plan.
    expect(listed.filter((view) => view.provider === 'computer')).toEqual([]);
    const list = listed.filter((view) => view.provider !== 'computer');
    // Correctness: every connector still resolves as connected for its owner.
    expect(list).toHaveLength(OPENAPI_CONNECTOR_COUNT + COMPOSIO_CONNECTOR_COUNT);
    for (const view of list) {
      expect(view.status).toBe('active');
      expect(view.accounts?.length ?? 0).toBeGreaterThan(0);
    }

    // Real PostgreSQL tracing measured 87 statements before batching. Keep a
    // fixed ceiling independent of this fixture's eight credentialed accounts.
    console.info(`catalog benchmark: connectors=${list.length} statements=${dbQueryCount}`);
    expect(dbQueryCount).toBeGreaterThan(0);
    expect(dbQueryCount).toBeLessThanOrEqual(24);
  });
});
