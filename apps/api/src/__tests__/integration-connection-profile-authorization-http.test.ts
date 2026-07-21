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
  projectMembers,
  projectSessionConnectorBindings,
  projectSessionPublicShares,
  projectSessions,
  projects,
} from '@kortix/db';
import { eq, sql } from 'drizzle-orm';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
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
const DEFAULT_PROFILE = crypto.randomUUID();
const EXTERNAL_PROFILE = crypto.randomUUID();
const ALICE_PROFILE = crypto.randomUUID();
const BOB_PROFILE = crypto.randomUUID();
const SESSION = crypto.randomUUID();
const PREEXISTING_SHARE = crypto.randomUUID();
const PREEXISTING_SHARE_TOKEN = publicShareToken(PREEXISTING_SHARE);
const minted: string[] = [];

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
  await db.insert(executorConnectors).values({
    connectorId: CONNECTOR,
    accountId: ACCOUNT,
    projectId: PROJECT,
    slug: 'customer_data',
    name: 'Customer data',
    providerType: 'http',
    config: { baseUrl: 'https://example.test', auth: { type: 'bearer' } },
  });
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
