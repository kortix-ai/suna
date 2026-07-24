/**
 * Real HTTP + Postgres proof for owner-scoped connection profiles. The bearer
 * token, not a submitted owner id or project role, decides which personal
 * profile may be listed, mutated, bound, or shared.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  accountMembers,
  accounts,
  executorConnectionProfiles,
  executorConnectors,
  iamPolicies,
  iamRoleActions,
  iamRoles,
  projectMembers,
  projectSessionConnectorBindings,
  projectSessionPublicShares,
  projectSessions,
  projects,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { PROJECT_ACTIONS } from '../iam';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { createServiceAccount } from '../repositories/service-accounts';
import { db } from '../shared/db';
import {
  publicShareToken,
  publicShareTokenHash,
  resolvePublicShare,
} from '../shared/session-public-shares';

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const ALICE = crypto.randomUUID();
const BOB = crypto.randomUUID();
const CONNECTOR = crypto.randomUUID();
const PIPEDREAM_CONNECTOR = crypto.randomUUID();
const DEFAULT_PROFILE = crypto.randomUUID();
const EXTERNAL_PROFILE = crypto.randomUUID();
const ALICE_PROFILE = crypto.randomUUID();
const BOB_PROFILE = crypto.randomUUID();
const SERVICE_ACCOUNT_PROFILE = crypto.randomUUID();
const SERVICE_ACCOUNT_PIPEDREAM_PROFILE = crypto.randomUUID();
const SESSION = crypto.randomUUID();
const PREEXISTING_SHARE = crypto.randomUUID();
const PREEXISTING_SHARE_TOKEN = publicShareToken(PREEXISTING_SHARE);
const minted: string[] = [];
let serviceAccountId = '';
let serviceAccountToken = '';

beforeAll(async () => {
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`,
  );
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'profile-owner-http' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'profile-owner-http',
    repoUrl: 'https://example.test/profile-owner-http.git',
  });
  await db.insert(accountMembers).values([
    { accountId: ACCOUNT, userId: MANAGER, accountRole: 'member' },
    { accountId: ACCOUNT, userId: ALICE, accountRole: 'member' },
    { accountId: ACCOUNT, userId: BOB, accountRole: 'member' },
  ]);
  await db.insert(projectMembers).values([
    { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: ALICE, projectRole: 'member' },
    { accountId: ACCOUNT, projectId: PROJECT, userId: BOB, projectRole: 'member' },
  ]);
  const serviceAccount = await createServiceAccount({
    accountId: ACCOUNT,
    name: `profile-owner-http-${crypto.randomUUID()}`,
    createdBy: MANAGER,
  });
  serviceAccountId = serviceAccount.serviceAccountId;
  serviceAccountToken = serviceAccount.secret;
  const serviceAccountRoleId = crypto.randomUUID();
  await db.insert(iamRoles).values({
    roleId: serviceAccountRoleId,
    accountId: ACCOUNT,
    key: `profile-owner-${crypto.randomUUID()}`,
    name: 'Profile owner HTTP test',
    scopeType: 'project',
  });
  await db.insert(iamRoleActions).values(
    [
      PROJECT_ACTIONS.PROJECT_READ,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
      PROJECT_ACTIONS.PROJECT_SESSION_BINDINGS_WRITE,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_PROFILES_MANAGE,
    ].map((action) => ({ roleId: serviceAccountRoleId, action })),
  );
  await db.insert(iamPolicies).values({
    accountId: ACCOUNT,
    principalType: 'token',
    principalId: serviceAccountId,
    roleId: serviceAccountRoleId,
    scopeType: 'project',
    scopeId: PROJECT,
  });
  await db.insert(executorConnectors).values([
    {
      connectorId: CONNECTOR,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'customer_data',
      name: 'Customer data',
      providerType: 'http',
      config: { baseUrl: 'https://example.test', auth: { type: 'bearer' } },
    },
    {
      connectorId: PIPEDREAM_CONNECTOR,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'google_sheets',
      name: 'Google Sheets',
      providerType: 'pipedream',
      config: { app: 'google_sheets' },
    },
  ]);
  await db.insert(executorConnectionProfiles).values([
    {
      profileId: DEFAULT_PROFILE,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR,
      label: 'Project default',
      isDefault: true,
    },
    {
      profileId: EXTERNAL_PROFILE,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR,
      ownerType: 'external',
      ownerId: 'managed-customer',
      label: 'Managed customer',
    },
    {
      profileId: ALICE_PROFILE,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR,
      ownerType: 'member',
      ownerId: ALICE,
      label: 'Alice data',
    },
    {
      profileId: BOB_PROFILE,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR,
      ownerType: 'member',
      ownerId: BOB,
      label: 'Bob data',
    },
    {
      profileId: SERVICE_ACCOUNT_PROFILE,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR,
      ownerType: 'member',
      ownerId: serviceAccountId,
      label: 'Forged service-account member data',
    },
    {
      profileId: SERVICE_ACCOUNT_PIPEDREAM_PROFILE,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: PIPEDREAM_CONNECTOR,
      ownerType: 'member',
      ownerId: serviceAccountId,
      label: 'Forged service-account OAuth profile',
    },
  ]);
  await db.insert(projectSessions).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    branchName: SESSION,
    createdBy: ALICE,
    visibility: 'private',
  });
  await db.insert(projectSessionConnectorBindings).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorAlias: 'customer_data',
    connectorId: CONNECTOR,
    profileId: ALICE_PROFILE,
    source: 'request',
    createdBy: ALICE,
  });
  await db.insert(projectSessionPublicShares).values({
    shareId: PREEXISTING_SHARE,
    tokenHash: publicShareTokenHash(PREEXISTING_SHARE_TOKEN),
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    createdBy: ALICE,
    port: 3000,
  });
});

afterAll(async () => {
  for (const tokenId of minted) {
    await db.execute(sql`delete from kortix.account_tokens where token_id = ${tokenId}`);
  }
  await db.delete(projectSessions).where(eq(projectSessions.projectId, PROJECT));
  await db
    .delete(executorConnectionProfiles)
    .where(eq(executorConnectionProfiles.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

async function mint(userId: string): Promise<string> {
  const token = await createAccountToken({
    accountId: ACCOUNT,
    projectId: PROJECT,
    userId,
    name: 'profile-owner-http',
    agentGrant: null,
  });
  minted.push(token.tokenId);
  return token.secretKey;
}

function request(method: string, path: string, token: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe('connection profile owner authorization over HTTP', () => {
  test('members list the project default and only their own personal profile', async () => {
    const response = await request(
      'GET',
      `/v1/projects/${PROJECT}/connector-profiles`,
      await mint(ALICE),
    );
    expect(response.status).toBe(200);
    const ids = (
      (await response.json()) as { profiles: Array<{ profile_id: string }> }
    ).profiles.map((profile) => profile.profile_id);
    expect(new Set(ids)).toEqual(new Set([DEFAULT_PROFILE, ALICE_PROFILE]));
  });

  test('managers administer system profiles but cannot enumerate personal profiles', async () => {
    const response = await request(
      'GET',
      `/v1/projects/${PROJECT}/connector-profiles`,
      await mint(MANAGER),
    );
    expect(response.status).toBe(200);
    const ids = (
      (await response.json()) as { profiles: Array<{ profile_id: string }> }
    ).profiles.map((profile) => profile.profile_id);
    expect(new Set(ids)).toEqual(new Set([DEFAULT_PROFILE, EXTERNAL_PROFILE]));
  });

  test('managers see EVERY member connection via the read-only roster (/all)', async () => {
    const response = await request(
      'GET',
      `/v1/projects/${PROJECT}/connector-profiles/all`,
      await mint(MANAGER),
    );
    expect(response.status).toBe(200);
    const ids = (
      (await response.json()) as { profiles: Array<{ profile_id: string }> }
    ).profiles.map((profile) => profile.profile_id);
    // The roster surfaces members' personal profiles that the plain list hides.
    expect(ids).toContain(ALICE_PROFILE);
    expect(ids).toContain(DEFAULT_PROFILE);
  });

  test('a non-manager member cannot use the roster (/all) — 403', async () => {
    const response = await request(
      'GET',
      `/v1/projects/${PROJECT}/connector-profiles/all`,
      await mint(ALICE),
    );
    expect(response.status).toBe(403);
  });

  test('member reconciliation forces ownership to the bearer-token user', async () => {
    const response = await request(
      'POST',
      `/v1/projects/${PROJECT}/connector-profiles/me`,
      await mint(ALICE),
      { connector_alias: 'customer_data', label: 'Alice renamed' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      profile_id: ALICE_PROFILE,
      owner_type: 'member',
      owner_id: ALICE,
      label: 'Alice renamed',
    });
  });

  test('generic manager reconciliation rewrites a submitted member owner to the bearer', async () => {
    const response = await request(
      'POST',
      `/v1/projects/${PROJECT}/connector-profiles`,
      await mint(MANAGER),
      {
        connector_alias: 'customer_data',
        owner_type: 'member',
        owner_id: BOB,
        label: 'Manager personal profile',
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      owner_type: 'member',
      owner_id: MANAGER,
      label: 'Manager personal profile',
    });
  });

  test('service accounts cannot mint member profiles through either reconciliation route', async () => {
    const self = await request(
      'POST',
      `/v1/projects/${PROJECT}/connector-profiles/me`,
      serviceAccountToken,
      { connector_alias: 'customer_data', label: 'Service account personal profile' },
    );
    expect(self.status).toBe(403);

    const generic = await request(
      'POST',
      `/v1/projects/${PROJECT}/connector-profiles`,
      serviceAccountToken,
      {
        connector_alias: 'customer_data',
        owner_type: 'member',
        owner_id: ALICE,
        label: 'Service account generic personal profile',
      },
    );
    expect(generic.status).toBe(403);
  });

  test('service accounts cannot list or mutate pre-existing service-account-owned member rows', async () => {
    const listed = await request(
      'GET',
      `/v1/projects/${PROJECT}/connector-profiles`,
      serviceAccountToken,
    );
    expect(listed.status).toBe(200);
    const ids = (
      (await listed.json()) as { profiles: Array<{ profile_id: string }> }
    ).profiles.map((profile) => profile.profile_id);
    expect(new Set(ids)).toEqual(new Set([DEFAULT_PROFILE, EXTERNAL_PROFILE]));

    for (const [operation, body] of [
      ['credential', { value: 'service-account-capability' }],
      ['revoke', {}],
      ['activate', {}],
    ] as const) {
      const response = await request(
        'PUT',
        `/v1/projects/${PROJECT}/connector-profiles/${SERVICE_ACCOUNT_PROFILE}/${operation}`,
        serviceAccountToken,
        body,
      );
      expect(response.status).toBe(404);
    }
  });

  test('service accounts cannot start or finalize OAuth for forged member rows', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const value = String(args[0]);
      if (value.includes('/v1/oauth/token')) {
        return new Response(JSON.stringify({ access_token: 'pd-sa-test', expires_in: 3600 }), {
          status: 200,
        });
      }
      if (value.includes('/tokens')) {
        return new Response(
          JSON.stringify({
            token: 'connect-sa-test',
            expires_at: new Date(Date.now() + 60_000).toISOString(),
            connect_link_url: 'https://pipedream.example.test/connect',
          }),
          { status: 200 },
        );
      }
      if (value.includes('/accounts?')) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: 'apn_sa_test',
                app: { name_slug: 'google_sheets', name: 'Google Sheets' },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return realFetch(...args);
    }) as typeof fetch;
    try {
      for (const operation of ['connect', 'connect/finalize'] as const) {
        const response = await request(
          'POST',
          `/v1/projects/${PROJECT}/connector-profiles/${SERVICE_ACCOUNT_PIPEDREAM_PROFILE}/${operation}`,
          serviceAccountToken,
          {},
        );
        expect(response.status).toBe(404);
      }
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('members rotate their own credential; managers cannot rotate another member credential', async () => {
    const alice = await mint(ALICE);
    const self = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connector-profiles/${ALICE_PROFILE}/credential`,
      alice,
      { value: 'alice-capability' },
    );
    expect(self.status).toBe(200);

    const manager = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connector-profiles/${ALICE_PROFILE}/credential`,
      await mint(MANAGER),
      { value: 'manager-impersonation' },
    );
    expect(manager.status).toBe(404);

    const managed = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connector-profiles/${EXTERNAL_PROFILE}/credential`,
      await mint(MANAGER),
      { value: 'operator-capability' },
    );
    expect(managed.status).toBe(200);
  });

  test('personal-profile sessions reject project sharing and public links', async () => {
    const alice = await mint(ALICE);
    const shared = await request(
      'PUT',
      `/v1/projects/${PROJECT}/sessions/${SESSION}/sharing`,
      alice,
      { mode: 'project' },
    );
    expect(shared.status).toBe(409);
    expect(await shared.json()).toMatchObject({
      code: 'PERSONAL_CONNECTOR_PROFILE_REQUIRES_PRIVATE_SESSION',
    });

    const publicLink = await request(
      'POST',
      `/v1/projects/${PROJECT}/sessions/${SESSION}/public-shares`,
      alice,
      {},
    );
    expect(publicLink.status).toBe(409);
    expect(await publicLink.json()).toMatchObject({
      code: 'PERSONAL_CONNECTOR_PROFILE_REQUIRES_PRIVATE_SESSION',
    });

    expect(await resolvePublicShare(PREEXISTING_SHARE_TOKEN)).toMatchObject({
      ok: false,
      status: 403,
    });
  });
});
