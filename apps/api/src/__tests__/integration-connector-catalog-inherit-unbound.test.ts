/**
 * Regression for the Connector catalog/call connection-resolution contract.
 *
 * `connector_bindings_configured = true` with `inherit_unbound = false` is an
 * explicit fail-closed session scope. The catalog and call resolver must both
 * hide every unbound alias. An earlier catalog-only safety net bypassed that
 * stored scope, so discovery advertised project-default connectors while every
 * call returned `connector_not_found`.
 *
 * Real-Postgres tenant contract — run with DATABASE_URL pointed at an isolated
 * migrated database (mirrors integration-session-connections.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  connectorConnections,
  connectors,
  connectionCredentials,
  projectSessionConnectorBindings,
  projectSessions,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import { dbConnectorRouterDeps } from '../connectors/db-deps';
import { createConnectorRouter } from '../connectors/router';
import {
  resolveProjectDefaultConnectorConnection,
  resolveSessionConnectorConnection,
} from '../projects/lib/session-connector-bindings';
import { encryptProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
// Two connectors: one the session binds (veyris), one it does not (unbound).
const CONNECTOR_BOUND = crypto.randomUUID();
const CONNECTOR_UNBOUND = crypto.randomUUID();
const CONNECTOR_REVOKED = crypto.randomUUID();
const CONNECTION_BOUND_DEFAULT = crypto.randomUUID();
const CONNECTION_BOUND_MEMBER = crypto.randomUUID();
const CONNECTION_UNBOUND_DEFAULT = crypto.randomUUID();
const CONNECTION_UNBOUND_MEMBER = crypto.randomUUID();
const CONNECTION_REVOKED_DEFAULT = crypto.randomUUID();
const CONNECTION_REVOKED_MEMBER = crypto.randomUUID();

// A partial explicit fail-closed scope. Only veyris remains callable.
const SESSION_BUG = crypto.randomUUID();
// Exact production incident shape: explicit fail-closed scope with zero rows.
const SESSION_EMPTY = crypto.randomUUID();
// The fixed create-path default: bindings configured, inherit_unbound TRUE
// (what an ABSENT inherit_unbound now becomes), binds only veyris.
const SESSION_INHERIT = crypto.randomUUID();
// A session with NO bindings configured — legacy, always falls back.
const SESSION_LEGACY = crypto.randomUUID();

function principalFor(sessionId: string | null) {
  return {
    userId: USER,
    accountId: ACCOUNT,
    projectId: PROJECT,
    sessionId,
    subject: { userId: USER, groupIds: [] },
    // Agent grant allows both connectors, so the agent-grant filter is not the
    // thing hiding them — the binding resolution is.
    agentGrant: { agent: 'test', connectors: ['veyris', 'unbound', 'revoked'], kortixCli: [] },
  };
}

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'catalog-inherit-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'catalog-inherit-test',
    repoUrl: 'https://example.test/catalog-inherit.git',
  });
  await db.insert(connectors).values([
    {
      connectorId: CONNECTOR_BOUND,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'veyris',
      name: 'Veyris',
      providerType: 'http',
      config: { baseUrl: 'https://veyris.example.test', auth: { type: 'bearer' } },
      authorizationStrategy: 'user',
    },
    {
      connectorId: CONNECTOR_UNBOUND,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'unbound',
      name: 'Unbound',
      providerType: 'http',
      config: { baseUrl: 'https://unbound.example.test', auth: { type: 'bearer' } },
      authorizationStrategy: 'user',
    },
    {
      connectorId: CONNECTOR_REVOKED,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'revoked',
      name: 'Revoked',
      providerType: 'http',
      config: { baseUrl: 'https://revoked.example.test', auth: { type: 'bearer' } },
      authorizationStrategy: 'user',
    },
  ]);
  // A project-wide block policy would hide actions, but it does not hide the
  // connector itself — keep it out so the catalog entries are observable.
  await db.insert(connectorConnections).values([
    {
      connectionId: CONNECTION_BOUND_DEFAULT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_BOUND,
      label: 'Veyris default',
      isDefault: true,
    },
    {
      connectionId: CONNECTION_BOUND_MEMBER,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_BOUND,
      ownerType: 'member',
      ownerId: USER,
      label: 'Veyris my workspace',
    },
    {
      connectionId: CONNECTION_UNBOUND_DEFAULT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_UNBOUND,
      label: 'Unbound default',
      isDefault: true,
    },
    {
      connectionId: CONNECTION_UNBOUND_MEMBER,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_UNBOUND,
      ownerType: 'member',
      ownerId: USER,
      label: 'Unbound my workspace',
    },
    {
      // The active member default the project-default fallback WOULD pick for
      // `revoked` if the safety net ran — proves the catalog omits `revoked`
      // because of the binding-row guard, not because there is no fallback.
      connectionId: CONNECTION_REVOKED_DEFAULT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_REVOKED,
      ownerType: 'member',
      ownerId: USER,
      label: 'Revoked active member default',
      isDefault: true,
    },
    {
      connectionId: CONNECTION_REVOKED_MEMBER,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR_REVOKED,
      ownerType: 'member',
      ownerId: USER,
      label: 'Revoked my workspace',
    },
  ]);
  await db.insert(connectionCredentials).values([
    {
      connectorId: CONNECTOR_BOUND,
      connectionId: CONNECTION_BOUND_DEFAULT,
      valueEnc: encryptProjectSecret(PROJECT, 'veyris-default-cap'),
    },
    {
      connectorId: CONNECTOR_BOUND,
      connectionId: CONNECTION_BOUND_MEMBER,
      valueEnc: encryptProjectSecret(PROJECT, 'veyris-member-cap'),
    },
    {
      connectorId: CONNECTOR_UNBOUND,
      connectionId: CONNECTION_UNBOUND_DEFAULT,
      valueEnc: encryptProjectSecret(PROJECT, 'unbound-default-cap'),
    },
    {
      connectorId: CONNECTOR_UNBOUND,
      connectionId: CONNECTION_UNBOUND_MEMBER,
      valueEnc: encryptProjectSecret(PROJECT, 'unbound-member-cap'),
    },
    {
      connectorId: CONNECTOR_REVOKED,
      connectionId: CONNECTION_REVOKED_DEFAULT,
      valueEnc: encryptProjectSecret(PROJECT, 'revoked-default-cap'),
    },
    {
      connectorId: CONNECTOR_REVOKED,
      connectionId: CONNECTION_REVOKED_MEMBER,
      valueEnc: encryptProjectSecret(PROJECT, 'revoked-member-cap'),
    },
  ]);
  await db.insert(projectSessions).values([
    {
      sessionId: SESSION_EMPTY,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION_EMPTY,
      createdBy: USER,
      visibility: 'private',
      connectorBindingsConfigured: true,
      connectorBindingsInheritUnbound: false,
    },
    {
      // The bug condition: configured + NOT inherit_unbound. Only veyris is bound.
      sessionId: SESSION_BUG,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION_BUG,
      createdBy: USER,
      visibility: 'private',
      connectorBindingsConfigured: true,
      connectorBindingsInheritUnbound: false,
    },
    {
      // Fixed: configured + inherit_unbound = true (what absent now defaults to).
      sessionId: SESSION_INHERIT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION_INHERIT,
      createdBy: USER,
      visibility: 'private',
      connectorBindingsConfigured: true,
      connectorBindingsInheritUnbound: true,
    },
    {
      // Legacy: no bindings configured at all — always fell back to project default.
      sessionId: SESSION_LEGACY,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION_LEGACY,
      createdBy: USER,
      visibility: 'private',
    },
  ]);
  // SESSION_BUG and SESSION_INHERIT both bind veyris to USER's member connection.
  // SESSION_BUG also binds `revoked` to a connection that is revoked below.
  await db.insert(projectSessionConnectorBindings).values([
    {
      sessionId: SESSION_BUG,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_BOUND,
      connectionId: CONNECTION_BOUND_MEMBER,
      source: 'request',
      createdBy: USER,
    },
    {
      sessionId: SESSION_BUG,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorAlias: 'revoked',
      connectorId: CONNECTOR_REVOKED,
      connectionId: CONNECTION_REVOKED_MEMBER,
      source: 'request',
      createdBy: USER,
    },
    {
      sessionId: SESSION_INHERIT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_BOUND,
      connectionId: CONNECTION_BOUND_MEMBER,
      source: 'request',
      createdBy: USER,
    },
  ]);
  // Revoke the `revoked` binding's connection so it resolves null at call time —
  // a present-but-revoked binding must FAIL CLOSED, not fall through to default.
  await db
    .update(connectorConnections)
    .set({ status: 'revoked', updatedAt: new Date() })
    .where(eq(connectorConnections.connectionId, CONNECTION_REVOKED_MEMBER));
});

afterAll(async () => {
  await db.delete(projectSessionConnectorBindings).where(eq(projectSessionConnectorBindings.projectId, PROJECT));
  await db.delete(connectionCredentials).where(eq(connectionCredentials.connectorId, CONNECTOR_BOUND));
  await db
    .delete(connectionCredentials)
    .where(eq(connectionCredentials.connectorId, CONNECTOR_UNBOUND));
  await db
    .delete(connectionCredentials)
    .where(eq(connectionCredentials.connectorId, CONNECTOR_REVOKED));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db
    .delete(connectorConnections)
    .where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('connector catalog and call resolver use one session scope', () => {
  test('an explicit empty scope hides every connector from catalog and calls', async () => {
    const unbound = await resolveSessionConnectorConnection({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: SESSION_EMPTY,
      alias: 'unbound',
      actingUserId: USER,
    });
    expect(unbound).toBeNull();

    const catalog = await dbConnectorRouterDeps.listCatalog(principalFor(SESSION_EMPTY));
    expect(catalog).toEqual([]);

    const deps = dbConnectorRouterDeps.makeGatewayDeps(principalFor(SESSION_EMPTY));
    expect(await deps.loadConnectorBySlug(PROJECT, 'unbound')).toBeNull();
  });

  test('the real project-explicit HTTP routes expose the same empty scope', async () => {
    const principal = principalFor(SESSION_EMPTY);
    const app = createConnectorRouter({
      ...dbConnectorRouterDeps,
      resolvePrincipal: async () => principal,
      resolveProjectPrincipal: async (_c, projectId) => (projectId === PROJECT ? principal : null),
    });

    const catalogResponse = await app.request(`/projects/${PROJECT}/catalog`);
    expect(catalogResponse.status).toBe(200);
    expect(await catalogResponse.json()).toEqual({ connectors: [] });

    const callResponse = await app.request(`/projects/${PROJECT}/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connector: 'unbound', action: 'read', args: {} }),
    });
    expect(callResponse.status).toBe(404);
    expect(await callResponse.json()).toEqual({
      ok: false,
      status: 'denied',
      reason: 'connector_not_found',
    });
  });

  test('a partial fail-closed scope exposes only its active explicit binding', async () => {
    const catalog = await dbConnectorRouterDeps.listCatalog(principalFor(SESSION_BUG));
    const slugs = catalog.map((c) => c.slug).sort();
    expect(slugs).toEqual(['veyris']);

    const deps = dbConnectorRouterDeps.makeGatewayDeps(principalFor(SESSION_BUG));
    const conn = await deps.loadConnectorBySlug(PROJECT, 'veyris');
    expect(conn?.connectionId).toBe(CONNECTION_BOUND_MEMBER);
    expect(await deps.loadConnectorBySlug(PROJECT, 'unbound')).toBeNull();
  });

  test('a present-but-REVOKED binding fails closed (the safety net does not resurrect it)', async () => {
    const revoked = await resolveSessionConnectorConnection({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: SESSION_BUG,
      alias: 'revoked',
      actingUserId: USER,
    });
    expect(revoked).toBeNull();

    const projectDefault = await resolveProjectDefaultConnectorConnection({
      accountId: ACCOUNT,
      projectId: PROJECT,
      alias: 'revoked',
      actingUserId: USER,
    });
    // A different active project default exists. The explicit revoked binding
    // still fails closed instead of falling through to it.
    expect(projectDefault?.connectionId).toBe(CONNECTION_REVOKED_DEFAULT);

    const catalog = await dbConnectorRouterDeps.listCatalog(principalFor(SESSION_BUG));
    expect(catalog.map((c) => c.slug)).not.toContain('revoked');
  });

  test('the fixed create-path default (inherit_unbound=true) lists unbound aliases without the safety net', async () => {
    const unbound = await resolveSessionConnectorConnection({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: SESSION_INHERIT,
      alias: 'unbound',
      actingUserId: USER,
    });
    expect(unbound).toMatchObject({ connectionId: CONNECTION_UNBOUND_MEMBER, source: 'default' });

    const catalog = await dbConnectorRouterDeps.listCatalog(principalFor(SESSION_INHERIT));
    const slugs = catalog.map((c) => c.slug).sort();
    expect(slugs).toEqual(['revoked', 'unbound', 'veyris']);

    const deps = dbConnectorRouterDeps.makeGatewayDeps(principalFor(SESSION_INHERIT));
    expect((await deps.loadConnectorBySlug(PROJECT, 'unbound'))?.connectionId).toBe(
      CONNECTION_UNBOUND_MEMBER,
    );
  });

  test('a legacy session with no bindings configured lists every connected connector', async () => {
    // SESSION_LEGACY has no bindings configured. It always resolved via the
    // project default; this guard confirms the fix did not regress that path.
    const catalog = await dbConnectorRouterDeps.listCatalog(principalFor(SESSION_LEGACY));
    const slugs = catalog.map((c) => c.slug).sort();
    // `revoked`'s member connection is revoked, but its DEFAULT connection is active
    // and connected, so a legacy session sees it via the project default.
    expect(slugs).toEqual(['revoked', 'unbound', 'veyris']);

    const deps = dbConnectorRouterDeps.makeGatewayDeps(principalFor(SESSION_LEGACY));
    expect((await deps.loadConnectorBySlug(PROJECT, 'unbound'))?.connectionId).toBe(
      CONNECTION_UNBOUND_MEMBER,
    );
  });
});
