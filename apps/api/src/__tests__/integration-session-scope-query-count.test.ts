/**
 * `GET /projects/:id/sessions/:sid/scope` resolves the effective connector map
 * through `resolveEffectiveSessionConnectorBindings`. It ran the full
 * per-alias resolution once per granted connector — a binding query, the
 * `connectors` row, that connector's connections, the audience, and a
 * credential check — so the query count grew with the project's connector
 * count. Measured on prod (2026-09-27, a Kortix-owned project): `db n=55-64`,
 * 329-5081 ms server time, on every session open.
 *
 * This file pins two things:
 *  1. The batched map equals what the per-alias resolver answers for every
 *     alias, across bound, inherited, fail-closed, ambiguous and disabled
 *     connectors — the batch is an optimization, never a new rule.
 *  2. The query count does not scale with the connector count.
 *
 * Real-Postgres tenant contract; the db-suites lane supplies the database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  connectionCredentials,
  connectorConnections,
  connectors,
  projectSessionConnectorBindings,
  projectSessions,
  projects,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import { runWithContext } from '../lib/request-context';
import { stageSnapshot } from '../lib/server-timing';
import {
  resolveEffectiveSessionConnectorBindings,
  resolveSessionConnectorConnection,
} from '../services/sessions/session-connector-bindings';
import { encryptProjectSecret } from '../services/secrets/secrets';
import { db } from '../lib/db';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const USER = crypto.randomUUID();
const OTHER_USER = crypto.randomUUID();

const SESSION_INHERIT = crypto.randomUUID();
const SESSION_EXPLICIT = crypto.randomUUID();
const SESSION_INHERIT_UNBOUND = crypto.randomUUID();

/** Eight connectors that together cover every per-alias outcome. */
const C = {
  boundMember: crypto.randomUUID(), // session binding to the creator's own connection
  boundRevoked: crypto.randomUUID(), // session binding to a revoked connection: fails closed
  defaultMember: crypto.randomUUID(), // no binding; the creator's own credentialed connection
  defaultProject: crypto.randomUUID(), // no binding; one project connection, no auth needed
  ambiguous: crypto.randomUUID(), // no binding; two unpinned project connections
  pinned: crypto.randomUUID(), // no binding; two project connections, one pinned
  otherMember: crypto.randomUUID(), // no binding; only another member's connection
  disabled: crypto.randomUUID(), // disabled connector
} as const;

const SLUG: Record<keyof typeof C, string> = {
  boundMember: 'bound-member',
  boundRevoked: 'bound-revoked',
  defaultMember: 'default-member',
  defaultProject: 'default-project',
  ambiguous: 'ambiguous',
  pinned: 'pinned',
  otherMember: 'other-member',
  disabled: 'disabled',
};

const CONN = {
  boundMember: crypto.randomUUID(),
  boundMemberSpare: crypto.randomUUID(),
  boundRevoked: crypto.randomUUID(),
  defaultMember: crypto.randomUUID(),
  defaultProject: crypto.randomUUID(),
  ambiguousA: crypto.randomUUID(),
  ambiguousB: crypto.randomUUID(),
  pinnedYes: crypto.randomUUID(),
  pinnedNo: crypto.randomUUID(),
  otherMember: crypto.randomUUID(),
  disabled: crypto.randomUUID(),
};

const bearer = { baseUrl: 'https://api.example.test', auth: { type: 'bearer' } };
const open = { baseUrl: 'https://api.example.test', auth: { type: 'none' } };

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'session-scope-query-count' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'session-scope-query-count',
    repoUrl: 'https://example.test/session-scope-query-count.git',
  });

  await db.insert(connectors).values(
    (Object.keys(C) as Array<keyof typeof C>).map((key) => ({
      connectorId: C[key],
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: SLUG[key],
      name: SLUG[key],
      providerType: 'openapi' as const,
      config: key === 'defaultProject' || key === 'ambiguous' || key === 'pinned' ? open : bearer,
      enabled: key !== 'disabled',
    })),
  );

  const member = (connectionId: string, connectorId: string, ownerId: string, label: string) => ({
    connectionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorId,
    ownerType: 'member' as const,
    ownerId,
    status: 'active' as const,
    label,
  });
  const shared = (connectionId: string, connectorId: string, label: string, isDefault = false) => ({
    connectionId,
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorId,
    ownerType: 'project' as const,
    ownerId: null,
    status: 'active' as const,
    label,
    isDefault,
  });

  await db.insert(connectorConnections).values([
    member(CONN.boundMember, C.boundMember, USER, 'bound'),
    member(CONN.boundMemberSpare, C.boundMember, USER, 'bound spare'),
    member(CONN.boundRevoked, C.boundRevoked, USER, 'revoked'),
    member(CONN.defaultMember, C.defaultMember, USER, 'mine'),
    shared(CONN.defaultProject, C.defaultProject, 'shared'),
    shared(CONN.ambiguousA, C.ambiguous, 'first'),
    shared(CONN.ambiguousB, C.ambiguous, 'second'),
    shared(CONN.pinnedYes, C.pinned, 'pinned', true),
    shared(CONN.pinnedNo, C.pinned, 'not pinned'),
    member(CONN.otherMember, C.otherMember, OTHER_USER, 'theirs'),
    member(CONN.disabled, C.disabled, USER, 'disabled'),
  ]);

  const credentialed: Array<[string, string]> = [
    [C.boundMember, CONN.boundMember],
    [C.boundMember, CONN.boundMemberSpare],
    [C.boundRevoked, CONN.boundRevoked],
    [C.defaultMember, CONN.defaultMember],
    [C.otherMember, CONN.otherMember],
    [C.disabled, CONN.disabled],
  ];
  await db.insert(connectionCredentials).values(
    credentialed.map(([connectorId, connectionId]) => ({
      connectorId,
      connectionId,
      valueEnc: encryptProjectSecret(PROJECT, `${connectionId}-capability`),
    })),
  );

  await db.insert(projectSessions).values([
    { sessionId: SESSION_INHERIT, accountId: ACCOUNT, projectId: PROJECT, branchName: SESSION_INHERIT, createdBy: USER },
    {
      sessionId: SESSION_EXPLICIT,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION_EXPLICIT,
      createdBy: USER,
      connectorBindingsConfigured: true,
    },
    {
      sessionId: SESSION_INHERIT_UNBOUND,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION_INHERIT_UNBOUND,
      createdBy: USER,
      connectorBindingsConfigured: true,
      connectorBindingsInheritUnbound: true,
    },
  ]);

  for (const sessionId of [SESSION_INHERIT, SESSION_EXPLICIT, SESSION_INHERIT_UNBOUND]) {
    await db.insert(projectSessionConnectorBindings).values([
      {
        sessionId,
        accountId: ACCOUNT,
        projectId: PROJECT,
        connectorAlias: SLUG.boundMember,
        connectorId: C.boundMember,
        connectionId: CONN.boundMemberSpare,
      },
      {
        sessionId,
        accountId: ACCOUNT,
        projectId: PROJECT,
        connectorAlias: SLUG.boundRevoked,
        connectorId: C.boundRevoked,
        connectionId: CONN.boundRevoked,
      },
    ]);
  }
  // Revoked after binding: the pin must fail closed, never fall through to a default.
  await db
    .update(connectorConnections)
    .set({ status: 'revoked' })
    .where(eq(connectorConnections.connectionId, CONN.boundRevoked));
});

afterAll(async () => {
  await db.delete(projectSessionConnectorBindings).where(eq(projectSessionConnectorBindings.projectId, PROJECT));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db.delete(connectorConnections).where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(connectors).where(eq(connectors.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const ALL_SLUGS = Object.values(SLUG);

/** What the per-alias resolver answers, alias by alias: the reference. */
async function perAliasReference(sessionId: string, aliases: readonly string[]) {
  const out: Record<string, { connection_id: string }> = {};
  for (const alias of aliases) {
    const connection = await resolveSessionConnectorConnection({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId,
      alias,
    });
    if (connection) out[alias] = { connection_id: connection.connectionId };
  }
  return out;
}

describe('resolveEffectiveSessionConnectorBindings', () => {
  test('an inheriting session: pins win, defaults fill the rest, ambiguity and other members stay out', async () => {
    const effective = await resolveEffectiveSessionConnectorBindings({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: SESSION_INHERIT,
      grantedConnectors: 'all',
    });
    expect(effective).toEqual({
      'bound-member': { connection_id: CONN.boundMemberSpare },
      'default-member': { connection_id: CONN.defaultMember },
      'default-project': { connection_id: CONN.defaultProject },
      pinned: { connection_id: CONN.pinnedYes },
    });
    expect(effective).toEqual(await perAliasReference(SESSION_INHERIT, ALL_SLUGS));
  });

  test('an explicit session resolves only its own bindings', async () => {
    const effective = await resolveEffectiveSessionConnectorBindings({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: SESSION_EXPLICIT,
      grantedConnectors: 'all',
    });
    expect(effective).toEqual({ 'bound-member': { connection_id: CONN.boundMemberSpare } });
    expect(effective).toEqual(await perAliasReference(SESSION_EXPLICIT, ALL_SLUGS));
  });

  test('inherit_unbound keeps its pins and the defaults for everything unbound', async () => {
    const effective = await resolveEffectiveSessionConnectorBindings({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: SESSION_INHERIT_UNBOUND,
      grantedConnectors: 'all',
    });
    expect(effective).toEqual(await perAliasReference(SESSION_INHERIT_UNBOUND, ALL_SLUGS));
    expect(effective['bound-member']).toEqual({ connection_id: CONN.boundMemberSpare });
    expect(effective['bound-revoked']).toBeUndefined();
    expect(effective['default-member']).toEqual({ connection_id: CONN.defaultMember });
  });

  test('a grant list resolves only the aliases it names, including unknown and disabled ones', async () => {
    const granted = ['default-member', 'pinned', 'disabled', 'no-such-connector', 'bound-member', 'bound-revoked'];
    const effective = await resolveEffectiveSessionConnectorBindings({
      accountId: ACCOUNT,
      projectId: PROJECT,
      sessionId: SESSION_INHERIT,
      grantedConnectors: granted,
    });
    expect(effective).toEqual(await perAliasReference(SESSION_INHERIT, granted));
    expect(Object.keys(effective).sort()).toEqual(['bound-member', 'default-member', 'pinned']);
  });

  test('an unknown session resolves nothing', async () => {
    expect(
      await resolveEffectiveSessionConnectorBindings({
        accountId: ACCOUNT,
        projectId: PROJECT,
        sessionId: crypto.randomUUID(),
        grantedConnectors: 'all',
      }),
    ).toEqual({});
  });

  test('the query count does not grow with the connector count', async () => {
    const dbQueryCount = await runWithContext('GET', '/test/scope', async () => {
      await resolveEffectiveSessionConnectorBindings({
        accountId: ACCOUNT,
        projectId: PROJECT,
        sessionId: SESSION_INHERIT,
        grantedConnectors: 'all',
      });
      return stageSnapshot().db?.count ?? 0;
    });
    // Measured on this fixture (2026-09-27): 28 queries per alias, 9 batched —
    // session, connectors, bindings, connections, audience, plus one
    // credential check per reachable credentialed connection.
    expect(dbQueryCount).toBeGreaterThan(0);
    expect(dbQueryCount).toBeLessThanOrEqual(12);
  });
});
