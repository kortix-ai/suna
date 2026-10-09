import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, appDeployments, appLinks, apps, projectMembers, projectSessions, projects, serviceAccounts, sessionSandboxes } from '@kortix/db';
import { config } from '../../../config';
import { db } from '../../../shared/db';
import { app } from '../../../index';
import { createAccountToken } from '../../../repositories/account-tokens';
import { insertIntoView } from '../../../__tests__/helpers/compat-views';
import { encryptProjectSecret } from '../../../projects/surface';
import { verifyKortixMemberToken } from '@kortix/sdk';
import { generateBackendAuthKey } from './auth';
import { CONVEX_CLI_VERSION } from './convex-image';
import { appAccessCookieName, createAppAccessToken } from '../../access';
import { appBackendTokenResponse } from '../../public-proxy-access';
import { insertConvexRow } from '../../../__tests__/helpers/convex-apps';

// The App routes for kind `convex` against the real DB, with no Platinum call:
// the credentials and token responses must not be cached (L4), every `convex`
// App names the client CLI version that matches it (M8), a create past the
// project cap answers 409 app_kind_limit before any machine exists (M3), a web
// App answers 409 app_capability_unsupported on a capability route, and a
// convex deployment is recorded without an artifact.
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
  // A `convex` App needs Platinum configured; no call reaches it here.
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
    metadata: { experimental: { apps: true } },
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
  await insertConvexRow({
    appId: RUNNING,
    projectId: PROJECT,
    accountId: ACCOUNT,
    slug: 'main',
    status: 'running',
    externalId: 'sbx-synthetic',
    url: 'https://main.backends.example.test',
    siteUrl: 'https://main-site.backends.example.test',
    adminKeyEnc: encryptProjectSecret(PROJECT, ADMIN_KEY),
    authKeyEnc: encryptProjectSecret(PROJECT, generateBackendAuthKey()),
  });
  await insertConvexRow({
    appId: ISSUED,
    projectId: PROJECT,
    accountId: ACCOUNT,
    slug: 'issued',
    status: 'running',
    url: 'https://issued.backends.example.test',
    siteUrl: 'https://issued-site.backends.example.test',
    adminKeyEnc: encryptProjectSecret(PROJECT, ADMIN_KEY),
    authKeyEnc: encryptProjectSecret(PROJECT, generateBackendAuthKey()),
    authIssuer: ISSUER,
  });
});

afterAll(async () => {
  config.PLATINUM_API_KEY = originalPlatinumKey;
  await db.execute(sql`delete from kortix.account_tokens where token_id in (${tokenId}, ${agentTokenId})`);
  await db.delete(serviceAccounts).where(eq(serviceAccounts.accountId, ACCOUNT));
  await db.delete(apps).where(eq(apps.accountId, ACCOUNT));
  await db.delete(projects).where(eq(projects.accountId, ACCOUNT));
  await db.delete(accounts).where(eq(accounts.accountId, ACCOUNT));
});

const call = (method: string, path: string, body?: unknown, bearer = secret) =>
  app.request(`/v1/projects/${PROJECT}/apps${path}`, {
    method,
    headers: { Authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

describe('convex App routes', () => {
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

  test('every convex App names the matching client CLI version, in the App and in the list', async () => {
    const res = await call('GET', `/${RUNNING}`);
    expect(res.status).toBe(200);
    expect((await res.json()).instance.client_version).toBe(CONVEX_CLI_VERSION);
    const list = await call('GET', '');
    const listed = (await list.json()).apps.find((a: { app_id: string }) => a.app_id === RUNNING);
    expect(listed).toMatchObject({ kind: 'convex', slug: 'main', hosting_type: 'convex' });
    expect(listed.instance.client_version).toBe(CONVEX_CLI_VERSION);
  });

  test('auth_env verifies the member token the token route mints (the "own server" path of Connect)', async () => {
    const { instance: backend } = await (await call('GET', `/${RUNNING}`)).json();
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
    const { instance: backend } = await (await call('GET', `/${RUNNING}`)).json();
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

  test('a create past the project cap answers 409 app_kind_limit and inserts nothing', async () => {
    for (const slug of ['second', 'third']) {
      await insertConvexRow({ projectId: PROJECT, accountId: ACCOUNT, slug, status: 'error' });
    }
    const res = await call('POST', '', { kind: 'convex', slug: 'fourth', name: 'fourth' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe('app_kind_limit');
    expect(body.error).toContain('at most 3 backend Apps');
    const rows = await db.select().from(apps).where(eq(apps.projectId, PROJECT));
    expect(rows.filter((r) => r.kind === 'convex').map((r) => r.slug).sort()).toEqual(['issued', 'main', 'second', 'third']);
  });

  test('a convex create where Platinum is not configured: 409 app_kind_unavailable; always_on false: 400', async () => {
    config.PLATINUM_API_KEY = undefined as unknown as string;
    try {
      const res = await call('POST', '', { kind: 'convex', slug: 'nowhere', name: 'nowhere' });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe('app_kind_unavailable');
    } finally {
      config.PLATINUM_API_KEY = 'pt_synthetic_backend_routes';
    }
    const res = await call('POST', '', { kind: 'convex', slug: 'sleepy', name: 'sleepy', always_on: false });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('app_always_on_required');
  });

  test('a web App: capabilities name no convex capability; every capability route answers 409 app_capability_unsupported', async () => {
    const created = await call('POST', '', { slug: 'site', name: 'site' });
    expect(created.status).toBe(201);
    const web = await created.json();
    expect(web).toMatchObject({ kind: 'web', instance: null, uses: [], used_by: [] });
    expect(web.capabilities).toEqual(['deployments', 'rollback', 'preview']);
    for (const [method, path, capability] of [
      ['GET', '/snapshots', 'snapshots'],
      ['POST', '/snapshots', 'snapshots'],
      ['DELETE', '/snapshots/snap-x', 'snapshots'],
      ['POST', '/restore', 'restore'],
      ['GET', '/credentials', 'admin_credentials'],
      ['POST', '/rotate-credentials', 'admin_credentials'],
      ['POST', '/token', 'member_tokens'],
      ['GET', '/logs', 'logs'],
    ] as const) {
      const res = await call(method, `/${web.app_id}${path}`, method === 'POST' ? (path === '/restore' ? { snapshot_id: 's' } : {}) : undefined);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'app_capability_unsupported', capability, kind: 'web' });
    }
    // A convex App answers 409 on the web-only routes.
    for (const path of ['/start', '/stop']) {
      const res = await call('POST', `/${RUNNING}${path}`, {});
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'app_capability_unsupported', capability: 'sleep' });
    }
    const rollback = await call('POST', `/${RUNNING}/rollback`, { deployment_id: crypto.randomUUID() });
    expect(await rollback.json()).toMatchObject({ code: 'app_capability_unsupported', capability: 'rollback' });
  });

  test('uses: links by slug both ways, an unknown slug answers 400 app_not_found and changes nothing', async () => {
    const created = await (await call('POST', '', { slug: 'frontend', name: 'frontend', uses: ['main'] })).json();
    expect(created.uses).toEqual(['main']);
    const main = await (await call('GET', `/${RUNNING}`)).json();
    expect(main.used_by).toContain('frontend');
    const bad = await call('PATCH', `/${created.app_id}`, { uses: ['main', 'nope'] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'app_not_found', slugs: ['nope'] });
    expect((await (await call('GET', `/${created.app_id}`)).json()).uses).toEqual(['main']);
    const cleared = await (await call('PATCH', `/${created.app_id}`, { uses: [] })).json();
    expect(cleared.uses).toEqual([]);
    const relinked = await (await call('PATCH', `/${created.app_id}`, { uses: ['main', 'issued'] })).json();
    expect(relinked.uses).toEqual(['issued', 'main']);
  });

  test('a convex deployment is recorded ready, with no artifact, by the caller; a web source is refused', async () => {
    const res = await call('POST', `/${RUNNING}/deployments`, { source: { kind: 'convex', revision: 'abc123' } });
    expect(res.status).toBe(201);
    const deployment = await res.json();
    expect(deployment).toMatchObject({
      app_id: RUNNING, artifact_id: null, status: 'ready', source_kind: 'convex', hosting_type: 'convex',
      created_by: MANAGER, actor_type: 'human', build_spec: { source: { kind: 'convex', revision: 'abc123' } },
    });
    const second = await (await call('POST', `/${RUNNING}/deployments`, { source: { kind: 'convex' } })).json();
    expect(second.version).toBe(deployment.version + 1);
    const listed = (await (await call('GET', `/${RUNNING}/deployments`)).json()).deployments;
    expect(listed.map((d: { version: number }) => d.version)).toEqual([second.version, deployment.version]);
    const wrong = await call('POST', `/${RUNNING}/deployments`, { artifact_id: crypto.randomUUID(), source: { kind: 'static' } });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe('source_kind_mismatch');
    // The App's live pointer does not move: a convex deployment is history.
    const [row] = await db.select({ active: apps.activeDeploymentId }).from(apps).where(eq(apps.appId, RUNNING));
    expect(row!.active).toBeNull();
    await db.delete(appDeployments).where(eq(appDeployments.appId, RUNNING));
  });
});

describe('GET /_kortix/backend-token on the App gate', () => {
  const APP = crypto.randomUUID();
  const OTHER_APP = crypto.randomUUID();
  const OTHER_PROJECT = crypto.randomUUID();
  const gateApp = (accessMode: string, appId: string, projectId: string) => ({
    appId, accountId: ACCOUNT, projectId, name: 'gate-test', accessMode,
    accessPasswordHash: null, accessRevision: 1, createdBy: MANAGER, updatedAt: new Date(),
    viewerTokenScope: 'identity',
  });
  const ask = (
    accessMode: string,
    userId: string,
    { backend = 'main', appId = APP, projectId = PROJECT }: { backend?: string; appId?: string; projectId?: string } = {},
  ) => {
    const cookie = createAppAccessToken({ appId, kind: 'kortix', userId, revision: 1, expiresAt: new Date(Date.now() + 60_000) });
    const url = new URL(`https://gate-test.apps.example.test/_kortix/backend-token?backend=${backend}`);
    const request = new Request(url, { headers: { cookie: `${appAccessCookieName()}=${cookie}` } });
    return appBackendTokenResponse(request, url, gateApp(accessMode, appId, projectId));
  };
  const link = async (uses: string[]) => {
    await db.delete(appLinks).where(eq(appLinks.appId, APP));
    if (uses.length) await db.insert(appLinks).values(uses.map((usesAppId) => ({ appId: APP, usesAppId })));
  };

  beforeAll(async () => {
    // A second project of the same account, with Apps on and no convex App of its own.
    await db.insert(projects).values({
      projectId: OTHER_PROJECT, accountId: ACCOUNT, name: 'backend-routes-other',
      repoUrl: 'https://example.com/backend-routes-other.git', metadata: { experimental: { apps: true } },
    });
    await db.insert(apps).values([
      { appId: APP, accountId: ACCOUNT, projectId: PROJECT, slug: 'gate-test', name: 'gate-test', routeKey: 'gatetest00000001', accessMode: 'public' },
      { appId: OTHER_APP, accountId: ACCOUNT, projectId: OTHER_PROJECT, slug: 'gate-other', name: 'gate-other', routeKey: 'gatetest00000002', accessMode: 'public' },
    ]);
    await link([RUNNING]);
  });

  test('a public App: a member with a gate cookie gets a token for an App it uses', async () => {
    const res = await ask('public', MANAGER);
    expect(res.status).toBe(200);
    expect((await res.json()).token).toMatch(/^ey/);
  });

  test('an App it does not use: 403 app_not_linked, also with no link at all (the default)', async () => {
    for (const [backend, uses] of [['issued', [RUNNING]], ['main', []], ['main', [ISSUED]]] as const) {
      await link([...uses]);
      const res = await ask('public', MANAGER, { backend });
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body.error).toBe('app_not_linked');
      expect(body.token).toBeUndefined();
    }
    await link([RUNNING]);
  });

  test("an App of another project: 403 for this project's convex App, whatever the slug", async () => {
    const res = await ask('public', MANAGER, { appId: OTHER_APP, projectId: OTHER_PROJECT });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('app_not_linked');
  });

  test('a public App: a cookie of someone who lost access mints nothing', async () => {
    const res = await ask('public', crypto.randomUUID());
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('no_viewer_identity');
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
    const { instance } = await (await call('GET', `/${ISSUED}`)).json();
    expect(instance.auth_env.KORTIX_AUTH_ISSUER).toBe(ISSUER);
  });

  test('unknown, placeholder-issuer and malformed ids answer 404, 404, 400', async () => {
    expect((await get(`/${crypto.randomUUID()}/jwks.json`)).status).toBe(404);
    expect((await get(`/${RUNNING}/.well-known/openid-configuration`)).status).toBe(404);
    expect((await get('/not-a-uuid/jwks.json')).status).toBe(400);
  });
});
