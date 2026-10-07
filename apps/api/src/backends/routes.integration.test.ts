import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, projectBackends, projectMembers, projectSessions, projects, serviceAccounts, sessionSandboxes } from '@kortix/db';
import { config } from '../config';
import { db } from '../shared/db';
import { app } from '../index';
import { createAccountToken } from '../repositories/account-tokens';
import { insertIntoView } from '../__tests__/helpers/compat-views';
import { encryptProjectSecret } from '../projects/surface';
import { verifyKortixMemberToken } from '@kortix/sdk';
import { generateBackendAuthKey } from './auth';
import { CONVEX_CLI_VERSION } from './convex-image';
import { appAccessCookieName, createAppAccessToken } from '../apps/access';
import { appBackendTokenResponse } from '../apps/public-proxy-access';

// The backend routes against the real DB, with no Platinum call: the
// credentials and token responses must not be cached (L4), every backend names
// the Convex CLI version that matches it (M8), and a create past the project
// cap answers 409 backend_limit before any machine exists (M3).
const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const MANAGER = crypto.randomUUID();
const RUNNING = crypto.randomUUID();
const ISSUED = crypto.randomUUID();
const ISSUER = `https://api.example.test/v1/backends/${ISSUED}`;
const ADMIN_KEY = 'synthetic-admin|key';
const AGENT_SA = crypto.randomUUID();
const AGENT_SESSION = crypto.randomUUID();

let secret = '';
let tokenId = '';
let agentSecret = '';
let agentTokenId = '';
const originalPlatinumKey = config.PLATINUM_API_KEY;

beforeAll(async () => {
  // `backends` is available only where Platinum is configured; no call reaches it here.
  config.PLATINUM_API_KEY = 'pt_synthetic_backend_routes';
  await db.execute(sql`alter table kortix.account_tokens add column if not exists agent_grant jsonb`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists session_id text`);
  await db.execute(sql`alter table kortix.account_tokens add column if not exists service_account_id uuid`);
  await db.insert(accounts).values({ accountId: ACCOUNT, name: 'backend-routes-test' });
  await db.insert(projects).values({
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'backend-routes-test',
    repoUrl: 'https://example.com/backend-routes.git',
    metadata: { experimental: { backends: true } },
  });
  await insertIntoView(db, accountMembers, { userId: MANAGER, accountId: ACCOUNT, accountRole: 'owner', isSuperAdmin: false });
  await insertIntoView(db, projectMembers, { accountId: ACCOUNT, projectId: PROJECT, userId: MANAGER, projectRole: 'manager' });
  const token = await createAccountToken({ accountId: ACCOUNT, userId: MANAGER, name: 'backend-routes-test' });
  tokenId = token.tokenId;
  secret = token.secretKey;
  // An agent session the owner launched: its token row names the owner as
  // `user_id` and the agent's service account.
  await db.insert(serviceAccounts).values({
    serviceAccountId: AGENT_SA, accountId: ACCOUNT, name: `agent-${AGENT_SA}`,
    secretHash: `sa-${AGENT_SA}`, publicPrefix: 'kortix_sa_backend', createdBy: MANAGER,
  });
  await db.insert(projectSessions).values({
    sessionId: AGENT_SESSION, accountId: ACCOUNT, projectId: PROJECT, branchName: `session/${AGENT_SESSION}`,
    createdBy: MANAGER, visibility: 'project', status: 'running',
  });
  await db.insert(sessionSandboxes).values({
    sandboxId: crypto.randomUUID(), sessionId: AGENT_SESSION, accountId: ACCOUNT, projectId: PROJECT,
    externalId: 'sbx-agent-synthetic', provider: 'platinum', status: 'active',
    baseUrl: 'http://127.0.0.1:9', config: {}, deadlineAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  const agentToken = await createAccountToken({
    accountId: ACCOUNT, userId: MANAGER, name: 'agent session', projectId: PROJECT,
    sessionId: AGENT_SESSION, serviceAccountId: AGENT_SA,
    agentGrant: { agent: 'kortix', permissions: 'all', connectors: 'all', env: 'all' },
  });
  agentTokenId = agentToken.tokenId;
  agentSecret = agentToken.secretKey;
  await db.insert(projectBackends).values({
    backendId: RUNNING,
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'main',
    status: 'running',
    provider: 'platinum',
    externalId: 'sbx-synthetic',
    url: 'https://main.backends.example.test',
    siteUrl: 'https://main-site.backends.example.test',
    adminKeyEnc: encryptProjectSecret(PROJECT, ADMIN_KEY),
    authKeyEnc: encryptProjectSecret(PROJECT, generateBackendAuthKey()),
    cpu: 1,
    memoryGb: 1,
    diskGb: 10,
  });
  await db.insert(projectBackends).values({
    backendId: ISSUED,
    projectId: PROJECT,
    accountId: ACCOUNT,
    name: 'issued',
    status: 'running',
    provider: 'platinum',
    url: 'https://issued.backends.example.test',
    siteUrl: 'https://issued-site.backends.example.test',
    adminKeyEnc: encryptProjectSecret(PROJECT, ADMIN_KEY),
    authKeyEnc: encryptProjectSecret(PROJECT, generateBackendAuthKey()),
    authIssuer: ISSUER,
    cpu: 1,
    memoryGb: 1,
    diskGb: 10,
  });
});

afterAll(async () => {
  config.PLATINUM_API_KEY = originalPlatinumKey;
  await db.execute(sql`delete from kortix.account_tokens where token_id in (${tokenId}, ${agentTokenId})`);
  await db.delete(serviceAccounts).where(eq(serviceAccounts.accountId, ACCOUNT));
  await db.delete(projectBackends).where(eq(projectBackends.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const call = (method: string, path: string, body?: unknown, bearer = secret) =>
  app.request(`/v1/projects/${PROJECT}/backends${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe('backend routes', () => {
  test('credentials answer with Cache-Control: no-store and the admin key', async () => {
    const res = await call('GET', `/${RUNNING}/credentials`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await res.json()).admin_key).toBe(ADMIN_KEY);
  });

  test('a member token answers with Cache-Control: no-store', async () => {
    const res = await call('POST', `/${RUNNING}/token`, {});
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(typeof (await res.json()).token).toBe('string');
  });

  test('every backend names the matching Convex CLI version', async () => {
    const res = await call('GET', `/${RUNNING}`);
    expect(res.status).toBe(200);
    expect((await res.json()).backend.convex_version).toBe(CONVEX_CLI_VERSION);
    const list = await call('GET', '');
    expect((await list.json()).backends[0].convex_version).toBe(CONVEX_CLI_VERSION);
  });

  test('auth_env verifies the member token the token route mints (the "own server" path of Connect)', async () => {
    const { backend } = await (await call('GET', `/${RUNNING}`)).json();
    expect(Object.keys(backend.auth_env).sort()).toEqual(['KORTIX_AUTH_AUDIENCE', 'KORTIX_AUTH_ISSUER', 'KORTIX_AUTH_JWKS']);
    expect(backend.auth_env.KORTIX_AUTH_AUDIENCE).toBe(RUNNING);
    expect(JSON.stringify(backend)).not.toContain(ADMIN_KEY);
    const { token } = await (await call('POST', `/${RUNNING}/token`, {})).json();
    const member = await verifyKortixMemberToken(token, {
      jwks: backend.auth_env.KORTIX_AUTH_JWKS,
      issuer: backend.auth_env.KORTIX_AUTH_ISSUER,
      audience: backend.auth_env.KORTIX_AUTH_AUDIENCE,
    });
    expect(member.userId).toBe(MANAGER);
    expect(member.projectId).toBe(PROJECT);
  });

  test('an agent session gets a token naming the agent, never the owner who launched it', async () => {
    const res = await call('POST', `/${RUNNING}/token`, {}, agentSecret);
    expect(res.status).toBe(200);
    const { backend } = await (await call('GET', `/${RUNNING}`)).json();
    const { token } = await res.json();
    expect(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).kind).toBe('agent');
    const member = await verifyKortixMemberToken(token, {
      jwks: backend.auth_env.KORTIX_AUTH_JWKS,
      issuer: backend.auth_env.KORTIX_AUTH_ISSUER,
      audience: backend.auth_env.KORTIX_AUTH_AUDIENCE,
    });
    expect(member.userId).toBe(AGENT_SA);
    expect(member.userId).not.toBe(MANAGER);
    expect(member.role).toBeNull();
    expect(member.email).toBeNull();
    expect(member.groups).toEqual([]);
    expect(member.groupIds).toEqual([]);
  });

  test('a create past the project cap answers 409 backend_limit and inserts nothing', async () => {
    await db.insert(projectBackends).values(
      ['second', 'third'].map((name) => ({
        projectId: PROJECT,
        accountId: ACCOUNT,
        name,
        status: 'error',
        provider: 'platinum',
        cpu: 1,
        memoryGb: 1,
        diskGb: 10,
      })),
    );
    const res = await call('POST', '', { name: 'fourth' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('backend_limit');
    expect(body.error).toContain('at most 3 backends');
    const rows = await db.select().from(projectBackends).where(eq(projectBackends.projectId, PROJECT));
    expect(rows.map((r) => r.name).sort()).toEqual(['issued', 'main', 'second', 'third']);
  });
});

describe('GET /_kortix/backend-token on the App gate', () => {
  const APP = crypto.randomUUID();
  const gateApp = (accessMode: string) => ({
    appId: APP, accountId: ACCOUNT, projectId: PROJECT, name: 'gate-test', accessMode,
    accessPasswordHash: null, accessRevision: 1, createdBy: MANAGER, updatedAt: new Date(),
    viewerTokenScope: 'identity',
  });
  const ask = (accessMode: string, userId: string) => {
    const cookie = createAppAccessToken({ appId: APP, kind: 'kortix', userId, revision: 1, expiresAt: new Date(Date.now() + 60_000) });
    const url = new URL('https://gate-test.apps.example.test/_kortix/backend-token?backend=main');
    const request = new Request(url, { headers: { cookie: `${appAccessCookieName()}=${cookie}` } });
    return appBackendTokenResponse(request, url, gateApp(accessMode));
  };

  test('a public App: a member with a gate cookie gets a token', async () => {
    expect((await ask('public', MANAGER)).status).toBe(200);
  });

  test('a public App: a cookie of someone who lost access mints nothing', async () => {
    const res = await ask('public', crypto.randomUUID());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('no_viewer_identity');
  });

  test('the project with backends off: 403 feature_disabled', async () => {
    await db.update(projects).set({ metadata: { experimental: { backends: false } } }).where(eq(projects.projectId, PROJECT));
    try {
      const res = await ask('public', MANAGER);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('feature_disabled');
    } finally {
      await db.update(projects).set({ metadata: { experimental: { backends: true } } }).where(eq(projects.projectId, PROJECT));
    }
  });
});

describe('public issuer discovery (no auth)', () => {
  const get = (path: string) => app.request(`/v1/backends${path}`);

  test('openid-configuration names the stored issuer and its key set, cacheable', async () => {
    const res = await get(`/${ISSUED}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = await res.json();
    expect(body.issuer).toBe(ISSUER);
    expect(body.jwks_uri).toBe(`${ISSUER}/jwks.json`);
  });

  test('jwks.json holds the public key only and verifies the token route\'s token', async () => {
    const res = await get(`/${ISSUED}/jwks.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const jwks = await res.json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].d).toBeUndefined();
    const { token } = await (await call('POST', `/${ISSUED}/token`, {})).json();
    const member = await verifyKortixMemberToken(token, { jwks, issuer: ISSUER, audience: ISSUED });
    expect(member.userId).toBe(MANAGER);
    const { backend } = await (await call('GET', `/${ISSUED}`)).json();
    expect(backend.auth_env.KORTIX_AUTH_ISSUER).toBe(ISSUER);
  });

  test('unknown, placeholder-issuer and malformed ids answer 404, 404, 400', async () => {
    expect((await get(`/${crypto.randomUUID()}/jwks.json`)).status).toBe(404);
    expect((await get(`/${RUNNING}/.well-known/openid-configuration`)).status).toBe(404);
    expect((await get('/not-a-uuid/jwks.json')).status).toBe(400);
  });
});
