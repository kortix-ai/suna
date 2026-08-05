/**
 * Real-Postgres tenant and resolution contract for session connector profiles.
 * Run with DATABASE_URL pointed at an isolated migrated database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  chatChannelBindings,
  chatInstalls,
  executorConnectionProfiles,
  executorConnectorPolicies,
  executorConnectors,
  executorCredentials,
  projectSessionConnectorBindings,
  projectSessions,
  projectSecrets,
  projects,
  serviceAccounts,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { deleteAgentMailInstall, saveAgentMailInstall } from '../channels/install-store';
import {
  deleteCredential,
  resolveCredentialValue,
  resolveProfileCredentialValue,
  upsertCredential,
  upsertProfileOAuth2Credential,
  upsertProfileCredential,
} from '../executor/credentials';
import { makeDbGatewayDeps } from '../executor/db-deps';
import { finalizePipedreamProfileConnection } from '../executor/pipedream';
import { reconcileEmailConnectionProfiles } from '../executor/sync';
import {
  missingRequiredConnectorAuthorizationsForSession,
  resolveEffectiveSessionConnectorBindings,
  resolveRequiredConnectorProfiles,
  resolveSessionConnectorProfile,
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
const PROFILE_DEFAULT = crypto.randomUUID();
const PROFILE_A = crypto.randomUUID();
const PROFILE_B = crypto.randomUUID();
const PROFILE_EXTERNAL = crypto.randomUUID();
const PROFILE_SERVICE_ACCOUNT = crypto.randomUUID();
const EMAIL_PROFILE_DEFAULT = crypto.randomUUID();
const SECRET_PROFILE_DEFAULT = crypto.randomUUID();
const FOREIGN_PROFILE = crypto.randomUUID();
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
    { accountId: ACCOUNT_A, name: 'profile-test-a' },
    { accountId: ACCOUNT_B, name: 'profile-test-b' },
  ]);
  await db.insert(projects).values([
    {
      projectId: PROJECT_A,
      accountId: ACCOUNT_A,
      name: 'profile-test-a',
      repoUrl: 'https://example.test/profile-a.git',
    },
    {
      projectId: PROJECT_B,
      accountId: ACCOUNT_B,
      name: 'profile-test-b',
      repoUrl: 'https://example.test/profile-b.git',
    },
  ]);
  await db.insert(serviceAccounts).values({
    serviceAccountId: SERVICE_ACCOUNT,
    accountId: ACCOUNT_A,
    name: `profile-test-service-account-${SERVICE_ACCOUNT}`,
    secretHash: `profile-test-${SERVICE_ACCOUNT}`,
    publicPrefix: 'kortix_sa_profile_test',
    createdBy: USER,
  });
  await db.insert(executorConnectors).values([
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
  await db.insert(executorConnectorPolicies).values({
    connectorId: CONNECTOR_A,
    match: '*',
    action: 'block',
    position: 0,
  });
  await db.insert(executorConnectionProfiles).values([
    {
      profileId: PROFILE_DEFAULT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      label: 'Default workspace',
      isDefault: true,
    },
    {
      profileId: PROFILE_A,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      ownerType: 'member',
      ownerId: USER,
      label: 'My workspace',
    },
    {
      profileId: PROFILE_B,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      ownerType: 'member',
      ownerId: OTHER_USER,
      label: 'Another member workspace',
    },
    {
      profileId: PROFILE_EXTERNAL,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      ownerType: 'external',
      ownerId: 'managed-workspace',
      label: 'Managed workspace',
    },
    {
      profileId: PROFILE_SERVICE_ACCOUNT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      ownerType: 'member',
      ownerId: SERVICE_ACCOUNT,
      label: 'Forged service-account workspace',
    },
    {
      profileId: EMAIL_PROFILE_DEFAULT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: EMAIL_CONNECTOR,
      label: 'Default email',
      isDefault: true,
    },
    {
      profileId: SECRET_PROFILE_DEFAULT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: SECRET_CONNECTOR,
      label: 'Secret-backed default',
      isDefault: true,
    },
    {
      profileId: FOREIGN_PROFILE,
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
      profileId: PROFILE_A,
      source: 'request',
      createdBy: USER,
    },
    {
      sessionId: SESSION_B,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_A,
      profileId: PROFILE_B,
      source: 'request',
      createdBy: USER,
    },
    {
      sessionId: SESSION_IMPERSONATION,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_A,
      profileId: PROFILE_B,
      source: 'request',
      createdBy: USER,
    },
    {
      sessionId: SESSION_SERVICE_ACCOUNT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorAlias: 'veyris',
      connectorId: CONNECTOR_A,
      profileId: PROFILE_SERVICE_ACCOUNT,
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
      profileId: EMAIL_PROFILE_DEFAULT,
      source: 'default',
      createdBy: null,
    },
    {
      sessionId: SESSION_DEFAULT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorAlias: 'secret_backed',
      connectorId: SECRET_CONNECTOR,
      profileId: SECRET_PROFILE_DEFAULT,
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
      profileId: PROFILE_A,
      source: 'request',
      createdBy: USER,
    },
  ]);
  await db.insert(executorCredentials).values([
    {
      connectorId: CONNECTOR_A,
      profileId: PROFILE_DEFAULT,
      valueEnc: encryptProjectSecret(PROJECT_A, 'default-capability'),
    },
    {
      connectorId: CONNECTOR_A,
      profileId: PROFILE_A,
      valueEnc: encryptProjectSecret(PROJECT_A, 'workspace-a-capability'),
    },
    {
      connectorId: CONNECTOR_A,
      profileId: PROFILE_B,
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
    profileSlug: 'kortix_email',
    inboxId: 'profile-test-default-inbox',
    email: 'default@example.test',
    displayName: 'Default inbox',
    apiKey: 'agentmail-key',
  });
});

afterAll(async () => {
  await deleteAgentMailInstall(PROJECT_A, 'kortix_email');
  await db.delete(executorCredentials).where(eq(executorCredentials.connectorId, CONNECTOR_A));
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT_A));
  await db
    .delete(executorConnectionProfiles)
    .where(eq(executorConnectionProfiles.projectId, PROJECT_A));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_A));
  await db.delete(projects).where(eq(projects.projectId, PROJECT_B));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_A));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT_B));
});

describe('session connector profile isolation', () => {
  test('two users sessions resolve only their distinct profiles and credentials', async () => {
    const a = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_A,
      alias: 'veyris',
    });
    const b = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_B,
      alias: 'veyris',
    });
    expect(a?.profileId).toBe(PROFILE_A);
    expect(b?.profileId).toBe(PROFILE_B);
    if (!a || !b) throw new Error('Expected both bound profiles');
    expect(
      await resolveProfileCredentialValue({ connectorId: CONNECTOR_A, profileId: a.profileId }),
    ).toBe('workspace-a-capability');
    expect(
      await resolveProfileCredentialValue({ connectorId: CONNECTOR_A, profileId: b.profileId }),
    ).toBe('workspace-b-capability');
  });

  test('real Executor deps resolve only the authenticated session profile', async () => {
    const principal = (sessionId: string, userId: string) => ({
      userId,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId,
      subject: { userId, groupIds: [] },
      agentGrant: { agent: 'veyris', connectors: ['veyris'] as string[], kortixCli: [] },
    });
    const depsA = makeDbGatewayDeps(principal(SESSION_A, USER));
    const depsB = makeDbGatewayDeps(principal(SESSION_B, OTHER_USER));
    const connectorA = await depsA.loadConnectorBySlug(PROJECT_A, 'veyris');
    const connectorB = await depsB.loadConnectorBySlug(PROJECT_A, 'veyris');
    expect(connectorA?.profileId).toBe(PROFILE_A);
    expect(connectorB?.profileId).toBe(PROFILE_B);
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

  test('real Executor deps resolve a manifest secret only through the connector boundary', async () => {
    const deps = makeDbGatewayDeps({
      userId: USER,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_DEFAULT,
      subject: { userId: USER, groupIds: [] },
      agentGrant: { agent: 'secret-agent', connectors: ['secret_backed'], kortixCli: [] },
    });
    const connector = await deps.loadConnectorBySlug(PROJECT_A, 'secret_backed');
    if (!connector) throw new Error('Expected secret-backed connector');

    expect(connector.authSecret).toBe('CONNECTOR_BOUNDARY_KEY');
    expect(await deps.resolveCredential(connector, null)).toBe('connector-boundary-value');
  });

  test("an omitted user-strategy binding resolves the acting member's authorization", async () => {
    const resolved = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_DEFAULT,
      alias: 'veyris',
    });
    expect(resolved).toMatchObject({
      profileId: PROFILE_A,
      source: 'default',
    });
  });

  test('effective scope materializes runtime defaults and preserves explicit binding state', async () => {
    expect(
      await resolveEffectiveSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_DEFAULT,
        grantedConnectors: ['veyris', 'email'],
      }),
    ).toEqual({
      veyris: { authorization_id: PROFILE_A },
      email: { authorization_id: EMAIL_PROFILE_DEFAULT },
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
      veyris: { authorization_id: PROFILE_A },
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
      veyris: { authorization_id: PROFILE_A },
      email: { authorization_id: EMAIL_PROFILE_DEFAULT },
    });
  });

  test("an omitted user-strategy binding never resolves another member's authorization", async () => {
    await db
      .update(executorConnectionProfiles)
      .set({ isDefault: true })
      .where(eq(executorConnectionProfiles.profileId, PROFILE_B));
    try {
      const resolved = await resolveSessionConnectorProfile({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_DEFAULT,
        alias: 'veyris',
      });
      expect(resolved?.profileId).toBe(PROFILE_A);
      expect(resolved?.profileId).not.toBe(PROFILE_B);
    } finally {
      await db
        .update(executorConnectionProfiles)
        .set({ isDefault: false })
        .where(eq(executorConnectionProfiles.profileId, PROFILE_B));
    }
  });

  test('a partially bound session fails closed for every unbound connector alias', async () => {
    const boundSessionEmail = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_A,
      alias: 'kortix_email',
    });
    expect(boundSessionEmail).toBeNull();

    const legacySessionEmail = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_DEFAULT,
      alias: 'kortix_email',
    });
    expect(legacySessionEmail).toMatchObject({
      profileId: EMAIL_PROFILE_DEFAULT,
      isDefault: true,
      source: 'default',
    });
  });

  test('inherit_unbound keeps the project-default fallback for unbound aliases while the explicit binding still wins', async () => {
    // SESSION_INHERIT_UNBOUND binds veyris (source: request) AND was created with
    // connector_bindings_inherit_unbound = true. The explicit veyris binding must
    // still win, but an UNBOUND alias (kortix_email) must fall through to the
    // project default instead of failing closed the way SESSION_A does above.
    const boundVeyris = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_INHERIT_UNBOUND,
      alias: 'veyris',
    });
    expect(boundVeyris).toMatchObject({ profileId: PROFILE_A, source: 'request' });

    const unboundEmail = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_INHERIT_UNBOUND,
      alias: 'kortix_email',
    });
    expect(unboundEmail).toMatchObject({
      profileId: EMAIL_PROFILE_DEFAULT,
      isDefault: true,
      source: 'default',
    });
  });

  test('an auto-wired email binding does not disable default fallback for other connectors', async () => {
    // SESSION_AUTO_EMAIL has ONLY a source: 'default' email binding (as minted by
    // ensureEmailSessionBinding) — the caller never opted into explicit-only
    // selection. Its email alias resolves via that bound row…
    const email = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_AUTO_EMAIL,
      alias: 'kortix_email',
    });
    expect(email).toMatchObject({ profileId: EMAIL_PROFILE_DEFAULT });

    // …and an UNBOUND alias still falls back to the project default, instead of
    // failing closed the way a caller-requested (source: 'request') binding would.
    const veyris = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_AUTO_EMAIL,
      alias: 'veyris',
    });
    expect(veyris).toMatchObject({
      profileId: PROFILE_A,
      source: 'default',
    });
  });

  test('Executor ignores user-writable email routing metadata', async () => {
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
      agentGrant: { agent: 'veyris', connectors: ['kortix_email'], kortixCli: [] },
    });
    expect(await deps.loadEmailSessionContext?.(PROJECT_A, SESSION_DEFAULT)).toBeNull();
  });

  test('cross-project profile selection is rejected before session insert', async () => {
    const result = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      actingPrincipalIsServiceAccount: false,
      mayManageSystemProfiles: true,
      bindings: { veyris: { authorization_id: FOREIGN_PROFILE } },
    });
    expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_PROFILE_NOT_FOUND' });
  });

  test('a member may bind their own personal profile', async () => {
    const result = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      actingPrincipalIsServiceAccount: false,
      mayManageSystemProfiles: false,
      bindings: { veyris: { authorization_id: PROFILE_A } },
    });
    expect(result).toMatchObject({
      ok: true,
      bindings: [{ alias: 'veyris', profileId: PROFILE_A, ownerType: 'member' }],
    });
    if (!result.ok) throw new Error('Expected owner binding to validate');
    expect(sessionConnectorBindingsRequirePrivateVisibility(result.bindings)).toBe(true);
  });

  test('manager privileges never allow binding another member personal profile', async () => {
    const result = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      actingPrincipalIsServiceAccount: false,
      mayManageSystemProfiles: true,
      bindings: { veyris: { authorization_id: PROFILE_B } },
    });
    expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_PROFILE_NOT_FOUND' });
  });

  test('a service account cannot bind a member profile even when the owner id matches', async () => {
    const result = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: SERVICE_ACCOUNT,
      actingPrincipalIsServiceAccount: true,
      mayManageSystemProfiles: true,
      bindings: { veyris: { authorization_id: PROFILE_SERVICE_ACCOUNT } },
    });
    expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_PROFILE_NOT_FOUND' });
  });

  test('Executor rejects a pre-existing session bound to another member profile', async () => {
    const resolved = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_IMPERSONATION,
      alias: 'veyris',
    });
    expect(resolved).toBeNull();
  });

  test('Executor rejects a pre-existing service-account session bound to a member profile', async () => {
    const resolved = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_SERVICE_ACCOUNT,
      alias: 'veyris',
    });
    expect(resolved).toBeNull();
  });

  test('project strategy rejects member and unmanaged system authorizations without a capability bypass', async () => {
    await db
      .update(executorConnectors)
      .set({ authorizationStrategy: 'project' })
      .where(eq(executorConnectors.connectorId, CONNECTOR_A));
    try {
      const projectOwned = await validateSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        actingUserId: USER,
        actingPrincipalIsServiceAccount: false,
        mayManageSystemProfiles: false,
        bindings: { veyris: { authorization_id: PROFILE_DEFAULT } },
      });
      const memberOwned = await validateSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        actingUserId: USER,
        actingPrincipalIsServiceAccount: false,
        mayManageSystemProfiles: true,
        bindings: { veyris: { authorization_id: PROFILE_A } },
      });
      const unmanagedSystem = await validateSessionConnectorBindings({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        actingUserId: USER,
        actingPrincipalIsServiceAccount: false,
        mayManageSystemProfiles: true,
        bindings: { veyris: { authorization_id: PROFILE_EXTERNAL } },
      });
      expect(projectOwned).toMatchObject({ ok: true });
      expect(memberOwned).toMatchObject({ ok: false, code: 'CONNECTOR_PROFILE_NOT_FOUND' });
      expect(unmanagedSystem).toMatchObject({
        ok: false,
        code: 'CONNECTOR_PROFILE_NOT_FOUND',
      });
    } finally {
      await db
        .update(executorConnectors)
        .set({ authorizationStrategy: 'user' })
        .where(eq(executorConnectors.connectorId, CONNECTOR_A));
    }
  });

  test('a personal-profile binding fails closed if the session becomes shared', async () => {
    await db
      .update(projectSessions)
      .set({ visibility: 'project' })
      .where(eq(projectSessions.sessionId, SESSION_A));
    const resolved = await resolveSessionConnectorProfile({
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

  test('database rejects alias/profile tenant mismatch', async () => {
    let code: string | undefined;
    try {
      await db.insert(projectSessionConnectorBindings).values({
        sessionId: SESSION_DEFAULT,
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        connectorAlias: 'wrong-alias',
        connectorId: CONNECTOR_A,
        profileId: PROFILE_A,
        source: 'request',
      });
    } catch (error) {
      code = (error as { cause?: { code?: string } }).cause?.code;
    }
    expect(code).toBe('23503');
  });

  test('profile revocation takes effect on the next resolution without restart', async () => {
    await db
      .update(executorConnectionProfiles)
      .set({ status: 'revoked', updatedAt: new Date() })
      .where(eq(executorConnectionProfiles.profileId, PROFILE_A));
    const resolved = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_A,
      alias: 'veyris',
    });
    expect(resolved).toBeNull();
    await db
      .update(executorConnectionProfiles)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(executorConnectionProfiles.profileId, PROFILE_A));
  });

  test('credential removal takes effect on the next resolution without restart', async () => {
    await db
      .delete(executorCredentials)
      .where(
        and(
          eq(executorCredentials.connectorId, CONNECTOR_A),
          eq(executorCredentials.profileId, PROFILE_A),
        ),
      );
    try {
      const resolved = await resolveSessionConnectorProfile({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_A,
        alias: 'veyris',
      });
      expect(resolved).toBeNull();
    } finally {
      await upsertProfileCredential({
        projectId: PROJECT_A,
        connectorId: CONNECTOR_A,
        profileId: PROFILE_A,
        value: 'workspace-a-capability',
        createdBy: USER,
      });
    }
  });

  test('authorization strategy changes take effect on the next resolution without restart', async () => {
    await db
      .update(executorConnectors)
      .set({ authorizationStrategy: 'project' })
      .where(eq(executorConnectors.connectorId, CONNECTOR_A));
    try {
      const resolved = await resolveSessionConnectorProfile({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_A,
        alias: 'veyris',
      });
      expect(resolved).toBeNull();
      expect(
        await missingRequiredConnectorAuthorizationsForSession({
          accountId: ACCOUNT_A,
          projectId: PROJECT_A,
          sessionId: SESSION_A,
          aliases: ['veyris'],
        }),
      ).toEqual([
        {
          id: CONNECTOR_A,
          slug: 'veyris',
          name: 'VEYRIS',
          authorization_strategy: 'project',
        },
      ]);
    } finally {
      await db
        .update(executorConnectors)
        .set({ authorizationStrategy: 'user' })
        .where(eq(executorConnectors.connectorId, CONNECTOR_A));
    }
  });

  test('required connector checks reject an unavailable connector profile', async () => {
    await expect(
      missingRequiredConnectorAuthorizationsForSession({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        sessionId: SESSION_A,
        aliases: ['unavailable_connector'],
      }),
    ).rejects.toThrow('Required connector profile "unavailable_connector" is unavailable');
  });

  test('Pipedream finalize reads and stores the account under the profile-specific identity', async () => {
    const realFetch = globalThis.fetch;
    let accountsUrl = '';
    globalThis.fetch = (async (url: string) => {
      const value = String(url);
      if (value.includes('/v1/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'pd-profile-test', expires_in: 3600 }), {
          status: 200,
        });
      }
      if (value.includes('/accounts?')) {
        accountsUrl = value;
        return new Response(
          JSON.stringify({
            data: [{ id: 'apn_profile_a', app: { name_slug: 'veyris', name: 'VEYRIS' } }],
          }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected Pipedream request: ${value}`);
    }) as typeof fetch;
    try {
      const result = await finalizePipedreamProfileConnection({
        projectId: PROJECT_A,
        slug: 'veyris',
        app: 'veyris',
        connectorId: CONNECTOR_A,
        profileId: PROFILE_A,
        createdBy: USER,
      });
      expect(result).toEqual({ connected: true, accountId: 'apn_profile_a' });
      expect(new URL(accountsUrl).searchParams.get('external_user_id')).toBe(
        `${PROJECT_A}:veyris:${PROFILE_A}`,
      );
      expect(
        await resolveProfileCredentialValue({ connectorId: CONNECTOR_A, profileId: PROFILE_A }),
      ).toBe('apn_profile_a');
    } finally {
      globalThis.fetch = realFetch;
      await upsertProfileCredential({
        projectId: PROJECT_A,
        connectorId: CONNECTOR_A,
        profileId: PROFILE_A,
        value: 'workspace-a-capability',
        createdBy: USER,
      });
    }
  });

  test('legacy/default credential helpers never read, overwrite or delete custom profiles', async () => {
    expect(await resolveCredentialValue(CONNECTOR_A, null)).toBe('default-capability');
    await upsertCredential({
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      userId: null,
      value: 'rotated-default',
    });
    expect(await resolveCredentialValue(CONNECTOR_A, null)).toBe('rotated-default');
    expect(
      await resolveProfileCredentialValue({ connectorId: CONNECTOR_A, profileId: PROFILE_A }),
    ).toBe('workspace-a-capability');
    await deleteCredential(CONNECTOR_A, null);
    expect(await resolveCredentialValue(CONNECTOR_A, null)).toBeNull();
    expect(
      await resolveProfileCredentialValue({ connectorId: CONNECTOR_A, profileId: PROFILE_B }),
    ).toBe('workspace-b-capability');
    await upsertCredential({
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      userId: null,
      value: 'default-capability',
    });
  });

  test('OAuth2 profile credentials refresh once and persist the fresh access token', async () => {
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
      await upsertProfileOAuth2Credential(
        {
          projectId: PROJECT_A,
          connectorId: CONNECTOR_A,
          profileId: PROFILE_A,
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
        await resolveProfileCredentialValue(
          { connectorId: CONNECTOR_A, profileId: PROFILE_A },
          { acquire },
        ),
      ).toBe('oauth-access-2');
      expect(
        await resolveProfileCredentialValue(
          { connectorId: CONNECTOR_A, profileId: PROFILE_A },
          { acquire },
        ),
      ).toBe('oauth-access-2');
      expect(acquisitions).toBe(2);
    } finally {
      await upsertProfileCredential({
        projectId: PROJECT_A,
        connectorId: CONNECTOR_A,
        profileId: PROFILE_A,
        value: 'workspace-a-capability',
        createdBy: USER,
      });
    }
  });

  test('OAuth2 profile credentials serialize concurrent refreshes in PostgreSQL', async () => {
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
      await upsertProfileOAuth2Credential(
        {
          projectId: PROJECT_A,
          connectorId: CONNECTOR_A,
          profileId: PROFILE_A,
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
          resolveProfileCredentialValue(
            { connectorId: CONNECTOR_A, profileId: PROFILE_A },
            { acquire },
          ),
        ),
      );
      expect(new Set(values)).toEqual(new Set(['oauth-concurrent-2']));
      expect(acquisitions).toBe(2);
    } finally {
      await upsertProfileCredential({
        projectId: PROJECT_A,
        connectorId: CONNECTOR_A,
        profileId: PROFILE_A,
        value: 'workspace-a-capability',
        createdBy: USER,
      });
    }
  });

  test('AgentMail profiles stay immutable per inbox and revoke on partial or final disconnect', async () => {
    await saveAgentMailInstall({
      projectId: PROJECT_A,
      profileSlug: 'workspace_a',
      inboxId: 'inbox-workspace-a',
      email: 'a@example.test',
      displayName: 'Workspace A',
      apiKey: 'agentmail-key',
    });
    await saveAgentMailInstall({
      projectId: PROJECT_A,
      profileSlug: 'workspace_b',
      inboxId: 'inbox-workspace-b',
      email: 'b@example.test',
      displayName: 'Workspace B',
      apiKey: 'agentmail-key',
    });
    await reconcileEmailConnectionProfiles(PROJECT_A, ACCOUNT_A);

    const profiles = await db
      .select({
        profileId: executorConnectionProfiles.profileId,
        ownerId: executorConnectionProfiles.ownerId,
        status: executorConnectionProfiles.status,
        metadata: executorConnectionProfiles.metadata,
      })
      .from(executorConnectionProfiles)
      .where(eq(executorConnectionProfiles.connectorId, EMAIL_CONNECTOR));
    const profileA = profiles.find((profile) => profile.ownerId === 'agentmail:inbox-workspace-a');
    const profileB = profiles.find((profile) => profile.ownerId === 'agentmail:inbox-workspace-b');
    expect(profileA?.status).toBe('active');
    expect(profileB?.status).toBe('active');
    expect(profileA?.metadata).toMatchObject({
      connector_slug: 'workspace_a',
      inbox_id: 'inbox-workspace-a',
    });
    expect(profileB?.metadata).toMatchObject({
      connector_slug: 'workspace_b',
      inbox_id: 'inbox-workspace-b',
    });
    if (!profileA || !profileB) throw new Error('Expected both AgentMail profiles');

    await deleteAgentMailInstall(PROJECT_A, 'workspace_a');
    await reconcileEmailConnectionProfiles(PROJECT_A, ACCOUNT_A);
    const [afterPartial] = await db
      .select({ status: executorConnectionProfiles.status })
      .from(executorConnectionProfiles)
      .where(eq(executorConnectionProfiles.profileId, profileA.profileId));
    expect(afterPartial?.status).toBe('revoked');

    await deleteAgentMailInstall(PROJECT_A, 'workspace_b');
    await reconcileEmailConnectionProfiles(PROJECT_A, ACCOUNT_A);
    const [afterFinal] = await db
      .select({ status: executorConnectionProfiles.status })
      .from(executorConnectionProfiles)
      .where(eq(executorConnectionProfiles.profileId, profileB.profileId));
    expect(afterFinal?.status).toBe('revoked');
  });

  test('AgentMail installation persists and removes its explicit channel-agent binding', async () => {
    const profileSlug = 'veyris_bound';
    const inboxId = 'inbox-veyris-bound';
    await saveAgentMailInstall({
      projectId: PROJECT_A,
      profileSlug,
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
          eq(chatChannelBindings.channelId, profileSlug),
        ),
      );
    expect(binding).toEqual({
      projectId: PROJECT_A,
      channelId: profileSlug,
      channelName: 'veyris-bound@example.test',
      channelType: 'inbox',
      agentName: 'veyris',
    });

    await deleteAgentMailInstall(PROJECT_A, profileSlug);
    const rows = await db
      .select({ bindingId: chatChannelBindings.bindingId })
      .from(chatChannelBindings)
      .where(
        and(
          eq(chatChannelBindings.platform, 'email'),
          eq(chatChannelBindings.workspaceId, inboxId),
          eq(chatChannelBindings.channelId, profileSlug),
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
      profileSlug: 'kortix_email',
      inboxId: sharedInbox,
      email: 'shared-a@example.test',
      displayName: 'A',
      apiKey: 'agentmail-key',
    });
    // PROJECT_B claims the same inbox. This must NOT remove PROJECT_A's row.
    await saveAgentMailInstall({
      projectId: PROJECT_B,
      profileSlug: 'kortix_email',
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

describe('resolveRequiredConnectorProfiles (require_connectors)', () => {
  test("resolves a required connector to the acting user's OWN member profile", async () => {
    // USER owns PROFILE_A, a member profile for the 'veyris' connector.
    const res = await resolveRequiredConnectorProfiles({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      actingPrincipalIsServiceAccount: false,
      aliases: ['veyris'],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.bindings).toHaveLength(1);
      expect(res.bindings[0]).toMatchObject({
        alias: 'veyris',
        profileId: PROFILE_A,
        ownerType: 'member',
        ownerId: USER,
      });
    }
  });

  test("picks the member's OWN DEFAULT when they hold several connections on one connector", async () => {
    // A member may now hold several personal connections on one connector
    // ("Work", "Personal"). "Use my veyris" must not be a coin flip between them
    // — the one they marked default wins, deterministically.
    const SECOND = crypto.randomUUID();
    await db.insert(executorConnectionProfiles).values({
      profileId: SECOND,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      ownerType: 'member',
      ownerId: USER,
      label: 'My second workspace',
      isDefault: true,
    });
    await upsertProfileCredential({
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      profileId: SECOND,
      value: 'second-workspace-capability',
      createdBy: USER,
    });
    try {
      const res = await resolveRequiredConnectorProfiles({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        actingUserId: USER,
        actingPrincipalIsServiceAccount: false,
        aliases: ['veyris'],
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.bindings[0]?.profileId).toBe(SECOND);
    } finally {
      await db
        .delete(executorConnectionProfiles)
        .where(eq(executorConnectionProfiles.profileId, SECOND));
    }
  });

  test('skips a REVOKED connection and uses the active one instead of failing closed', async () => {
    // The lookup must filter to usable rows IN the query. Fetching an arbitrary
    // row first and then rejecting it would report "connect your account" while
    // a perfectly good active connection exists.
    const REVOKED = crypto.randomUUID();
    await db.insert(executorConnectionProfiles).values({
      profileId: REVOKED,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: CONNECTOR_A,
      ownerType: 'member',
      ownerId: USER,
      label: 'Revoked workspace',
      status: 'revoked',
      isDefault: true, // even as the "default", a revoked row must never win
    });
    try {
      const res = await resolveRequiredConnectorProfiles({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        actingUserId: USER,
        actingPrincipalIsServiceAccount: false,
        aliases: ['veyris'],
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.bindings[0]?.profileId).toBe(PROFILE_A);
    } finally {
      await db
        .delete(executorConnectionProfiles)
        .where(eq(executorConnectionProfiles.profileId, REVOKED));
    }
  });

  test('resolves DISTINCT users to their own member profiles (never each other)', async () => {
    // OTHER_USER owns PROFILE_B for the same connector — must not get USER's.
    const res = await resolveRequiredConnectorProfiles({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: OTHER_USER,
      actingPrincipalIsServiceAccount: false,
      aliases: ['veyris'],
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.bindings[0]?.profileId).toBe(PROFILE_B);
  });

  test('returns the missing connector profile contract when no valid authorization exists', async () => {
    const res = await resolveRequiredConnectorProfiles({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      actingPrincipalIsServiceAccount: false,
      aliases: ['missing_one'],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('CONNECTOR_AUTHORIZATION_REQUIRED');
      expect(res.connectorProfiles).toEqual([
        {
          id: MISSING_CONNECTOR_A,
          slug: 'missing_one',
          name: 'Missing one',
          authorization_strategy: 'project',
        },
      ]);
    }
  });

  test('returns every missing connector profile in one response', async () => {
    const res = await resolveRequiredConnectorProfiles({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      actingPrincipalIsServiceAccount: false,
      aliases: ['missing_two', 'missing_one', 'missing_two'],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.connectorProfiles).toEqual([
        {
          id: MISSING_CONNECTOR_B,
          slug: 'missing_two',
          name: 'Missing two',
          authorization_strategy: 'user',
        },
        {
          id: MISSING_CONNECTOR_A,
          slug: 'missing_one',
          name: 'Missing one',
          authorization_strategy: 'project',
        },
      ]);
    }
  });

  test('a service account cannot satisfy a user-strategy requirement', async () => {
    const res = await resolveRequiredConnectorProfiles({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: SERVICE_ACCOUNT,
      actingPrincipalIsServiceAccount: true,
      aliases: ['veyris'],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('CONNECTOR_AUTHORIZATION_REQUIRED');
  });

  test('a service account can satisfy a project-strategy requirement', async () => {
    await db
      .update(executorConnectors)
      .set({ authorizationStrategy: 'project' })
      .where(eq(executorConnectors.connectorId, CONNECTOR_A));
    try {
      const res = await resolveRequiredConnectorProfiles({
        accountId: ACCOUNT_A,
        projectId: PROJECT_A,
        actingUserId: SERVICE_ACCOUNT,
        actingPrincipalIsServiceAccount: true,
        aliases: ['veyris'],
      });
      expect(res).toMatchObject({
        ok: true,
        bindings: [{ alias: 'veyris', profileId: PROFILE_DEFAULT, ownerType: 'project' }],
      });
    } finally {
      await db
        .update(executorConnectors)
        .set({ authorizationStrategy: 'user' })
        .where(eq(executorConnectors.connectorId, CONNECTOR_A));
    }
  });
});
