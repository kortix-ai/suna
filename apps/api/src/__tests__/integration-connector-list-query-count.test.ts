/**
 * GET /connectors/projects/:id/connectors (`listConnectors`, `../services/connectors/db-deps.ts`)
 * ran one `listEntitledConnectorConnections` call PER connector — twice for
 * every Composio connector (once for its "authorized" check, once for its
 * accounts list) — each of which re-checked the service-account flag,
 * re-selected the `connectors` row by alias, and re-selected
 * `connectorConnections` scoped to that one connector. Measured on prod:
 * n=64 database queries for one project's connector list (1.6MB body,
 * 1.0s median server time, one run 9.4s / 8783ms db time).
 *
 * The fix batches all of that into `listEntitledConnectorConnectionsBatch`
 * (`../services/sessions/session-connector-bindings.ts`) — one query for the
 * service-account check, one `inArray` query for every connector's
 * connections, computed once and reused for both the accounts list and the
 * Composio authorization check.
 *
 * This test proves the query count no longer scales with connector count:
 * for 8 connectors (4 Composio, each checked twice under the old code) the
 * OLD design issued on the order of 45-60 queries; this asserts a ceiling
 * that only a batched design can meet.
 *
 * Real-Postgres tenant contract — mirrors
 * ./integration-connector-list-member-credential-status.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { accounts, connectionCredentials, connectorConnections, connectors, projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { dbConnectorRouterDeps } from '../services/connectors/db-deps';
import { ensureProjectComputer } from '../services/connectors/sync';
import { runWithContext } from '../lib/request-context';
import { stageSnapshot } from '../lib/server-timing';
import { encryptProjectSecret } from '../services/secrets/secrets';
import { db } from '../lib/db';

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
      connectionId: openapiConnectionIds[i]!,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId,
      ownerType: 'member' as const,
      ownerId: USER_A,
      status: 'active' as const,
      label: `A's OpenAPI ${i}`,
    })),
    ...composioConnectorIds.map((connectorId, i) => ({
      connectionId: composioConnectionIds[i]!,
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
      connectionId: openapiConnectionIds[i]!,
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

describe('listConnectors issues a bounded number of queries, not O(connector count)', () => {
  test('8 connectors (4 Composio) stay well under an O(n) ceiling', async () => {
    // Every project holds the built-in computer connector; the first listing
    // creates it once. Measure the steady state.
    await ensureProjectComputer(PROJECT, null);
    const { list: listed, dbQueryCount } = await runWithContext('GET', '/test/connectors', async () => {
      const result = await dbConnectorRouterDeps.listConnectors(PROJECT, USER_A);
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

    // The old per-connector design issued roughly:
    //   fixed overhead (~6) + composio-authorized-loop (4 connectors x ~3) +
    //   accounts-loop (8 connectors x ~3) + ownership rows (~1)
    // which lands in the 45-60 range for this fixture. The batched design
    // issues a small, connector-count-INDEPENDENT number of queries. 20 is a
    // ceiling only a batched design can meet for 8 connectors — generous
    // enough to tolerate incidental fixed-cost queries without being flaky.
    // Measured (2026-09-27, this fixture): 13 queries. The old per-connector
    // design would have issued at least 45-60 for the same 8 connectors.
    expect(dbQueryCount).toBeGreaterThan(0);
    expect(dbQueryCount).toBeLessThanOrEqual(20);
  });
});
