/**
 * Real-Postgres tenant and resolution contract for session connectors.
 * Run with DATABASE_URL pointed at an isolated migrated database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  chatChannelBindings,
  chatInstalls,
  connectorConnections,
  connectorPolicies,
  connectors,
  connectionCredentials,
  projectSessionConnectorBindings,
  projectSessions,
  projectSecrets,
  projects,
  serviceAccounts,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { deleteAgentMailInstall, saveAgentMailInstall } from '../channels/install-store';
import {
  connectionIsEffectiveProjectDefault,
  connectorIdsWithSharedCredentials,
  credentialExists,
  defaultConnectionIdForConnector,
  deleteCredential,
  ensureDefaultConnection,
  ensureMemberConnection,
  resolveCredentialValue,
  resolveConnectionCredentialValue,
  upsertCredential,
  upsertConnectionOAuth2Credential,
  upsertConnectionCredential,
} from '../connectors/credentials';
import { makeDbGatewayDeps } from '../connectors/db-deps';
import { finalizePipedreamConnectionAuthorization } from '../connectors/pipedream';
import { reconcileEmailConnections } from '../connectors/sync';
import {
  listEntitledConnectorConnections,
  resolveEffectiveSessionConnectorBindings,
  resolveSessionConnectorConnection,
  resolveSessionConnectorConnectionOutcome,
  sessionConnectorBindingsRequirePrivateVisibility,
  validateSessionConnectorBindings,
} from '../projects/lib/session-connector-bindings';
import { encryptProjectSecret } from '../projects/secrets';
import { db } from '../shared/db';

const ACCOUNT_A = crypto.randomUUID();
const ACCOUNT_B = crypto.randomUUID();
const PROJECT_A = crypto.randomUUID();
const PROJECT_B = crypto.randomUUID();
const CONNECTOR_A = crypto.randomUUID();
const CONNECTOR_B = crypto.randomUUID();
const EMAIL_CONNECTOR = crypto.randomUUID();
const MISSING_CONNECTOR_A = crypto.randomUUID();
const MISSING_CONNECTOR_B = crypto.randomUUID();
const SECRET_CONNECTOR = crypto.randomUUID();
const CONNECTION_DEFAULT = crypto.randomUUID();
const CONNECTION_A = crypto.randomUUID();
const CONNECTION_B = crypto.randomUUID();
const CONNECTION_EXTERNAL = crypto.randomUUID();
const CONNECTION_SERVICE_ACCOUNT = crypto.randomUUID();
const EMAIL_CONNECTION_DEFAULT = crypto.randomUUID();
const SECRET_CONNECTION_DEFAULT = crypto.randomUUID();
const FOREIGN_CONNECTION = crypto.randomUUID();
const SESSION_A = crypto.randomUUID();
const SESSION_B = crypto.randomUUID();
const SESSION_DEFAULT = crypto.randomUUID();
const SESSION_IMPERSONATION = crypto.randomUUID();
const SESSION_SERVICE_ACCOUNT = crypto.randomUUID();
const SESSION_AUTO_EMAIL = crypto.randomUUID();
const SESSION_INHERIT_UNBOUND = crypto.randomUUID();
const SESSION_EXPLICIT_EMPTY = crypto.randomUUID();
const USER = crypto.randomUUID();
const OTHER_USER = crypto.randomUUID();
const SERVICE_ACCOUNT = crypto.randomUUID();

beforeAll(async () => {
  await db.insert(accounts).values([
    { accountId: ACCOUNT_A, name: 'connection-test-a' },
    { accountId: ACCOUNT_B, name: 'connection-test-b' },
  ]);
  await db.insert(projects).values([
    {
      projectId: PROJECT_A,
      accountId: ACCOUNT_A,
      name: 'connection-test-a',
      repoUrl: 'https://example.test/connection-a.git',
    },
    {
      projectId: PROJECT_B,
      accountId: ACCOUNT_B,
      name: 'connection-test-b',
      repoUrl: 'https://example.test/connection-b.git',
    },
  ]);
  await db.insert(serviceAccounts).values({
    serviceAccountId: SERVICE_ACCOUNT,
    accountId: ACCOUNT_A,
    name: `connection-test-service-account-${SERVICE_ACCOUNT}`,
    secretHash: `connection-test-${SERVICE_ACCOUNT}`,
    publicPrefix: 'kortix_sa_connection_test',
    createdBy: USER,
  });
  await db.insert(connectors).values([
    {
      connectorId: CONNECTOR_A,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      slug: 'veyris',
      name: 'VEYRIS',
      providerType: 'http',
      config: { baseUrl: 'https://veyris.example.test', auth: { type: 'bearer' } },
      authorizationStrategy: 'user',
    },
    {
      connectorId: CONNECTOR_B,
      accountId: ACCOUNT_B,
      projectId: PROJECT_B,
      slug: 'veyris',
      name: 'VEYRIS foreign',
      providerType: 'http',
      config: { baseUrl: 'https://veyris.example.test', auth: { type: 'bearer' } },
    },
    {
      connectorId: EMAIL_CONNECTOR,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      slug: 'kortix_email',
      name: 'Email',
      providerType: 'channel',
      config: { platform: 'email' },
    },
    {
      connectorId: MISSING_CONNECTOR_A,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      slug: 'missing_one',
      name: 'Missing one',
      providerType: 'http',
      config: { baseUrl: 'https://missing-one.example.test', auth: { type: 'bearer' } },
      authorizationStrategy: 'project',
    },
    {
      connectorId: MISSING_CONNECTOR_B,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      slug: 'missing_two',
      name: 'Missing two',
      providerType: 'http',
      config: { baseUrl: 'https://missing-two.example.test', auth: { type: 'bearer' } },
      authorizationStrategy: 'user',
    },
    {
      connectorId: SECRET_CONNECTOR,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      slug: 'secret_backed',
      name: 'Secret-backed connector',
      providerType: 'http',
      config: { baseUrl: 'https://secret-backed.example.test', auth: { type: 'bearer' } },
      authSecret: 'CONNECTOR_BOUNDARY_KEY',
      authorizationStrategy: 'project',
    },
  ]);
  await db.insert(connectorPolicies).values({
    connectorId: CONNECTOR_A,
    match: '*',
    action: 'block',
    position: 0,
  });
  await db.insert(connectorConnections).values([
    {
      connectionId: CONNECTION_DEFAULT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      label: 'Default workspace',
      isDefault: true,
    },
    {
      connectionId: CONNECTION_A,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      ownerType: 'member',
      ownerId: USER,
      label: 'My workspace',
    },
    {
      connectionId: CONNECTION_B,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      ownerType: 'member',
      ownerId: OTHER_USER,
      label: 'Another member workspace',
    },
    {
      connectionId: CONNECTION_EXTERNAL,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      ownerType: 'external',
      ownerId: 'managed-workspace',
      label: 'Managed workspace',
    },
    {
      connectionId: CONNECTION_SERVICE_ACCOUNT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      ownerType: 'member',
      ownerId: SERVICE_ACCOUNT,
      label: 'Forged service-account workspace',
    },
    {
      connectionId: EMAIL_CONNECTION_DEFAULT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: EMAIL_CONNECTOR,
      label: 'Default email',
      isDefault: true,
    },
    {
      connectionId: SECRET_CONNECTION_DEFAULT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: SECRET_CONNECTOR,
      label: 'Secret-backed default',
      isDefault: true,
    },
    {
      connectionId: FOREIGN_CONNECTION,
      accountId: ACCOUNT_B,
      projectId: PROJECT_B,
      connectorId: CONNECTOR_B,
      label: 'Foreign default',
      isDefault: true,
    },
  ]);
  await db.insert(projectSessions).values([
    {
      sessionId: SESSION_A,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      branchName: SESSION_A,
      createdBy: USER,
      connectorBindingsConfigured: true,
    },
    {
      sessionId: SESSION_B,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      branchName: SESSION_B,
      createdBy: OTHER_USER,
      connectorBindingsConfigured: true,
    },
    {
      sessionId: SESSION_DEFAULT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      branchName: SESSION_DEFAULT,
      createdBy: USER,
    },
    {
      sessionId: SESSION_IMPERSONATION,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      branchName: SESSION_IMPERSONATION,
      createdBy: USER,
      visibility: 'private',
      connectorBindingsConfigured: true,
    },
    {
      sessionId: SESSION_SERVICE_ACCOUNT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      branchName: SESSION_SERVICE_ACCOUNT,
      createdBy: SERVICE_ACCOUNT,
      visibility: 'private',
      connectorBindingsConfigured: true,
    },
    {
      sessionId: SESSION_AUTO_EMAIL,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      branchName: SESSION_AUTO_EMAIL,
      createdBy: USER,
    },
    {
      sessionId: SESSION_INHERIT_UNBOUND,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      branchName: SESSION_INHERIT_UNBOUND,
      createdBy: USER,
      connectorBindingsConfigured: true,
      connectorBindingsInheritUnbound: true,
    },
    {
      sessionId: SESSION_EXPLICIT_EMPTY,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      branchName: SESSION_EXPLICIT_EMPTY,
      createdBy: USER,
      connectorBindingsConfigured: true,
    },
  ]);
  await db.insert(projectSessionConnectorBindings).values([
    {
      sessionId: SESSION_A,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_A,
      connectionId: CONNECTION_A,
      source: 'request',
      createdBy: USER,
    },
    {
      sessionId: SESSION_B,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_A,
      connectionId: CONNECTION_B,
      source: 'request',
      createdBy: USER,
    },
    {
      sessionId: SESSION_IMPERSONATION,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_A,
      connectionId: CONNECTION_B,
      source: 'request',
      createdBy: USER,
    },
    {
      sessionId: SESSION_SERVICE_ACCOUNT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_A,
      connectionId: CONNECTION_SERVICE_ACCOUNT,
      source: 'request',
      createdBy: SERVICE_ACCOUNT,
    },
    // Auto-wired by the platform (ensureEmailSessionBinding), NOT caller-chosen —
    // source: 'default'. Must not trip the all-or-nothing gate for OTHER aliases.
    {
      sessionId: SESSION_AUTO_EMAIL,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorAlias: 'kortix_email',
      connectorId: EMAIL_CONNECTOR,
      connectionId: EMAIL_CONNECTION_DEFAULT,
      source: 'default',
      createdBy: null,
    },
    {
      sessionId: SESSION_DEFAULT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorAlias: 'secret_backed',
      connectorId: SECRET_CONNECTOR,
      connectionId: SECRET_CONNECTION_DEFAULT,
      source: 'default',
      createdBy: null,
    },
    // A caller-REQUESTED (source: 'request') veyris binding on an inherit_unbound
    // session — the explicit binding still wins, and unbound aliases fall back.
    {
      sessionId: SESSION_INHERIT_UNBOUND,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_A,
      connectionId: CONNECTION_A,
      source: 'request',
      createdBy: USER,
    },
  ]);
  await db.insert(connectionCredentials).values([
    {
      connectorId: CONNECTOR_A,
      connectionId: CONNECTION_DEFAULT,
      valueEnc: encryptProjectSecret(PROJECT_A, 'default-capability'),
    },
    {
      connectorId: CONNECTOR_A,
      connectionId: CONNECTION_A,
      valueEnc: encryptProjectSecret(PROJECT_A, 'workspace-a-capability'),
    },
    {
      connectorId: CONNECTOR_A,
      connectionId: CONNECTION_B,
      valueEnc: encryptProjectSecret(PROJECT_A, 'workspace-b-capability'),
    },
  ]);
  await db.insert(projectSecrets).values({
    projectId: PROJECT_A,
    identifier: 'CONNECTOR_BOUNDARY_KEY',
    name: 'CONNECTOR_BOUNDARY_KEY',
    valueEnc: encryptProjectSecret(PROJECT_A, 'connector-boundary-value'),
    strategy: 'broker',
    consumer: 'connector',
    createdBy: USER,
    rotatedAt: new Date(),
  });
  await saveAgentMailInstall({
    projectId: PROJECT_A,
    connectionSlug: 'kortix_email',
    inboxId: 'connection-test-default-inbox',
    email: 'default@example.test',
    displayName: 'Default inbox',
    apiKey: 'agentmail-key',
  });
});

afterAll(async () => {
  await deleteAgentMailInstall(PROJECT_A, 'kortix_email');
  await db.delete(connectionCredentials).where(eq(connectionCredentials.connectorId, CONNECTOR_A));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT_A));
  await db
    .delete(connectorConnections)
    .where(eq(connectorConnections.projectId, PROJECT_A));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_A));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_B));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_A));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_B));
});

describe('session connector isolation', () => {
  test('two users sessions resolve only their distinct connections and credentials', async () => {
    const a = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_A,
      alias: 'veyris',
    });
    const b = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_B,
      alias: 'veyris',
    });
    expect(a?.connectionId).toBe(CONNECTION_A);
    expect(b?.connectionId).toBe(CONNECTION_B);
    if (!a || !b) throw new Error('Expected both bound connections');
    expect(
      await resolveConnectionCredentialValue({ connectorId: CONNECTOR_A, connectionId: a.connectionId }),
    ).toBe('workspace-a-capability');
    expect(
      await resolveConnectionCredentialValue({ connectorId: CONNECTOR_A, connectionId: b.connectionId }),
    ).toBe('workspace-b-capability');
  });

  test('real Connector deps resolve only the authenticated session connection', async () => {
    const principal = (sessionId: string, userId: string) => ({
      userId,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId,
      subject: { userId, groupIds: [] },
      agentGrant: { agent: 'veyris', connectors: ['veyris'] as string[], permissions: [] },
    });
    const depsA = makeDbGatewayDeps(principal(SESSION_A, USER));
    const depsB = makeDbGatewayDeps(principal(SESSION_B, OTHER_USER));
    const connectorA = await depsA.loadConnectorBySlug(PROJECT_A, 'veyris');
    const connectorB = await depsB.loadConnectorBySlug(PROJECT_A, 'veyris');
    expect(connectorA?.connectionId).toBe(CONNECTION_A);
    expect(connectorB?.connectionId).toBe(CONNECTION_B);
    if (!connectorA || !connectorB) throw new Error('Expected both gateway connectors');
    expect(await depsA.resolveCredential(connectorA, null)).toBe('workspace-a-capability');
    expect(await depsB.resolveCredential(connectorB, null)).toBe('workspace-b-capability');
    expect(await depsA.loadPolicies(connectorA.connectorId)).toEqual([
      { match: '*', action: 'block', conditions: null, position: 0 },
    ]);
    expect(await depsB.loadPolicies(connectorB.connectorId)).toEqual([
      { match: '*', action: 'block', conditions: null, position: 0 },
    ]);
  });

  test('real connector deps resolve a manifest secret only through the connector boundary', async () => {
    const deps = makeDbGatewayDeps({
      userId: USER,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_DEFAULT,
      subject: { userId: USER, groupIds: [] },
      agentGrant: { agent: 'secret-agent', connectors: ['secret_backed'], permissions: [] },
    });
    const connector = await deps.loadConnectorBySlug(PROJECT_A, 'secret_backed');
    if (!connector) throw new Error('Expected secret-backed connector');

    expect(connector.authSecret).toBe('CONNECTOR_BOUNDARY_KEY');
    expect(await deps.resolveCredential(connector, null)).toBe('connector-boundary-value');
  });

  // THE RULE (2026-09-16): CONNECTOR_A is reachable to USER through TWO
  // accounts here — their own unpinned CONNECTION_A, and the project's PINNED
  // CONNECTION_DEFAULT. An unnamed call no longer rank-picks "mine" first
  // when something is actually pinned — it honors the pin (see
  // `selectEntitledConnectorConnection`) — so proving "the member's own
  // authorization is reachable" now requires naming it explicitly.
  test("account: 'me' resolves the acting member's own authorization, even though the project also has a pinned default", async () => {
    const resolved = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_DEFAULT,
      alias: 'veyris',
      account: 'me',
    });
    expect(resolved).toMatchObject({
      connectionId: CONNECTION_A,
      source: 'default',
    });
  });

  test('an omitted account resolves the PINNED project default over an unpinned member row', async () => {
    const resolved = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_DEFAULT,
      alias: 'veyris',
    });
    expect(resolved).toMatchObject({
      connectionId: CONNECTION_DEFAULT,
      isDefault: true,
      source: 'default',
    });
  });

  test('effective scope materializes runtime defaults and preserves explicit binding state', async () => {
    // veyris materializes the PINNED project default (CONNECTION_DEFAULT) —
    // `resolveEffectiveSessionConnectorBindings` has no per-alias `account` to
    // name, and the pin is a deliberate choice, so this is the correct
    // unnamed resolution (see the "omitted account" test above).
    expect(
      await resolveEffectiveSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_DEFAULT,
        grantedConnectors: ['veyris', 'email'],
      }),
    ).toEqual({
      veyris: { connection_id: CONNECTION_DEFAULT },
      email: { connection_id: EMAIL_CONNECTION_DEFAULT },
    });

    expect(
      await resolveEffectiveSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_EXPLICIT_EMPTY,
        grantedConnectors: ['veyris', 'email'],
      }),
    ).toEqual({});

    expect(
      await resolveEffectiveSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_A,
        grantedConnectors: ['veyris', 'email'],
      }),
    ).toEqual({
      veyris: { connection_id: CONNECTION_A },
    });

    expect(
      await resolveEffectiveSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_A,
        grantedConnectors: [],
      }),
    ).toEqual({});

    expect(
      await resolveEffectiveSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_INHERIT_UNBOUND,
        grantedConnectors: ['veyris', 'email'],
      }),
    ).toEqual({
      veyris: { connection_id: CONNECTION_A },
      email: { connection_id: EMAIL_CONNECTION_DEFAULT },
    });
  });

  test("an omitted user-strategy binding never resolves another member's authorization, pinned or not", async () => {
    await db
      .update(connectorConnections)
      .set({ isDefault: true })
      .where(eq(connectorConnections.connectionId, CONNECTION_B));
    try {
      // `account: 'me'` proves reachability is per-row: CONNECTION_B is
      // OTHER_USER's own, marked default or not, and is never reachable to
      // USER — the caller's own row is what "me" resolves regardless.
      const asMe = await resolveSessionConnectorConnection({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_DEFAULT,
        alias: 'veyris',
        account: 'me',
      });
      expect(asMe?.connectionId).toBe(CONNECTION_A);
      expect(asMe?.connectionId).not.toBe(CONNECTION_B);

      // The unnamed resolution also never reaches CONNECTION_B — it is not in
      // USER's entitled list at all, pinned or not — and instead honors the
      // project's own pin (CONNECTION_DEFAULT), same as the un-pinned case.
      const unnamed = await resolveSessionConnectorConnection({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_DEFAULT,
        alias: 'veyris',
      });
      expect(unnamed?.connectionId).toBe(CONNECTION_DEFAULT);
      expect(unnamed?.connectionId).not.toBe(CONNECTION_B);
    } finally {
      await db
        .update(connectorConnections)
        .set({ isDefault: false })
        .where(eq(connectorConnections.connectionId, CONNECTION_B));
    }
  });

  test('a partially bound session fails closed for every unbound connector alias', async () => {
    const boundSessionEmail = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_A,
      alias: 'kortix_email',
    });
    expect(boundSessionEmail).toBeNull();

    const legacySessionEmail = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_DEFAULT,
      alias: 'kortix_email',
    });
    expect(legacySessionEmail).toMatchObject({
      connectionId: EMAIL_CONNECTION_DEFAULT,
      isDefault: true,
      source: 'default',
    });
  });

  test('inherit_unbound keeps the project-default fallback for unbound aliases while the explicit binding still wins', async () => {
    // SESSION_INHERIT_UNBOUND binds veyris (source: request) AND was created with
    // connector_bindings_inherit_unbound = true. The explicit veyris binding must
    // still win, but an UNBOUND alias (kortix_email) must fall through to the
    // project default instead of failing closed the way SESSION_A does above.
    const boundVeyris = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_INHERIT_UNBOUND,
      alias: 'veyris',
    });
    expect(boundVeyris).toMatchObject({ connectionId: CONNECTION_A, source: 'request' });

    const unboundEmail = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_INHERIT_UNBOUND,
      alias: 'kortix_email',
    });
    expect(unboundEmail).toMatchObject({
      connectionId: EMAIL_CONNECTION_DEFAULT,
      isDefault: true,
      source: 'default',
    });
  });

  test('an auto-wired email binding does not disable default fallback for other connectors', async () => {
    // SESSION_AUTO_EMAIL has ONLY a source: 'default' email binding (as minted by
    // ensureEmailSessionBinding) — the caller never opted into explicit-only
    // selection. Its email alias resolves via that bound row…
    const email = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_AUTO_EMAIL,
      alias: 'kortix_email',
    });
    expect(email).toMatchObject({ connectionId: EMAIL_CONNECTION_DEFAULT });

    // …and an UNBOUND alias still falls back to the project default, instead of
    // failing closed the way a caller-requested (source: 'request') binding
    // would. It resolves the PINNED CONNECTION_DEFAULT (see the "omitted
    // account" test above) — the point here is that it falls through AT ALL,
    // not which of the several reachable accounts wins that unnamed pick.
    const veyris = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_AUTO_EMAIL,
      alias: 'veyris',
    });
    expect(veyris).toMatchObject({
      connectionId: CONNECTION_DEFAULT,
      source: 'default',
    });
  });

  test('Connector ignores user-writable email routing metadata', async () => {
    await db
      .update(projectSessions)
      .set({
        metadata: {
          email: {
            inbox_id: 'inbox-attacker',
            thread_id: 'thread-attacker',
            message_id: 'message-attacker',
          },
        },
      })
      .where(eq(projectSessions.sessionId, SESSION_DEFAULT));

    const deps = makeDbGatewayDeps({
      userId: USER,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_DEFAULT,
      subject: { userId: USER, groupIds: [] },
      agentGrant: { agent: 'veyris', connectors: ['kortix_email'], permissions: [] },
    });
    expect(await deps.loadEmailSessionContext?.(PROJECT_A, SESSION_DEFAULT)).toBeNull();
  });

  test('cross-project connection selection is rejected before session insert', async () => {
    const result = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      actingPrincipalIsServiceAccount: false,
      mayManageSystemConnections: true,
      bindings: { veyris: { connection_id: FOREIGN_CONNECTION } },
    });
    expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_CONNECTION_NOT_FOUND' });
  });

  test('a member may bind their own personal connection', async () => {
    const result = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      actingPrincipalIsServiceAccount: false,
      mayManageSystemConnections: false,
      bindings: { veyris: { connection_id: CONNECTION_A } },
    });
    expect(result).toMatchObject({
      ok: true,
      bindings: [{ alias: 'veyris', connectionId: CONNECTION_A, ownerType: 'member' }],
    });
    if (!result.ok) throw new Error('Expected owner binding to validate');
    expect(sessionConnectorBindingsRequirePrivateVisibility(result.bindings)).toBe(true);
  });

  test('manager privileges never allow binding another member personal connection', async () => {
    const result = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      actingPrincipalIsServiceAccount: false,
      mayManageSystemConnections: true,
      bindings: { veyris: { connection_id: CONNECTION_B } },
    });
    expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_CONNECTION_NOT_FOUND' });
  });

  test('a service account cannot bind a member connection even when the owner id matches', async () => {
    const result = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: SERVICE_ACCOUNT,
      actingPrincipalIsServiceAccount: true,
      mayManageSystemConnections: true,
      bindings: { veyris: { connection_id: CONNECTION_SERVICE_ACCOUNT } },
    });
    expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_CONNECTION_NOT_FOUND' });
  });

  test('Connector rejects a pre-existing session bound to another member connection', async () => {
    const resolved = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_IMPERSONATION,
      alias: 'veyris',
    });
    expect(resolved).toBeNull();
  });

  test('Connector rejects a pre-existing service-account session bound to a member connection', async () => {
    const resolved = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_SERVICE_ACCOUNT,
      alias: 'veyris',
    });
    expect(resolved).toBeNull();
  });

  // Reachability is a property of the ROW (connection-access.ts), never of the
  // connector's (retired) authorization_strategy — proven here by getting the
  // SAME verdicts under BOTH strategy values. A project-owned row is always
  // reachable; a member owns their own row regardless of a manage-capability
  // bypass; an external/unmanaged row is reachable by nobody, capability or
  // not — that invariant is what actually matters and did not change.
  test('connection reachability is per-row, not per-connector — the (retired) strategy never changes the verdict', async () => {
    for (const strategy of ['project', 'user'] as const) {
      await db
        .update(connectors)
        .set({ authorizationStrategy: strategy })
        .where(eq(connectors.connectorId, CONNECTOR_A));
      const projectOwned = await validateSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        actingUserId: USER,
        actingPrincipalIsServiceAccount: false,
        mayManageSystemConnections: false,
        bindings: { veyris: { connection_id: CONNECTION_DEFAULT } },
      });
      const ownMemberConnection = await validateSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        actingUserId: USER,
        actingPrincipalIsServiceAccount: false,
        // No manage capability needed — CONNECTION_A is USER's own row.
        mayManageSystemConnections: false,
        bindings: { veyris: { connection_id: CONNECTION_A } },
      });
      const unmanagedSystem = await validateSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        actingUserId: USER,
        actingPrincipalIsServiceAccount: false,
        mayManageSystemConnections: true,
        bindings: { veyris: { connection_id: CONNECTION_EXTERNAL } },
      });
      expect(projectOwned).toMatchObject({ ok: true });
      expect(ownMemberConnection).toMatchObject({ ok: true });
      expect(unmanagedSystem).toMatchObject({
        ok: false,
        code: 'CONNECTOR_CONNECTION_NOT_FOUND',
      });
    }
    await db
      .update(connectors)
      .set({ authorizationStrategy: 'user' })
      .where(eq(connectors.connectorId, CONNECTOR_A));
  });

  test('a personal-connection binding fails closed if the session becomes shared', async () => {
    await db
      .update(projectSessions)
      .set({ visibility: 'project' })
      .where(eq(projectSessions.sessionId, SESSION_A));
    const resolved = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_A,
      alias: 'veyris',
    });
    expect(resolved).toBeNull();
    await db
      .update(projectSessions)
      .set({ visibility: 'private' })
      .where(eq(projectSessions.sessionId, SESSION_A));
  });

  test('database rejects alias/connection tenant mismatch', async () => {
    let code: string | undefined;
    try {
      await db.insert(projectSessionConnectorBindings).values({
        sessionId: SESSION_DEFAULT,
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        connectorAlias: 'wrong-alias',
        connectorId: CONNECTOR_A,
        connectionId: CONNECTION_A,
        source: 'request',
      });
    } catch (error) {
      code = (error as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe('23503');
  });

  test('connection revocation takes effect on the next resolution without restart', async () => {
    await db
      .update(connectorConnections)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(connectorConnections.connectionId, CONNECTION_A));
    const resolved = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_A,
      alias: 'veyris',
    });
    expect(resolved).toBeNull();
    await db
      .update(connectorConnections)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(connectorConnections.connectionId, CONNECTION_A));
  });

  test('credential removal takes effect on the next resolution without restart', async () => {
    await db
      .delete(connectionCredentials)
      .where(
        and(
          eq(connectionCredentials.connectorId, CONNECTOR_A),
          eq(connectionCredentials.connectionId, CONNECTION_A),
        ),
      );
    try {
      const resolved = await resolveSessionConnectorConnection({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_A,
        alias: 'veyris',
      });
      expect(resolved).toBeNull();
    } finally {
      await upsertConnectionCredential({
        projectId: PROJECT_A,
        connectorId: CONNECTOR_A,
        connectionId: CONNECTION_A,
        value: 'workspace-a-capability',
        createdBy: USER,
      });
    }
  });

  // SESSION_A is bound to CONNECTION_A, USER's own member-owned row on
  // CONNECTOR_A. Flipping the connector's (retired) authorization_strategy
  // used to invalidate that binding on the next resolution — the exact bug
  // this initiative retires the flag over. It must now have NO effect: the
  // binding resolves the same way regardless of the flag's value.
  test('the (retired) authorization strategy no longer affects resolution on the next call', async () => {
    for (const strategy of ['project', 'user'] as const) {
      await db
        .update(connectors)
        .set({ authorizationStrategy: strategy })
        .where(eq(connectors.connectorId, CONNECTOR_A));
      const resolved = await resolveSessionConnectorConnection({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_A,
        alias: 'veyris',
      });
      expect(resolved).toMatchObject({ connectionId: CONNECTION_A, ownerType: 'member' });
      // No actingUserId supplied here, so the member-owned row (CONNECTION_A)
      // is never entitled — but the project-owned default (CONNECTION_DEFAULT)
      // is unconditionally reachable regardless of identity or strategy, and
      // stays the sole entry in both directions of the flip.
      expect(
        (
          await listEntitledConnectorConnections({
            accountId: ACCOUNT_A,
            projectId: PROJECT_A,
            alias: 'veyris',
          })
        ).map((c) => c.connectionId),
      ).toEqual([CONNECTION_DEFAULT]);
    }
  });

  test('Pipedream finalize reads and stores the account under the connection-specific identity', async () => {
    const realFetch = globalThis.fetch;
    let accountsUrl = '';
    globalThis.fetch = (async (url: string) => {
      const value = String(url);
      if (value.includes('/v1/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'pd-connection-test', expires_in: 3600 }), {
          status: 200,
        });
      }
      if (value.includes('/accounts?')) {
        accountsUrl = value;
        return new Response(
          JSON.stringify({
            data: [{ id: 'apn_connection_a', app: { name_slug: 'veyris', name: 'VEYRIS' } }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected Pipedream request: ${value}`);
    }) as typeof fetch;
    try {
      const result = await finalizePipedreamConnectionAuthorization({
        projectId: PROJECT_A,
        slug: 'veyris',
        app: 'veyris',
        connectorId: CONNECTOR_A,
        connectionId: CONNECTION_A,
        createdBy: USER,
      });
      expect(result).toEqual({ connected: true, accountId: 'apn_connection_a' });
      expect(new URL(accountsUrl).searchParams.get('external_user_id')).toBe(
        `${PROJECT_A}:veyris:${CONNECTION_A}`,
      );
      expect(
        await resolveConnectionCredentialValue({ connectorId: CONNECTOR_A, connectionId: CONNECTION_A }),
      ).toBe('apn_connection_a');
    } finally {
      globalThis.fetch = realFetch;
      await upsertConnectionCredential({
        projectId: PROJECT_A,
        connectorId: CONNECTOR_A,
        connectionId: CONNECTION_A,
        value: 'workspace-a-capability',
        createdBy: USER,
      });
    }
  });

  test('legacy/default credential helpers never read, overwrite or delete custom connections', async () => {
    expect(await resolveCredentialValue(CONNECTOR_A, null)).toBe('default-capability');
    await upsertCredential({
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      userId: null,
      value: 'rotated-default',
    });
    expect(await resolveCredentialValue(CONNECTOR_A, null)).toBe('rotated-default');
    expect(
      await resolveConnectionCredentialValue({ connectorId: CONNECTOR_A, connectionId: CONNECTION_A }),
    ).toBe('workspace-a-capability');
    await deleteCredential(CONNECTOR_A, null);
    expect(await resolveCredentialValue(CONNECTOR_A, null)).toBeNull();
    expect(
      await resolveConnectionCredentialValue({ connectorId: CONNECTOR_A, connectionId: CONNECTION_B }),
    ).toBe('workspace-b-capability');
    await upsertCredential({
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      userId: null,
      value: 'default-capability',
    });
  });

  test('OAuth2 connection credentials refresh once and persist the fresh access token', async () => {
    let acquisitions = 0;
    const acquire = async () => {
      acquisitions += 1;
      return {
        access_token: `oauth-access-${acquisitions}`,
        token_type: 'Bearer',
        expires_at: acquisitions === 1 ? 0 : Date.now() + 3_600_000,
        scopes: ['https://graph.microsoft.com/.default'],
      };
    };
    try {
      await upsertConnectionOAuth2Credential(
        {
          projectId: PROJECT_A,
          connectorId: CONNECTOR_A,
          connectionId: CONNECTION_A,
          oauth2: {
            type: 'oauth2_client_credentials',
            token_url: 'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
            client_id: 'client-id',
            token_endpoint_auth_method: 'client_secret_post',
            client_secret: 'client-secret',
            scopes: ['https://graph.microsoft.com/.default'],
          },
          createdBy: USER,
        },
        { acquire },
      );
      expect(
        await resolveConnectionCredentialValue(
          { connectorId: CONNECTOR_A, connectionId: CONNECTION_A },
          { acquire },
        ),
      ).toBe('oauth-access-2');
      expect(
        await resolveConnectionCredentialValue(
          { connectorId: CONNECTOR_A, connectionId: CONNECTION_A },
          { acquire },
        ),
      ).toBe('oauth-access-2');
      expect(acquisitions).toBe(2);
    } finally {
      await upsertConnectionCredential({
        projectId: PROJECT_A,
        connectorId: CONNECTOR_A,
        connectionId: CONNECTION_A,
        value: 'workspace-a-capability',
        createdBy: USER,
      });
    }
  });

  test('OAuth2 connection credentials serialize concurrent refreshes in PostgreSQL', async () => {
    let acquisitions = 0;
    const acquire = async () => {
      acquisitions += 1;
      if (acquisitions > 1) await Bun.sleep(25);
      return {
        access_token: `oauth-concurrent-${acquisitions}`,
        token_type: 'Bearer',
        expires_at: acquisitions === 1 ? 0 : Date.now() + 3_600_000,
        scopes: [],
      };
    };
    try {
      await upsertConnectionOAuth2Credential(
        {
          projectId: PROJECT_A,
          connectorId: CONNECTOR_A,
          connectionId: CONNECTION_A,
          oauth2: {
            type: 'oauth2_client_credentials',
            token_url: 'https://login.example.com/token',
            client_id: 'client-id',
            token_endpoint_auth_method: 'client_secret_post',
            client_secret: 'client-secret',
          },
        },
        { acquire },
      );
      const values = await Promise.all(
        Array.from({ length: 6 }, () =>
          resolveConnectionCredentialValue(
            { connectorId: CONNECTOR_A, connectionId: CONNECTION_A },
            { acquire },
          ),
        ),
      );
      expect(new Set(values)).toEqual(new Set(['oauth-concurrent-2']));
      expect(acquisitions).toBe(2);
    } finally {
      await upsertConnectionCredential({
        projectId: PROJECT_A,
        connectorId: CONNECTOR_A,
        connectionId: CONNECTION_A,
        value: 'workspace-a-capability',
        createdBy: USER,
      });
    }
  });

  test('AgentMail connections stay immutable per inbox and revoke on partial or final disconnect', async () => {
    await saveAgentMailInstall({
      projectId: PROJECT_A,
      connectionSlug: 'workspace_a',
      inboxId: 'inbox-workspace-a',
      email: 'a@example.test',
      displayName: 'Workspace A',
      apiKey: 'agentmail-key',
    });
    await saveAgentMailInstall({
      projectId: PROJECT_A,
      connectionSlug: 'workspace_b',
      inboxId: 'inbox-workspace-b',
      email: 'b@example.test',
      displayName: 'Workspace B',
      apiKey: 'agentmail-key',
    });
    await reconcileEmailConnections(PROJECT_A, ACCOUNT_A);

    const connections = await db
      .select({
        connectionId: connectorConnections.connectionId,
        ownerId: connectorConnections.ownerId,
        status: connectorConnections.status,
        metadata: connectorConnections.metadata,
      })
      .from(connectorConnections)
      .where(eq(connectorConnections.connectorId, EMAIL_CONNECTOR));
    const connectionA = connections.find((connection) => connection.ownerId === 'agentmail:inbox-workspace-a');
    const connectionB = connections.find((connection) => connection.ownerId === 'agentmail:inbox-workspace-b');
    expect(connectionA?.status).toBe('active');
    expect(connectionB?.status).toBe('active');
    expect(connectionA?.metadata).toMatchObject({
      connector_slug: 'workspace_a',
      inbox_id: 'inbox-workspace-a',
    });
    expect(connectionB?.metadata).toMatchObject({
      connector_slug: 'workspace_b',
      inbox_id: 'inbox-workspace-b',
    });
    if (!connectionA || !connectionB) throw new Error('Expected both AgentMail connections');

    await deleteAgentMailInstall(PROJECT_A, 'workspace_a');
    await reconcileEmailConnections(PROJECT_A, ACCOUNT_A);
    const [afterPartial] = await db
      .select({ status: connectorConnections.status })
      .from(connectorConnections)
      .where(eq(connectorConnections.connectionId, connectionA.connectionId));
    expect(afterPartial?.status).toBe('revoked');

    await deleteAgentMailInstall(PROJECT_A, 'workspace_b');
    await reconcileEmailConnections(PROJECT_A, ACCOUNT_A);
    const [afterFinal] = await db
      .select({ status: connectorConnections.status })
      .from(connectorConnections)
      .where(eq(connectorConnections.connectionId, connectionB.connectionId));
    expect(afterFinal?.status).toBe('revoked');
  });

  test('AgentMail installation persists and removes its explicit channel-agent binding', async () => {
    const connectionSlug = 'veyris_bound';
    const inboxId = 'inbox-veyris-bound';
    await saveAgentMailInstall({
      projectId: PROJECT_A,
      connectionSlug,
      inboxId,
      email: 'veyris-bound@example.test',
      displayName: 'Veyris bound inbox',
      apiKey: 'agentmail-key',
      agentName: 'veyris',
    });

    const [binding] = await db
      .select({
        projectId: chatChannelBindings.projectId,
        channelId: chatChannelBindings.channelId,
        channelName: chatChannelBindings.channelName,
        channelType: chatChannelBindings.channelType,
        agentName: chatChannelBindings.agentName,
      })
      .from(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'email'),
          eq(chatChannelBindings.workspaceId, inboxId),
          eq(chatChannelBindings.channelId, connectionSlug),
        ),
      );
    expect(binding).toEqual({
      projectId: PROJECT_A,
      channelId: connectionSlug,
      channelName: 'veyris-bound@example.test',
      channelType: 'inbox',
      agentName: 'veyris',
    });

    await deleteAgentMailInstall(PROJECT_A, connectionSlug);
    const rows = await db
      .select({ bindingId: chatChannelBindings.bindingId })
      .from(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'email'),
          eq(chatChannelBindings.workspaceId, inboxId),
          eq(chatChannelBindings.channelId, connectionSlug),
        ),
      );
    expect(rows).toEqual([]);
  });

  test('saveAgentMailInstall does not delete another project chat_installs row for the same inbox (pentest 2026-07-27)', async () => {
    // Regression for the AgentMail inbox hijack. PROJECT_A claims inbox
    // "shared-inbox". PROJECT_B then claims the SAME inbox. Before the fix,
    // saveAgentMailInstall ran an unscoped DELETE (platform + workspaceId only)
    // that wiped PROJECT_A's chat_installs row. With the fix, the DELETE is
    // scoped to the calling project, so both rows coexist (unique index allows
    // multiple projects per inbox) and resolveProjectForAgentMailInbox keeps
    // returning PROJECT_A for PROJECT_A's install.
    const sharedInbox = 'shared-inbox-hijack-test';
    await saveAgentMailInstall({
      projectId: PROJECT_A,
      connectionSlug: 'kortix_email',
      inboxId: sharedInbox,
      email: 'shared-a@example.test',
      displayName: 'A',
      apiKey: 'agentmail-key',
    });
    // PROJECT_B claims the same inbox. This must NOT remove PROJECT_A's row.
    await saveAgentMailInstall({
      projectId: PROJECT_B,
      connectionSlug: 'kortix_email',
      inboxId: sharedInbox,
      email: 'shared-b@example.test',
      displayName: 'B',
      apiKey: 'agentmail-key',
    });

    const owners = await db
      .select({ projectId: chatInstalls.projectId })
      .from(chatInstalls)
      .where(and(eq(chatInstalls.platform, 'email'), eq(chatInstalls.workspaceId, sharedInbox)));
    const ownerIds = owners.map((r) => r.projectId).sort();
    expect(ownerIds).toEqual([PROJECT_A, PROJECT_B].sort());

    // Cleanup so the row does not leak into other tests.
    await deleteAgentMailInstall(PROJECT_A, 'kortix_email');
    await deleteAgentMailInstall(PROJECT_B, 'kortix_email');
  });
});

/**
 * THE RULE (2026-09-16): an unnamed connector call uses an account implicitly
 * ONLY when exactly one account is reachable, OR a human has deliberately
 * pinned a default. Several reachable accounts, none named, none pinned →
 * `ambiguous`, never a silent guess. Own fixtures (a dedicated connector with
 * two project-owned, deliberately UNPINNED connections) so this never
 * interferes with the shared CONNECTOR_A state above.
 */
describe('account_required — several reachable accounts, none named, none pinned', () => {
  const AMBIGUOUS_CONNECTOR = crypto.randomUUID();
  const AMBIGUOUS_SALES = crypto.randomUUID();
  const AMBIGUOUS_SUPPORT = crypto.randomUUID();

  beforeAll(async () => {
    await db.insert(connectors).values({
      connectorId: AMBIGUOUS_CONNECTOR,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      slug: 'ambiguous_multi',
      name: 'Ambiguous multi-account connector',
      providerType: 'http',
      config: { baseUrl: 'https://ambiguous.example.test', auth: { type: 'bearer' } },
    });
    await db.insert(connectorConnections).values([
      {
        connectionId: AMBIGUOUS_SALES,
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        connectorId: AMBIGUOUS_CONNECTOR,
        label: 'Sales',
        isDefault: false,
      },
      {
        connectionId: AMBIGUOUS_SUPPORT,
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        connectorId: AMBIGUOUS_CONNECTOR,
        label: 'Support',
        isDefault: false,
      },
    ]);
    await db.insert(connectionCredentials).values([
      {
        connectorId: AMBIGUOUS_CONNECTOR,
        connectionId: AMBIGUOUS_SALES,
        valueEnc: encryptProjectSecret(PROJECT_A, 'sales-capability'),
      },
      {
        connectorId: AMBIGUOUS_CONNECTOR,
        connectionId: AMBIGUOUS_SUPPORT,
        valueEnc: encryptProjectSecret(PROJECT_A, 'support-capability'),
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(connectionCredentials).where(eq(connectionCredentials.connectorId, AMBIGUOUS_CONNECTOR));
    await db.delete(connectorConnections).where(eq(connectorConnections.connectorId, AMBIGUOUS_CONNECTOR));
    await db.delete(connectors).where(eq(connectors.connectorId, AMBIGUOUS_CONNECTOR));
  });

  test('two reachable shared accounts, none pinned, no account named → ambiguous, both named', async () => {
    const outcome = await resolveSessionConnectorConnectionOutcome({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: null,
      alias: 'ambiguous_multi',
    });
    expect(outcome.kind).toBe('ambiguous');
    if (outcome.kind !== 'ambiguous') throw new Error('expected an ambiguous outcome');
    expect(outcome.accounts.map((a) => a.connectionId).sort()).toEqual(
      [AMBIGUOUS_SALES, AMBIGUOUS_SUPPORT].sort(),
    );
  });

  test('the null-collapsing wrapper never guesses either — ambiguous resolves to null, not the first row', async () => {
    const resolved = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: null,
      alias: 'ambiguous_multi',
    });
    expect(resolved).toBeNull();
  });

  test('naming one by label resolves it directly even while the connector is ambiguous overall', async () => {
    const resolved = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: null,
      alias: 'ambiguous_multi',
      account: 'Sales',
    });
    expect(resolved?.connectionId).toBe(AMBIGUOUS_SALES);
  });

  test('pinning one is the deliberate-default escape hatch: the unnamed call now resolves to it', async () => {
    await db
      .update(connectorConnections)
      .set({ isDefault: true })
      .where(eq(connectorConnections.connectionId, AMBIGUOUS_SUPPORT));
    try {
      const outcome = await resolveSessionConnectorConnectionOutcome({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: null,
        alias: 'ambiguous_multi',
      });
      expect(outcome).toMatchObject({ kind: 'ok', connection: { connectionId: AMBIGUOUS_SUPPORT } });
    } finally {
      await db
        .update(connectorConnections)
        .set({ isDefault: false })
        .where(eq(connectorConnections.connectionId, AMBIGUOUS_SUPPORT));
    }
  });

  test('the real Connector gateway denies the unnamed call account_required through explainMissingConnector', async () => {
    const deps = makeDbGatewayDeps({
      userId: USER,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: null,
      subject: { userId: USER, groupIds: [] },
      agentGrant: { agent: 'veyris', connectors: ['ambiguous_multi'], permissions: [] },
    });
    expect(await deps.loadConnectorBySlug(PROJECT_A, 'ambiguous_multi')).toBeNull();
    expect(await deps.explainMissingConnector?.(PROJECT_A, 'ambiguous_multi')).toBe('account_required');
  });
});

/**
 * INVARIANT (2026-09-16, account_required rule): auto-created connections
 * (`ensureDefaultConnection`, `ensureMemberConnection`) no longer set
 * `is_default` — only the explicit `PUT .../connections/:id/default` route
 * pins one. A connector with exactly ONE active project-owned (or one
 * member-owned) connection must keep resolving credentials and calls exactly
 * as it did before this rule existed, even though nothing is pinned.
 */
describe('credentials.ts — the single-account invariant (no pin required)', () => {
  const SOLO_SHARED_CONNECTOR = crypto.randomUUID();
  const SOLO_MEMBER_CONNECTOR = crypto.randomUUID();

  beforeAll(async () => {
    await db.insert(connectors).values([
      {
        connectorId: SOLO_SHARED_CONNECTOR,
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        slug: 'solo_shared',
        name: 'Solo shared connector',
        providerType: 'http',
        config: { baseUrl: 'https://solo-shared.example.test', auth: { type: 'bearer' } },
      },
      {
        connectorId: SOLO_MEMBER_CONNECTOR,
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        slug: 'solo_member',
        name: 'Solo member connector',
        providerType: 'http',
        config: { baseUrl: 'https://solo-member.example.test', auth: { type: 'bearer' } },
      },
    ]);
  });

  afterAll(async () => {
    await db
      .delete(connectionCredentials)
      .where(eq(connectionCredentials.connectorId, SOLO_SHARED_CONNECTOR));
    await db
      .delete(connectorConnections)
      .where(eq(connectorConnections.connectorId, SOLO_SHARED_CONNECTOR));
    await db
      .delete(connectorConnections)
      .where(eq(connectorConnections.connectorId, SOLO_MEMBER_CONNECTOR));
    await db.delete(connectors).where(eq(connectors.connectorId, SOLO_SHARED_CONNECTOR));
    await db.delete(connectors).where(eq(connectors.connectorId, SOLO_MEMBER_CONNECTOR));
  });

  test('ensureDefaultConnection never marks its row is_default, and is idempotent', async () => {
    const first = await ensureDefaultConnection({ projectId: PROJECT_A, connectorId: SOLO_SHARED_CONNECTOR });
    const second = await ensureDefaultConnection({ projectId: PROJECT_A, connectorId: SOLO_SHARED_CONNECTOR });
    expect(second).toBe(first);
    const [row] = await db
      .select({ isDefault: connectorConnections.isDefault, ownerType: connectorConnections.ownerType })
      .from(connectorConnections)
      .where(eq(connectorConnections.connectionId, first));
    expect(row).toMatchObject({ isDefault: false, ownerType: 'project' });
  });

  test('ensureMemberConnection never marks its row is_default, and is idempotent per (connector, member)', async () => {
    const first = await ensureMemberConnection({
      projectId: PROJECT_A,
      connectorId: SOLO_MEMBER_CONNECTOR,
      userId: USER,
    });
    const second = await ensureMemberConnection({
      projectId: PROJECT_A,
      connectorId: SOLO_MEMBER_CONNECTOR,
      userId: USER,
    });
    expect(second).toBe(first);
    const [row] = await db
      .select({ isDefault: connectorConnections.isDefault, ownerType: connectorConnections.ownerType })
      .from(connectorConnections)
      .where(eq(connectorConnections.connectionId, first));
    expect(row).toMatchObject({ isDefault: false, ownerType: 'member' });
  });

  test('defaultConnectionIdForConnector and connectionIsEffectiveProjectDefault resolve the sole unpinned row', async () => {
    const connectionId = await ensureDefaultConnection({ projectId: PROJECT_A, connectorId: SOLO_SHARED_CONNECTOR });
    expect(await defaultConnectionIdForConnector(SOLO_SHARED_CONNECTOR)).toBe(connectionId);
    expect(await connectionIsEffectiveProjectDefault(SOLO_SHARED_CONNECTOR, connectionId)).toBe(true);
  });

  test('a credential set through the legacy connector-level path resolves through the unpinned solo connection', async () => {
    await upsertCredential({
      projectId: PROJECT_A,
      connectorId: SOLO_SHARED_CONNECTOR,
      userId: null,
      value: 'solo-shared-secret',
    });
    expect(await resolveCredentialValue(SOLO_SHARED_CONNECTOR, null)).toBe('solo-shared-secret');
    expect(await credentialExists(SOLO_SHARED_CONNECTOR, null)).toBe(true);
    expect(await connectorIdsWithSharedCredentials([SOLO_SHARED_CONNECTOR])).toEqual(
      new Set([SOLO_SHARED_CONNECTOR]),
    );
  });

  test('an unnamed call resolves the sole shared account exactly as before this rule existed, even though it is unpinned', async () => {
    const resolved = await resolveSessionConnectorConnection({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: null,
      alias: 'solo_shared',
    });
    expect(resolved).toMatchObject({ ownerType: 'project' });
    // The invariant in one assertion: it resolved even though nothing is pinned.
    expect(resolved?.isDefault).toBe(false);
  });
});

