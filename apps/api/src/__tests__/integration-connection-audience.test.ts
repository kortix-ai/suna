/**
 * Real-Postgres contract for a shared connector account narrowed to an
 * audience — `connection` object grants in `kortix.role_assignments`.
 *
 *   no grant                  -> everyone who may use the connector (unchanged)
 *   group / member grants     -> only those people, and only in PRIVATE sessions
 *   a grant to the project    -> everyone again
 *
 * Exercised through the functions every connector call goes through:
 * `listEntitledConnectorConnections` (the gateway's account list),
 * `validateSessionConnectorBindings` (session create / scope edit) and
 * `sessionHasPersonalConnectorBinding` (the share-a-session guard).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountGroupMembers,
  accountGroups,
  accountMembers,
  accounts,
  connectorConnections,
  connectors,
  projectSessionConnectorBindings,
  projectSessions,
  projects,
  serviceAccounts,
} from '@kortix/db';
import { eq } from 'drizzle-orm';
import { upsertConnectionCredential } from '../connectors/credentials';
import { assignRole, revokeAssignment, SYSTEM_ACTOR } from '../iam/assignments';
import { clearAuthorizeCaches } from '../iam/authorize';
import {
  listEntitledConnectorConnections,
  sessionConnectorBindingsRequirePrivateVisibility,
  sessionHasPersonalConnectorBinding,
  validateSessionConnectorBindings,
} from '../projects/lib/session-connector-bindings';
import { db } from '../shared/db';
import { insertIntoView } from './helpers/compat-views';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const CONNECTOR = crypto.randomUUID();
const SHARED = crypto.randomUUID();
const SALES = crypto.randomUUID();
const IN_SALES = crypto.randomUUID();
const NOT_IN_SALES = crypto.randomUUID();
const SERVICE_ACCOUNT = crypto.randomUUID();
const SESSION = crypto.randomUUID();

const entitled = async (userId: string, visibility: 'private' | 'project', serviceAccount = false) =>
  (
    await listEntitledConnectorConnections({
      accountId: ACCOUNT,
      projectId: PROJECT,
      alias: 'crm',
      actingUserId: userId,
      actingPrincipalIsServiceAccount: serviceAccount,
      visibility,
    })
  ).map((connection) => connection.connectionId);

const grant = (principal: { type: 'group' | 'project'; id: string }) =>
  assignRole(SYSTEM_ACTOR, ACCOUNT, {
    principal,
    roleKey: 'agent-user',
    scope: { type: 'project', id: PROJECT },
    object: { type: 'connection', id: SHARED },
  });

beforeAll(async () => {
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'connection-audience' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'connection-audience',
    repoUrl: 'https://example.test/connection-audience.git',
  });
  for (const userId of [IN_SALES, NOT_IN_SALES]) {
    await insertIntoView(db, accountMembers, { userId, accountId: ACCOUNT, accountRole: 'member' });
  }
  await db.insert(accountGroups).values({ groupId: SALES, accountId: ACCOUNT, name: 'Sales' });
  await db.insert(accountGroupMembers).values({ groupId: SALES, userId: IN_SALES });
  await db.insert(serviceAccounts).values({
    serviceAccountId: SERVICE_ACCOUNT,
    accountId: ACCOUNT,
    name: `audience-${SERVICE_ACCOUNT}`,
    secretHash: `audience-${SERVICE_ACCOUNT}`,
    publicPrefix: 'kortix_sa_audience',
    createdBy: IN_SALES,
  });
  await db.insert(connectors).values({
    connectorId: CONNECTOR,
    accountId: ACCOUNT,
    projectId: PROJECT,
    slug: 'crm',
    name: 'CRM',
    providerType: 'http',
    config: { baseUrl: 'https://crm.example.test', auth: { type: 'bearer' } },
  });
  await db.insert(connectorConnections).values({
    connectionId: SHARED,
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorId: CONNECTOR,
    ownerType: 'project',
    ownerId: null,
    label: 'Sales CRM',
    status: 'active',
    isDefault: true,
    metadata: {},
  });
  await upsertConnectionCredential({
    projectId: PROJECT,
    connectorId: CONNECTOR,
    connectionId: SHARED,
    value: 'crm-token',
    createdBy: IN_SALES,
  });
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: SESSION,
    createdBy: IN_SALES,
    visibility: 'private',
    connectorBindingsConfigured: true,
  });
  await db.insert(projectSessionConnectorBindings).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorAlias: 'crm',
    connectorId: CONNECTOR,
    connectionId: SHARED,
    source: 'request',
    createdBy: IN_SALES,
  });
  clearAuthorizeCaches();
});

afterAll(async () => {
  // Bindings reference the connector by (account, project, connector, slug),
  // which the project cascade does not reach first.
  await db
    .delete(projectSessionConnectorBindings)
    .where(eq(projectSessionConnectorBindings.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

describe('a shared connector account narrowed to an audience', () => {
  test('with no grant it stays usable by everyone, as before', async () => {
    expect(await entitled(NOT_IN_SALES, 'project')).toEqual([SHARED]);
    expect(await entitled(SERVICE_ACCOUNT, 'project', true)).toEqual([SHARED]);
    expect(
      await sessionHasPersonalConnectorBinding({ accountId: ACCOUNT, projectId: PROJECT, sessionId: SESSION }),
    ).toBe(false);
  });

  test('a group grant narrows it to that group, in private sessions only', async () => {
    const row = await grant({ type: 'group', id: SALES });

    expect(await entitled(IN_SALES, 'private')).toEqual([SHARED]);
    expect(await entitled(NOT_IN_SALES, 'private')).toEqual([]);
    // A shared session would let every other viewer run as this account.
    expect(await entitled(IN_SALES, 'project')).toEqual([]);
    // An unattended automation is in no audience.
    expect(await entitled(SERVICE_ACCOUNT, 'private', true)).toEqual([]);

    const validated = await validateSessionConnectorBindings({
      accountId: ACCOUNT,
      projectId: PROJECT,
      actingUserId: IN_SALES,
      actingPrincipalIsServiceAccount: false,
      mayManageSystemConnections: false,
      bindings: { crm: { connection_id: SHARED } },
    });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.bindings[0]?.personal).toBe(true);
      expect(sessionConnectorBindingsRequirePrivateVisibility(validated.bindings)).toBe(true);
    }
    const refused = await validateSessionConnectorBindings({
      accountId: ACCOUNT,
      projectId: PROJECT,
      actingUserId: NOT_IN_SALES,
      actingPrincipalIsServiceAccount: false,
      mayManageSystemConnections: true,
      bindings: { crm: { connection_id: SHARED } },
    });
    expect(refused.ok).toBe(false);

    expect(
      await sessionHasPersonalConnectorBinding({ accountId: ACCOUNT, projectId: PROJECT, sessionId: SESSION }),
    ).toBe(true);

    await revokeAssignment(SYSTEM_ACTOR, ACCOUNT, row.assignmentId);
    expect(await entitled(NOT_IN_SALES, 'project')).toEqual([SHARED]);
  });

  test('a grant to everyone in the project opens it again, beside a group grant', async () => {
    const sales = await grant({ type: 'group', id: SALES });
    const everyone = await grant({ type: 'project', id: PROJECT });

    expect(await entitled(NOT_IN_SALES, 'project')).toEqual([SHARED]);
    expect(await entitled(SERVICE_ACCOUNT, 'project', true)).toEqual([SHARED]);
    expect(
      await sessionHasPersonalConnectorBinding({ accountId: ACCOUNT, projectId: PROJECT, sessionId: SESSION }),
    ).toBe(false);

    await revokeAssignment(SYSTEM_ACTOR, ACCOUNT, everyone.assignmentId);
    expect(await entitled(NOT_IN_SALES, 'private')).toEqual([]);
    await revokeAssignment(SYSTEM_ACTOR, ACCOUNT, sales.assignmentId);
  });
});
