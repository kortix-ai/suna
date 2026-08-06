/**
 * Real HTTP + Postgres proof for owner-scoped connections. The bearer
 * token, not a submitted owner id or project role, decides which personal
 * connection may be listed, mutated, bound, or shared.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accountMembers,
  accounts,
  connectorConnections,
  connectors,
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
import { completeAuthorizationCodeSession } from '../connectors/oauth2-store';
import { PROJECT_ACTIONS } from '../iam';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { createServiceAccount } from '../repositories/service-accounts';
import { mintSetupLink } from '../setup-links/token';
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
const USER_CONNECTOR = crypto.randomUUID();
const PIPEDREAM_CONNECTOR = crypto.randomUUID();
const DEFAULT_CONNECTION = crypto.randomUUID();
const EXTERNAL_CONNECTION = crypto.randomUUID();
const ALICE_CONNECTION = crypto.randomUUID();
const BOB_CONNECTION = crypto.randomUUID();
const SERVICE_ACCOUNT_CONNECTION = crypto.randomUUID();
const SERVICE_ACCOUNT_PIPEDREAM_CONNECTION = crypto.randomUUID();
const USER_STRATEGY_PROJECT_CONNECTION = crypto.randomUUID();
const SESSION = crypto.randomUUID();
const DEFAULT_SCOPE_SESSION = crypto.randomUUID();
const PREEXISTING_SHARE = crypto.randomUUID();
const PREEXISTING_SHARE_TOKEN = publicShareToken(PREEXISTING_SHARE);
const minted: string[] = [];
let serviceAccountId = '';
let serviceAccountToken = '';
let fixtureRoot = '';
let previousGitCacheDir: string | undefined;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'kortix-session-scope-http-'));
  previousGitCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = join(fixtureRoot, 'git-cache');
  const repository = join(fixtureRoot, 'repository');
  mkdirSync(repository, { recursive: true });
  git(['init', '-b', 'main'], repository);
  git(['config', 'user.email', 'session-scope@kortix.test'], repository);
  git(['config', 'user.name', 'Session Scope Test'], repository);
  writeFileSync(
    join(repository, 'kortix.yaml'),
    [
      'kortix_version: 2',
      'default_agent: scope_worker',
      'project:',
      '  name: Session scope HTTP',
      'agents:',
      '  scope_worker:',
      '    connectors: all',
      '    secrets: all',
      '    kortix_cli: all',
      '',
    ].join('\n'),
    'utf8',
  );
  git(['add', 'kortix.yaml'], repository);
  git(['commit', '-m', 'initial'], repository);

  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`,
  );
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(
    sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`,
  );
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'connection-owner-http' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'connection-owner-http',
    repoUrl: repository,
    manifestPath: 'kortix.yaml',
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
    name: `connection-owner-http-${crypto.randomUUID()}`,
    createdBy: MANAGER,
  });
  serviceAccountId = serviceAccount.serviceAccountId;
  serviceAccountToken = serviceAccount.secret;
  const serviceAccountRoleId = crypto.randomUUID();
  await db.insert(iamRoles).values({
    roleId: serviceAccountRoleId,
    accountId: ACCOUNT,
    key: `connection-owner-${crypto.randomUUID()}`,
    name: 'Connection owner HTTP test',
    scopeType: 'project',
  });
  await db.insert(iamRoleActions).values(
    [
      PROJECT_ACTIONS.PROJECT_READ,
      PROJECT_ACTIONS.PROJECT_SESSION_START,
      PROJECT_ACTIONS.PROJECT_SESSION_BINDINGS_WRITE,
      PROJECT_ACTIONS.PROJECT_CONNECTOR_CONNECTIONS_MANAGE,
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
  await db.insert(connectors).values([
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
      connectorId: USER_CONNECTOR,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'personal_data',
      name: 'Personal data',
      providerType: 'http',
      authorizationStrategy: 'user',
      config: { baseUrl: 'https://example.test', auth: { type: 'bearer' } },
    },
    {
      connectorId: PIPEDREAM_CONNECTOR,
      accountId: ACCOUNT,
      projectId: PROJECT,
      slug: 'google_sheets',
      name: 'Google Sheets',
      providerType: 'pipedream',
      authorizationStrategy: 'user',
      config: { app: 'google_sheets' },
    },
  ]);
  await db.insert(connectorConnections).values([
    {
      connectionId: DEFAULT_CONNECTION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR,
      label: 'Project default',
      isDefault: true,
    },
    {
      connectionId: EXTERNAL_CONNECTION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: CONNECTOR,
      ownerType: 'external',
      ownerId: 'managed-customer',
      label: 'Managed customer',
    },
    {
      connectionId: ALICE_CONNECTION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: USER_CONNECTOR,
      ownerType: 'member',
      ownerId: ALICE,
      label: 'Alice data',
    },
    {
      connectionId: BOB_CONNECTION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: USER_CONNECTOR,
      ownerType: 'member',
      ownerId: BOB,
      label: 'Bob data',
    },
    {
      connectionId: SERVICE_ACCOUNT_CONNECTION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: USER_CONNECTOR,
      ownerType: 'member',
      ownerId: serviceAccountId,
      label: 'Forged service-account member data',
    },
    {
      connectionId: SERVICE_ACCOUNT_PIPEDREAM_CONNECTION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: PIPEDREAM_CONNECTOR,
      ownerType: 'member',
      ownerId: serviceAccountId,
      label: 'Forged service-account OAuth connection',
    },
    {
      connectionId: USER_STRATEGY_PROJECT_CONNECTION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      connectorId: PIPEDREAM_CONNECTOR,
      ownerType: 'project',
      ownerId: null,
      label: 'Invalid shared OAuth connection',
    },
  ]);
  await db.insert(projectSessions).values([
    {
      sessionId: SESSION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: SESSION,
      createdBy: ALICE,
      visibility: 'private',
    },
    {
      sessionId: DEFAULT_SCOPE_SESSION,
      accountId: ACCOUNT,
      projectId: PROJECT,
      branchName: DEFAULT_SCOPE_SESSION,
      createdBy: ALICE,
      visibility: 'private',
    },
  ]);
  await db.insert(projectSessionConnectorBindings).values({
    sessionId: SESSION,
    accountId: ACCOUNT,
    projectId: PROJECT,
    connectorAlias: 'personal_data',
    connectorId: USER_CONNECTOR,
    connectionId: ALICE_CONNECTION,
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
    .delete(connectorConnections)
    .where(eq(connectorConnections.projectId, PROJECT));
  await db.delete(projects).where(eq(projects.projectId, PROJECT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
  if (previousGitCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
  else process.env.KORTIX_GIT_CACHE_DIR = previousGitCacheDir;
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

async function mint(userId: string): Promise<string> {
  const token = await createAccountToken({
    accountId: ACCOUNT,
    projectId: PROJECT,
    userId,
    name: 'connection-owner-http',
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

describe('connection owner authorization over HTTP', () => {
  test('members list the project default and only their own personal connection', async () => {
    const response = await request(
      'GET',
      `/v1/projects/${PROJECT}/connections`,
      await mint(ALICE),
    );
    expect(response.status).toBe(200);
    const ids = (
      (await response.json()) as { connections: Array<{ connection_id: string }> }
    ).connections.map((connection) => connection.connection_id);
    expect(new Set(ids)).toEqual(new Set([DEFAULT_CONNECTION, ALICE_CONNECTION]));
  });

  test('managers administer system connections but cannot enumerate personal connections', async () => {
    const response = await request(
      'GET',
      `/v1/projects/${PROJECT}/connections`,
      await mint(MANAGER),
    );
    expect(response.status).toBe(200);
    const ids = (
      (await response.json()) as { connections: Array<{ connection_id: string }> }
    ).connections.map((connection) => connection.connection_id);
    expect(new Set(ids)).toEqual(new Set([DEFAULT_CONNECTION]));
  });

  test('managers see EVERY member connection via the read-only roster (/all)', async () => {
    const response = await request(
      'GET',
      `/v1/projects/${PROJECT}/connections/all`,
      await mint(MANAGER),
    );
    expect(response.status).toBe(200);
    const ids = (
      (await response.json()) as { connections: Array<{ connection_id: string }> }
    ).connections.map((connection) => connection.connection_id);
    // The roster surfaces members' personal connections that the plain list hides.
    expect(ids).toContain(ALICE_CONNECTION);
    expect(ids).toContain(DEFAULT_CONNECTION);
  });

  test('a non-manager member cannot use the roster (/all) — 403', async () => {
    const response = await request(
      'GET',
      `/v1/projects/${PROJECT}/connections/all`,
      await mint(ALICE),
    );
    expect(response.status).toBe(403);
  });

  test('member reconciliation forces ownership to the bearer-token user', async () => {
    const response = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections/me`,
      await mint(ALICE),
      { connector_alias: 'personal_data', label: 'Alice data' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connection_id: ALICE_CONNECTION,
      owner_type: 'member',
      owner_id: ALICE,
      label: 'Alice data',
    });
  });

  test('generic manager reconciliation rewrites a submitted member owner to the bearer', async () => {
    const response = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections`,
      await mint(MANAGER),
      {
        connector_alias: 'personal_data',
        owner_type: 'member',
        owner_id: BOB,
        label: 'Manager personal connection',
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      owner_type: 'member',
      owner_id: MANAGER,
      label: 'Manager personal connection',
    });
  });

  test('service accounts cannot mint member connections through either reconciliation route', async () => {
    const self = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections/me`,
      serviceAccountToken,
      { connector_alias: 'personal_data', label: 'Service account personal connection' },
    );
    expect(self.status).toBe(403);

    const generic = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections`,
      serviceAccountToken,
      {
        connector_alias: 'personal_data',
        owner_type: 'member',
        owner_id: ALICE,
        label: 'Service account generic personal connection',
      },
    );
    expect(generic.status).toBe(403);
  });

  test('service accounts cannot list or mutate pre-existing service-account-owned member rows', async () => {
    const listed = await request(
      'GET',
      `/v1/projects/${PROJECT}/connections`,
      serviceAccountToken,
    );
    expect(listed.status).toBe(200);
    const ids = (
      (await listed.json()) as { connections: Array<{ connection_id: string }> }
    ).connections.map((connection) => connection.connection_id);
    expect(new Set(ids)).toEqual(new Set([DEFAULT_CONNECTION]));

    for (const [operation, body] of [
      ['credential', { value: 'service-account-capability' }],
      ['revoke', {}],
      ['activate', {}],
    ] as const) {
      const response = await request(
        'PUT',
        `/v1/projects/${PROJECT}/connections/${SERVICE_ACCOUNT_CONNECTION}/${operation}`,
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
          `/v1/projects/${PROJECT}/connections/${SERVICE_ACCOUNT_PIPEDREAM_CONNECTION}/${operation}`,
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
      `/v1/projects/${PROJECT}/connections/${ALICE_CONNECTION}/credential`,
      alice,
      { value: 'alice-capability' },
    );
    expect(self.status).toBe(200);

    const manager = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connections/${ALICE_CONNECTION}/credential`,
      await mint(MANAGER),
      { value: 'manager-impersonation' },
    );
    expect(manager.status).toBe(404);

    const mismatched = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connections/${EXTERNAL_CONNECTION}/credential`,
      await mint(MANAGER),
      { value: 'operator-capability' },
    );
    expect(mismatched.status).toBe(404);
  });

  test('project strategy rejects member authorization reconciliation', async () => {
    const token = await mint(MANAGER);
    const self = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections/me`,
      token,
      { connector_alias: 'customer_data', label: 'Rejected member authorization' },
    );
    expect(self.status).toBe(409);

    const managed = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections`,
      token,
      {
        connector_alias: 'customer_data',
        owner_type: 'member',
        owner_id: MANAGER,
        label: 'Rejected managed member authorization',
      },
    );
    expect(managed.status).toBe(409);
  });

  test('user strategy rejects project authorization reconciliation', async () => {
    const response = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections`,
      await mint(MANAGER),
      {
        connector_alias: 'personal_data',
        owner_type: 'project',
        label: 'Rejected project authorization',
      },
    );
    expect(response.status).toBe(409);
  });

  test('project strategy accepts project authorization reconciliation', async () => {
    const response = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections`,
      await mint(MANAGER),
      {
        connector_alias: 'customer_data',
        owner_type: 'project',
        label: 'Additional project authorization',
      },
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      connector_alias: 'customer_data',
      owner_type: 'project',
      owner_id: null,
    });
  });

  test('project OAuth bootstrap rejects a user authorization strategy', async () => {
    const response = await request(
      'POST',
      `/v1/projects/${PROJECT}/connectors/google_sheets/oauth2/connection`,
      await mint(MANAGER),
      {},
    );
    expect(response.status).toBe(409);
  });

  test('shared account-link routes reject a user authorization strategy', async () => {
    const manager = await mint(MANAGER);
    const connectRequest = await request(
      'POST',
      `/v1/projects/${PROJECT}/connect-requests`,
      manager,
      { slug: 'google_sheets' },
    );
    expect(connectRequest.status).toBe(409);

    const sharedCredential = await request(
      'PUT',
      `/v1/connectors/projects/${PROJECT}/connectors/google_sheets/credential`,
      manager,
      { value: 'shared-user-strategy-credential' },
    );
    expect(sharedCredential.status).toBe(409);
    const sharedDisconnect = await request(
      'DELETE',
      `/v1/connectors/projects/${PROJECT}/connectors/google_sheets/credential`,
      manager,
    );
    expect(sharedDisconnect.status).toBe(409);

    for (const operation of ['connect', 'connect/finalize'] as const) {
      const response = await request(
        'POST',
        `/v1/connectors/projects/${PROJECT}/connectors/google_sheets/${operation}`,
        manager,
        {},
      );
      expect(response.status).toBe(404);
    }

    const { token } = mintSetupLink(PROJECT, {
      kind: 'connector',
      slug: 'google_sheets',
      app: 'google_sheets',
      uid: MANAGER,
    });
    const publicStart = await app.request(`/v1/setup-links/connectors/${token}/start`, {
      method: 'POST',
    });
    expect(publicStart.status).toBe(409);
  });

  test('native OAuth routes enforce strategy and owner identity', async () => {
    const manager = await mint(MANAGER);
    const alice = await mint(ALICE);

    const project = await request(
      'GET',
      `/v1/projects/${PROJECT}/connections/${DEFAULT_CONNECTION}/oauth2/status`,
      manager,
    );
    expect(project.status).toBe(200);

    const personal = await request(
      'GET',
      `/v1/projects/${PROJECT}/connections/${ALICE_CONNECTION}/oauth2/status`,
      alice,
    );
    expect(personal.status).toBe(200);

    const mismatchedProject = await request(
      'GET',
      `/v1/projects/${PROJECT}/connections/${USER_STRATEGY_PROJECT_CONNECTION}/oauth2/status`,
      manager,
    );
    expect(mismatchedProject.status).toBe(404);

    const mismatchedExternal = await request(
      'GET',
      `/v1/projects/${PROJECT}/connections/${EXTERNAL_CONNECTION}/oauth2/status`,
      manager,
    );
    expect(mismatchedExternal.status).toBe(404);
  });

  test('native OAuth callback rejects a strategy changed after authorization starts', async () => {
    const alice = await mint(ALICE);
    const saved = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connections/${ALICE_CONNECTION}/oauth2/application`,
      alice,
      {
        authorization_url: 'https://identity.example.test/authorize',
        token_url: 'https://identity.example.test/token',
        client_id: 'strategy-test',
        token_endpoint_auth_method: 'none',
      },
    );
    expect(saved.status).toBe(200);
    const started = await request(
      'POST',
      `/v1/projects/${PROJECT}/connections/${ALICE_CONNECTION}/oauth2/authorize`,
      alice,
      {},
    );
    expect(started.status).toBe(200);
    const authorizationUrl = new URL(
      ((await started.json()) as { authorization_url: string }).authorization_url,
    );
    const state = authorizationUrl.searchParams.get('state');
    expect(state).not.toBeNull();
    if (!state) throw new Error('OAuth authorization state is missing');

    await db
      .update(connectors)
      .set({ authorizationStrategy: 'project' })
      .where(eq(connectors.connectorId, USER_CONNECTOR));
    try {
      const result = await completeAuthorizationCodeSession({
        stateHash: createHash('sha256').update(state).digest('hex'),
        code: 'authorization-code',
        callbackUrl: 'https://api.example.test/v1/connectors/oauth2/callback',
      });
      expect(result).toMatchObject({
        ok: false,
        errorCode: 'authorization_strategy_changed',
      });
    } finally {
      await db
        .update(connectors)
        .set({ authorizationStrategy: 'user' })
        .where(eq(connectors.connectorId, USER_CONNECTOR));
    }
  });

  test('personal-connection sessions reject project sharing and public links', async () => {
    const alice = await mint(ALICE);
    const shared = await request(
      'PUT',
      `/v1/projects/${PROJECT}/sessions/${SESSION}/sharing`,
      alice,
      { mode: 'project' },
    );
    expect(shared.status).toBe(409);
    expect(await shared.json()).toMatchObject({
      code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
    });

    const publicLink = await request(
      'POST',
      `/v1/projects/${PROJECT}/sessions/${SESSION}/public-shares`,
      alice,
      {},
    );
    expect(publicLink.status).toBe(409);
    expect(await publicLink.json()).toMatchObject({
      code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
    });

    expect(await resolvePublicShare(PREEXISTING_SHARE_TOKEN)).toMatchObject({
      ok: false,
      status: 403,
    });
  });

  test('session scope read-back uses canonical connection identifiers', async () => {
    const token = await mint(ALICE);
    const connected = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connections/${ALICE_CONNECTION}/credential`,
      token,
      { value: 'scope-read-capability' },
    );
    expect(connected.status).toBe(200);

    const response = await request(
      'GET',
      `/v1/projects/${PROJECT}/sessions/${SESSION}/scope`,
      token,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      secrets_allowlist: null,
      connector_bindings: {
        personal_data: { connection_id: ALICE_CONNECTION },
      },
      dropped_secrets: [],
      added_secrets: [],
      dropped_bindings: [],
      retroactive: true,
    });
    expect(JSON.stringify(body)).not.toContain('profile_id');

    const effective = await request(
      'GET',
      `/v1/projects/${PROJECT}/sessions/${DEFAULT_SCOPE_SESSION}/scope`,
      token,
    );
    expect(effective.status).toBe(200);
    expect(await effective.json()).toMatchObject({
      connector_bindings: {
        personal_data: { connection_id: ALICE_CONNECTION },
      },
    });
  });

  test('scope updates return effective bindings and preserve inherited defaults', async () => {
    const token = await mint(ALICE);
    const connected = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connections/${ALICE_CONNECTION}/credential`,
      token,
      { value: 'scope-effective-capability' },
    );
    expect(connected.status).toBe(200);

    const secretsOnly = await request(
      'PUT',
      `/v1/projects/${PROJECT}/sessions/${DEFAULT_SCOPE_SESSION}/scope`,
      token,
      { secrets: [] },
    );
    expect(secretsOnly.status).toBe(200);
    expect(await secretsOnly.json()).toMatchObject({
      connector_bindings: {
        personal_data: { connection_id: ALICE_CONNECTION },
      },
    });

    await db
      .update(projectSessions)
      .set({
        connectorBindingsConfigured: true,
        connectorBindingsInheritUnbound: true,
      })
      .where(eq(projectSessions.sessionId, DEFAULT_SCOPE_SESSION));

    const replaced = await request(
      'PUT',
      `/v1/projects/${PROJECT}/sessions/${DEFAULT_SCOPE_SESSION}/scope`,
      token,
      { connector_bindings: {} },
    );
    expect(replaced.status).toBe(200);
    expect(await replaced.json()).toMatchObject({
      connector_bindings: {
        personal_data: { connection_id: ALICE_CONNECTION },
      },
      dropped_bindings: [],
    });

    const readBack = await request(
      'GET',
      `/v1/projects/${PROJECT}/sessions/${DEFAULT_SCOPE_SESSION}/scope`,
      token,
    );
    expect(readBack.status).toBe(200);
    expect(await readBack.json()).toMatchObject({
      connector_bindings: {
        personal_data: { connection_id: ALICE_CONNECTION },
      },
    });

    const [session] = await db
      .select({
        configured: projectSessions.connectorBindingsConfigured,
        inheritUnbound: projectSessions.connectorBindingsInheritUnbound,
      })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, DEFAULT_SCOPE_SESSION));
    expect(session).toEqual({
      configured: true,
      inheritUnbound: true,
    });
  });

  test('scope replacement uses the session owner and rejects shared user authorization', async () => {
    const ownerToken = await mint(ALICE);
    const connected = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connections/${ALICE_CONNECTION}/credential`,
      ownerToken,
      { value: 'scope-owner-capability' },
    );
    expect(connected.status).toBe(200);
    const managerToken = await mint(MANAGER);

    try {
      await db
        .update(projectSessions)
        .set({ visibility: 'project' })
        .where(eq(projectSessions.sessionId, SESSION));
      const shared = await request(
        'PUT',
        `/v1/projects/${PROJECT}/sessions/${SESSION}/scope`,
        managerToken,
        {
          connector_bindings: {
            personal_data: { connection_id: ALICE_CONNECTION },
          },
        },
      );
      expect(shared.status).toBe(409);
      expect(await shared.json()).toMatchObject({
        code: 'PERSONAL_CONNECTOR_CONNECTION_REQUIRES_PRIVATE_SESSION',
      });
    } finally {
      await db.transaction(async (tx) => {
        await tx
          .update(projectSessions)
          .set({
            visibility: 'private',
            connectorBindingsConfigured: false,
            connectorBindingsInheritUnbound: false,
          })
          .where(eq(projectSessions.sessionId, SESSION));
        await tx
          .delete(projectSessionConnectorBindings)
          .where(eq(projectSessionConnectorBindings.sessionId, SESSION));
        await tx.insert(projectSessionConnectorBindings).values({
          sessionId: SESSION,
          accountId: ACCOUNT,
          projectId: PROJECT,
          connectorAlias: 'personal_data',
          connectorId: USER_CONNECTOR,
          connectionId: ALICE_CONNECTION,
          source: 'request',
          createdBy: ALICE,
        });
      });
    }
  });

  test('session scope replacement validates the full request before one atomic write', async () => {
    const token = await mint(ALICE);
    const credential = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connections/${ALICE_CONNECTION}/credential`,
      token,
      { value: 'scope-replacement-capability' },
    );
    expect(credential.status).toBe(200);

    try {
      const rejected = await request(
        'PUT',
        `/v1/projects/${PROJECT}/sessions/${SESSION}/scope`,
        token,
        {
          secrets: [],
          connector_bindings: {
            personal_data: { connection_id: BOB_CONNECTION },
          },
        },
      );
      expect(rejected.status).toBe(403);
      expect(await rejected.json()).toMatchObject({
        code: 'CONNECTOR_CONNECTION_NOT_FOUND',
      });

      const [unchangedSession] = await db
        .select({
          secretsAllowlist: projectSessions.secretsAllowlist,
          connectorBindingsConfigured: projectSessions.connectorBindingsConfigured,
        })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, SESSION));
      expect(unchangedSession).toMatchObject({
        secretsAllowlist: null,
        connectorBindingsConfigured: false,
      });
      const unchangedBindings = await db
        .select({ connectionId: projectSessionConnectorBindings.connectionId })
        .from(projectSessionConnectorBindings)
        .where(eq(projectSessionConnectorBindings.sessionId, SESSION));
      expect(unchangedBindings).toEqual([{ connectionId: ALICE_CONNECTION }]);

      const replaced = await request(
        'PUT',
        `/v1/projects/${PROJECT}/sessions/${SESSION}/scope`,
        token,
        { secrets: [], connector_bindings: {} },
      );
      expect(replaced.status).toBe(200);
      expect(await replaced.json()).toMatchObject({
        secrets_allowlist: [],
        connector_bindings: {},
        dropped_bindings: ['personal_data'],
      });
      const [replacedSession] = await db
        .select({
          secretsAllowlist: projectSessions.secretsAllowlist,
          connectorBindingsConfigured: projectSessions.connectorBindingsConfigured,
        })
        .from(projectSessions)
        .where(eq(projectSessions.sessionId, SESSION));
      expect(replacedSession).toMatchObject({
        secretsAllowlist: [],
        connectorBindingsConfigured: true,
      });
      expect(
        await db
          .select()
          .from(projectSessionConnectorBindings)
          .where(eq(projectSessionConnectorBindings.sessionId, SESSION)),
      ).toHaveLength(0);
    } finally {
      await db.transaction(async (tx) => {
        await tx
          .update(projectSessions)
          .set({
            secretsAllowlist: null,
            connectorBindingsConfigured: false,
          })
          .where(eq(projectSessions.sessionId, SESSION));
        await tx
          .delete(projectSessionConnectorBindings)
          .where(eq(projectSessionConnectorBindings.sessionId, SESSION));
        await tx.insert(projectSessionConnectorBindings).values({
          sessionId: SESSION,
          accountId: ACCOUNT,
          projectId: PROJECT,
          connectorAlias: 'personal_data',
          connectorId: USER_CONNECTOR,
          connectionId: ALICE_CONNECTION,
          source: 'request',
          createdBy: ALICE,
        });
      });
    }
  });

  test('authorization-specific policy routes are removed', async () => {
    const token = await mint(ALICE);
    const read = await request(
      'GET',
      `/v1/projects/${PROJECT}/connections/${ALICE_CONNECTION}/policies`,
      token,
    );
    expect(read.status).toBe(404);

    const replace = await request(
      'PUT',
      `/v1/projects/${PROJECT}/connections/${ALICE_CONNECTION}/policies`,
      token,
      { policies: [{ match: '*', action: 'always_run' }] },
    );
    expect(replace.status).toBe(404);
  });
});
