/**
 * Real-Postgres tenant and resolution contract for session connector profiles.
 * Run with DATABASE_URL pointed at an isolated migrated database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accounts,
  executorConnectionProfiles,
  executorConnectors,
  executorCredentials,
  projectSessionConnectorBindings,
  projectSessions,
  projects,
} from '@kortix/db';
import { and, eq } from 'drizzle-orm';
import { deleteAgentMailInstall, saveAgentMailInstall } from '../channels/install-store';
import {
  deleteCredential,
  resolveCredentialValue,
  resolveProfileCredentialValue,
  upsertCredential,
  upsertProfileCredential,
} from '../executor/credentials';
import { makeDbGatewayDeps } from '../executor/db-deps';
import { finalizePipedreamProfileConnection } from '../executor/pipedream';
import { reconcileEmailConnectionProfiles } from '../executor/sync';
import {
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
const PROFILE_DEFAULT = crypto.randomUUID();
const PROFILE_A = crypto.randomUUID();
const PROFILE_B = crypto.randomUUID();
const PROFILE_EXTERNAL = crypto.randomUUID();
const EMAIL_PROFILE_DEFAULT = crypto.randomUUID();
const FOREIGN_PROFILE = crypto.randomUUID();
const SESSION_A = crypto.randomUUID();
const SESSION_B = crypto.randomUUID();
const SESSION_DEFAULT = crypto.randomUUID();
const USER = crypto.randomUUID();
const OTHER_USER = crypto.randomUUID();

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
  await db.insert(executorConnectors).values([
    {
      connectorId: CONNECTOR_A,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      slug: 'veyris',
      name: 'VEYRIS',
      providerType: 'http',
      config: { baseUrl: 'https://veyris.example.test', auth: { type: 'bearer' } },
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
  ]);
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
      profileId: EMAIL_PROFILE_DEFAULT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      connectorId: EMAIL_CONNECTOR,
      label: 'Default email',
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
    },
    {
      sessionId: SESSION_B,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      branchName: SESSION_B,
      createdBy: OTHER_USER,
    },
    {
      sessionId: SESSION_DEFAULT,
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      branchName: SESSION_DEFAULT,
      createdBy: USER,
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
});

afterAll(async () => {
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
  });

  test('omitted binding resolves only the migrated/default profile', async () => {
    const resolved = await resolveSessionConnectorProfile({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      sessionId: SESSION_DEFAULT,
      alias: 'veyris',
    });
    expect(resolved).toMatchObject({
      profileId: PROFILE_DEFAULT,
      isDefault: true,
      source: 'default',
    });
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
      mayManageSystemProfiles: true,
      bindings: { veyris: { profile_id: FOREIGN_PROFILE } },
    });
    expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_PROFILE_NOT_FOUND' });
  });

  test('a member may bind their own personal profile', async () => {
    const result = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      mayManageSystemProfiles: false,
      bindings: { veyris: { profile_id: PROFILE_A } },
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
      mayManageSystemProfiles: true,
      bindings: { veyris: { profile_id: PROFILE_B } },
    });
    expect(result).toMatchObject({ ok: false, code: 'CONNECTOR_PROFILE_NOT_FOUND' });
  });

  test('system profiles retain the explicit management capability path', async () => {
    const denied = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      mayManageSystemProfiles: false,
      bindings: { veyris: { profile_id: PROFILE_DEFAULT } },
    });
    expect(denied).toMatchObject({ ok: true });

    const unprivileged = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      mayManageSystemProfiles: false,
      bindings: { veyris: { profile_id: PROFILE_EXTERNAL } },
    });
    const privileged = await validateSessionConnectorBindings({
      accountId: ACCOUNT_A,
      projectId: PROJECT_A,
      actingUserId: USER,
      mayManageSystemProfiles: true,
      bindings: { veyris: { profile_id: PROFILE_EXTERNAL } },
    });
    expect(unprivileged).toMatchObject({ ok: false, code: 'CONNECTOR_PROFILE_NOT_FOUND' });
    expect(privileged).toMatchObject({ ok: true });
    if (!privileged.ok) throw new Error('Expected managed profile to validate');
    expect(sessionConnectorBindingsRequirePrivateVisibility(privileged.bindings)).toBe(false);
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
    expect(resolved?.status).toBe('revoked');
    await db
      .update(executorConnectionProfiles)
      .set({ status: 'active', updatedAt: new Date() })
      .where(eq(executorConnectionProfiles.profileId, PROFILE_A));
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
});
