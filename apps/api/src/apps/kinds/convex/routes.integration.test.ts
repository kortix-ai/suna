import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { accountMembers, accounts, appDeployments, appLinks, apps, iamRoleActions, iamRoles, projectMembers, projectSessions, projects, roleAssignments, serviceAccounts, sessionSandboxes } from '@kortix/db';
import { config } from '../../../config';
import { db } from '../../../shared/db';
import { app } from '../../../index';
import { createAccountToken } from '../../../repositories/account-tokens';
import { insertIntoView } from '../../../__tests__/helpers/compat-views';
import { encryptProjectSecret } from '../../../projects/surface';
import { verifyKortixToken } from '@kortix/sdk';
import { CONVEX_CLI_VERSION } from './convex-image';
import { appAccessCookieName, createAppAccessToken } from '../../access';
import { appTokenResponse } from '../../public-proxy-access';
import { appBindingResponse } from '../../bindings';
import { projectIssuer, projectSigner } from '../../tokens';
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
    authIssuer: projectIssuer(PROJECT),
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
    authIssuer: projectIssuer(PROJECT),
  });
  // Provisioning creates the project key when it writes the App's environment.
  await projectSigner(PROJECT);
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
    const member = await verifyKortixToken(token, {
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
    const member = await verifyKortixToken(token, {
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

  test('a web App: capabilities name no convex capability; every convex capability route answers 409 app_capability_unsupported', async () => {
    const created = await call('POST', '', { slug: 'site', name: 'site' });
    expect(created.status).toBe(201);
    const web = await created.json();
    expect(web).toMatchObject({ kind: 'web', instance: null, uses: [], used_by: [] });
    expect(web.capabilities).toEqual(['deployments', 'rollback', 'preview', 'member_tokens']);
    for (const [method, path, capability] of [
      ['GET', '/snapshots', 'snapshots'],
      ['POST', '/snapshots', 'snapshots'],
      ['DELETE', '/snapshots/snap-x', 'snapshots'],
      ['POST', '/restore', 'restore'],
      ['GET', '/credentials', 'admin_credentials'],
      ['POST', '/rotate-credentials', 'admin_credentials'],
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

describe('GET /_kortix/token and the bindings mount on the App gate', () => {
  const APP = crypto.randomUUID();
  const OTHER_APP = crypto.randomUUID();
  const WEB_TARGET = crypto.randomUUID();
  const OTHER_PROJECT = crypto.randomUUID();
  const gateApp = (accessMode: string, appId: string, projectId: string, slug: string) => ({
    appId, accountId: ACCOUNT, projectId, name: slug, slug, accessMode,
    accessPasswordHash: null, accessRevision: 1, createdBy: MANAGER, updatedAt: new Date(),
    viewerTokenScope: 'identity',
  });
  const request = (path: string, appId: string, userId: string) => {
    const cookie = createAppAccessToken({ appId, kind: 'kortix', userId, revision: 1, expiresAt: new Date(Date.now() + 60_000) });
    const url = new URL(`https://gate-test.apps.example.test${path}`);
    return { url, request: new Request(url, { headers: { cookie: `${appAccessCookieName()}=${cookie}` } }) };
  };
  const ask = (
    accessMode: string,
    userId: string,
    { audience, appId = APP, projectId = PROJECT, slug = 'gate-test' }: { audience?: string; appId?: string; projectId?: string; slug?: string } = {},
  ) => {
    const { url, request: req } = request(`/_kortix/token${audience === undefined ? '' : `?audience=${audience}`}`, appId, userId);
    return appTokenResponse(req, url, gateApp(accessMode, appId, projectId, slug));
  };
  const claims = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
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
      { appId: WEB_TARGET, accountId: ACCOUNT, projectId: PROJECT, slug: 'web-target', name: 'web-target', routeKey: 'gatetest00000003', accessMode: 'public' },
    ]);
    await link([RUNNING]);
  });

  test('an App it uses, by slug or by id: 200, iss = the project issuer, aud = the used App', async () => {
    for (const audience of ['main', RUNNING]) {
      const res = await ask('public', MANAGER, { audience });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body.audience).toBe(RUNNING);
      expect(claims(body.token)).toMatchObject({ iss: projectIssuer(PROJECT), aud: RUNNING, sub: MANAGER, project_id: PROJECT });
    }
  });

  test('the App itself, the default audience, by slug or by id: 200 with aud = the App', async () => {
    for (const audience of [undefined, 'gate-test', APP]) {
      const res = await ask('public', MANAGER, { audience });
      expect(res.status).toBe(200);
      expect(claims((await res.json()).token).aud).toBe(APP);
    }
  });

  test('the token verifies against the public key set of the project issuer', async () => {
    const { token } = await (await ask('public', MANAGER, { audience: 'main' })).json();
    const jwks = await (await app.request(`/v1/projects/${PROJECT}/jwks.json`)).json();
    const member = await verifyKortixToken(token, { jwks, issuer: projectIssuer(PROJECT), audience: RUNNING });
    expect(member.userId).toBe(MANAGER);
  });

  test('an App it does not use: 403 app_not_linked, also with no link at all', async () => {
    for (const [audience, uses] of [['issued', [RUNNING]], ['main', []], ['main', [ISSUED]], [ISSUED, [RUNNING]]] as const) {
      await link([...uses]);
      const res = await ask('public', MANAGER, { audience });
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = await res.json();
      expect(body.error).toBe('app_not_linked');
      expect(body.token).toBeUndefined();
    }
    await link([RUNNING]);
  });

  test("an App of another project: 403 for this project's App, by slug or by id", async () => {
    for (const audience of ['main', RUNNING]) {
      const res = await ask('public', MANAGER, { audience, appId: OTHER_APP, projectId: OTHER_PROJECT, slug: 'gate-other' });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('app_not_linked');
    }
  });

  test('a public App: a cookie of someone who lost access mints nothing', async () => {
    const res = await ask('public', crypto.randomUUID(), { audience: 'main' });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('no_viewer_identity');
  });

  describe('/_kortix/apps/<slug>/*', () => {
    const upstream: Array<{ path: string; method: string; edgeToken: string | null; cookie: string | null; body: string }> = [];
    let machine: ReturnType<typeof Bun.serve>;
    let platinum: ReturnType<typeof Bun.serve>;
    const saved = { url: config.PLATINUM_API_URL };

    beforeAll(() => {
      // Bind the fake explicitly: a default-bind Bun.serve reports its origin as
      // `localhost`, and a fetch to `localhost` tries ::1 first — on hosts without a
      // ::1 listener it refuses instead of falling back to IPv4, failing spuriously.
      machine = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: async (req) => {
          const url = new URL(req.url);
          upstream.push({
            path: `${url.pathname}${url.search}`,
            method: req.method,
            edgeToken: req.headers.get('x-pt-preview-token'),
            cookie: req.headers.get('cookie'),
            body: await req.text(),
          });
          return Response.json({ convex: 'synthetic' }, { headers: { 'x-pt-edge': 'stripped' } });
        },
      });
      // The fake control plane exposes the machine of `main` (sbx-synthetic) privately.
      platinum = Bun.serve({
        port: 0,
        hostname: '127.0.0.1',
        fetch: (req) => {
          const [, , , id, sub] = new URL(req.url).pathname.split('/');
          if (sub !== 'expose') return Response.json({ id, state: 'running' });
          return Response.json({ port: 3210, public: false, url: `${machine.url.origin}/?t=synthetic-edge-token` });
        },
      });
      config.PLATINUM_API_URL = `http://127.0.0.1:${platinum.port}`;
    });

    afterAll(() => {
      config.PLATINUM_API_URL = saved.url;
      machine.stop(true);
      platinum.stop(true);
    });

    const bind = (path: string, init: RequestInit = {}, appId = APP, projectId = PROJECT) => {
      const url = new URL(`https://gate-test.apps.example.test${path}`);
      const headers = new Headers(init.headers);
      headers.set('cookie', `${appAccessCookieName()}=gate-cookie; theme=dark`);
      return appBindingResponse(new Request(url, { ...init, headers }), url, 'gate-test.apps.example.test', { appId, projectId });
    };

    test('a used convex App: the request reaches its client API with the prefix stripped, minus Kortix cookies', async () => {
      upstream.length = 0;
      const res = await bind('/_kortix/apps/main/api/1.46.0/query?format=json', { method: 'POST', body: '{"path":"x:y"}' });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ convex: 'synthetic' });
      expect(res.headers.get('x-pt-edge')).toBeNull();
      expect(upstream).toEqual([
        { path: '/api/1.46.0/query?format=json', method: 'POST', edgeToken: 'synthetic-edge-token', cookie: 'theme=dark', body: '{"path":"x:y"}' },
      ]);
    });

    test('an App it does not use: 403 app_not_linked, and nothing reaches any machine', async () => {
      upstream.length = 0;
      const res = await bind('/_kortix/apps/issued/api/version');
      expect(res.status).toBe(403);
      expect((await res.json()).error).toBe('app_not_linked');
      const cross = await bind('/_kortix/apps/main/api/version', {}, OTHER_APP, OTHER_PROJECT);
      expect(cross.status).toBe(403);
      expect(upstream).toEqual([]);
    });

    test('a used App whose kind has no endpoint: 409 app_binding_unsupported', async () => {
      await link([RUNNING, WEB_TARGET]);
      const res = await bind('/_kortix/apps/web-target/');
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'app_binding_unsupported', kind: 'web' });
      await link([RUNNING]);
    });
  });
});

describe('the project token issuer (no auth)', () => {
  const get = (path: string) => app.request(`/v1/projects${path}`);

  test('openid-configuration names the project issuer and its key set, cacheable', async () => {
    const res = await get(`/${PROJECT}/.well-known/openid-configuration`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const body = await res.json();
    expect(body.issuer).toBe(projectIssuer(PROJECT));
    expect(body.jwks_uri).toBe(`${projectIssuer(PROJECT)}/jwks.json`);
  });

  test("jwks.json holds the public key only and verifies the token route's token; auth_env names the same issuer", async () => {
    const res = await get(`/${PROJECT}/jwks.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    const jwks = await res.json();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0].d).toBeUndefined();
    const { token } = await (await call('POST', `/${ISSUED}/token`, {})).json();
    const member = await verifyKortixToken(token, { jwks, issuer: projectIssuer(PROJECT), audience: ISSUED });
    expect(member.userId).toBe(MANAGER);
    const issued = await (await call('GET', `/${ISSUED}`)).json();
    expect(issued.instance.auth_env.KORTIX_AUTH_ISSUER).toBe(projectIssuer(PROJECT));
    expect(issued.auth).toEqual({ issuer: projectIssuer(PROJECT), audience: ISSUED, jwks_uri: `${projectIssuer(PROJECT)}/jwks.json` });
  });

  test('a web App mints too: the token names the App as audience and verifies with its `auth`', async () => {
    const web = await (await call('POST', '', { slug: 'tokens-web', name: 'tokens-web' })).json();
    expect(web.capabilities).toContain('member_tokens');
    const res = await call('POST', `/${web.app_id}/token`, {});
    expect(res.status).toBe(200);
    const { token } = await res.json();
    const jwks = await (await app.request(new URL(web.auth.jwks_uri).pathname)).json();
    const member = await verifyKortixToken(token, { jwks, issuer: web.auth.issuer, audience: web.auth.audience });
    expect(member.userId).toBe(MANAGER);
  });

  test('a project that never minted a token: an empty key set, not cached; unknown and malformed ids: 404, 400', async () => {
    const empty = await get(`/${(await db.select({ id: projects.projectId }).from(projects).where(eq(projects.name, 'backend-routes-other')))[0]!.id}/jwks.json`);
    expect(empty.status).toBe(200);
    expect(empty.headers.get('cache-control')).toBe('no-store');
    expect(await empty.json()).toEqual({ keys: [] });
    expect((await get(`/${crypto.randomUUID()}/jwks.json`)).status).toBe(404);
    expect((await get(`/${crypto.randomUUID()}/.well-known/openid-configuration`)).status).toBe(404);
    expect((await get('/not-a-uuid/jwks.json')).status).toBe(400);
  });
});

// Links never cross App visibility. EDITOR holds project.app.write through a
// custom project role but is no project manager, so a teammate's private App is
// invisible to them; VIEWER is a plain project member. Before the fix, a link
// let both reach the private App: EDITOR could link it (and learn its slug from
// the 200), VIEWER could mint a token for it on the using App's host, and both
// read its slug in `uses`.
describe('links never cross App visibility', () => {
  const EDITOR = crypto.randomUUID();
  const VIEWER = crypto.randomUUID();
  const SECRET = crypto.randomUUID();
  const HUB = crypto.randomUUID();
  const MINE = crypto.randomUUID();
  const BUSY = crypto.randomUUID();
  const ROLE = crypto.randomUUID();
  const tokenIds: string[] = [];
  let editorSecret = '';

  beforeAll(async () => {
    await insertIntoView(db, accountMembers, { userId: EDITOR, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false });
    await insertIntoView(db, accountMembers, { userId: VIEWER, accountId: ACCOUNT, accountRole: 'member', isSuperAdmin: false });
    await insertIntoView(db, projectMembers, { accountId: ACCOUNT, projectId: PROJECT, userId: VIEWER, projectRole: 'member' });
    await db.insert(iamRoles).values({ roleId: ROLE, accountId: ACCOUNT, key: `links_editor_${ROLE.slice(0, 8)}`, name: 'Links editor', scopeType: 'project' });
    await db.insert(iamRoleActions).values(
      ['project.read', 'project.write', 'project.app.read', 'project.app.write'].map((action) => ({ roleId: ROLE, action })),
    );
    await db.insert(roleAssignments).values({
      accountId: ACCOUNT, principalType: 'user', principalId: EDITOR, roleId: ROLE, scopeType: 'project', scopeId: PROJECT,
    });
    const editorToken = await createAccountToken({ accountId: ACCOUNT, userId: EDITOR, name: 'links-editor' });
    tokenIds.push(editorToken.tokenId);
    editorSecret = editorToken.secretKey;
    await db.insert(apps).values([
      { appId: SECRET, accountId: ACCOUNT, projectId: PROJECT, slug: 'links-secret', name: 'links-secret', routeKey: 'linkstest0000001', accessMode: 'private', createdBy: MANAGER },
      { appId: HUB, accountId: ACCOUNT, projectId: PROJECT, slug: 'links-hub', name: 'links-hub', routeKey: 'linkstest0000002', accessMode: 'project', createdBy: MANAGER },
      { appId: MINE, accountId: ACCOUNT, projectId: PROJECT, slug: 'links-mine', name: 'links-mine', routeKey: 'linkstest0000003', accessMode: 'project', createdBy: EDITOR },
    ]);
    await db.insert(appLinks).values({ appId: HUB, usesAppId: SECRET });
    // A convex App busy with a snapshot (a marker with no timestamp never goes stale).
    await insertConvexRow({
      appId: BUSY, projectId: PROJECT, accountId: ACCOUNT, slug: 'links-busy', status: 'running',
      externalId: 'sbx-links-busy', url: 'https://links-busy.backends.example.test', metadata: { operation: 'snapshotting' },
    });
  });

  afterAll(async () => {
    for (const id of tokenIds) await db.execute(sql`delete from kortix.account_tokens where token_id = ${id}`);
    await db.delete(roleAssignments).where(eq(roleAssignments.roleId, ROLE));
    await db.delete(iamRoles).where(eq(iamRoles.roleId, ROLE));
  });

  const linksOf = async (appId: string) =>
    (await db.select({ usesAppId: appLinks.usesAppId }).from(appLinks).where(eq(appLinks.appId, appId))).map((row) => row.usesAppId);

  test("`uses` lists only the linked Apps the reader can see; the manager still sees the private one", async () => {
    const list = await (await call('GET', '', undefined, editorSecret)).json();
    expect(list.apps.map((a: { slug: string }) => a.slug)).not.toContain('links-secret');
    expect(list.apps.find((a: { app_id: string }) => a.app_id === HUB).uses).toEqual([]);
    expect((await (await call('GET', `/${HUB}`, undefined, editorSecret)).json()).uses).toEqual([]);
    expect((await (await call('GET', `/${HUB}`)).json()).uses).toEqual(['links-secret']);
  });

  test('linking an App the caller cannot see answers 400 app_not_found, exactly like a missing slug, and writes nothing', async () => {
    const hidden = await call('PATCH', `/${MINE}`, { uses: ['links-secret'] }, editorSecret);
    const missing = await call('PATCH', `/${MINE}`, { uses: ['links-nope'] }, editorSecret);
    expect(hidden.status).toBe(400);
    expect(missing.status).toBe(400);
    const [hiddenBody, missingBody] = [await hidden.json(), await missing.json()];
    expect(hiddenBody).toMatchObject({ code: 'app_not_found', slugs: ['links-secret'] });
    expect(Object.keys(hiddenBody).sort()).toEqual(Object.keys(missingBody).sort());
    expect(await linksOf(MINE)).toEqual([]);
    const visible = await call('PATCH', `/${MINE}`, { uses: ['links-hub'] }, editorSecret);
    expect(visible.status).toBe(200);
    expect((await visible.json()).uses).toEqual(['links-hub']);
  });

  test("/_kortix/token on the using App: 403 app_not_linked for a linked App the viewer cannot open; the manager gets it", async () => {
    const ask = (userId: string, audience: string) => {
      const cookie = createAppAccessToken({ appId: HUB, kind: 'kortix', userId, revision: 1, expiresAt: new Date(Date.now() + 60_000) });
      const url = new URL(`https://links-hub.apps.example.test/_kortix/token?audience=${audience}`);
      return appTokenResponse(new Request(url, { headers: { cookie: `${appAccessCookieName()}=${cookie}` } }), url, {
        appId: HUB, accountId: ACCOUNT, projectId: PROJECT, name: 'links-hub', slug: 'links-hub', accessMode: 'project',
        accessPasswordHash: null, accessRevision: 1, createdBy: MANAGER, updatedAt: new Date(), viewerTokenScope: 'identity',
      });
    };
    for (const audience of ['links-secret', SECRET]) {
      const denied = await ask(VIEWER, audience);
      expect(denied.status).toBe(403);
      const body = await denied.json();
      expect(body.error).toBe('app_not_linked');
      expect(body.token).toBeUndefined();
    }
    expect((await ask(VIEWER, 'links-hub')).status).toBe(200);
    const granted = await ask(MANAGER, 'links-secret');
    expect(granted.status).toBe(200);
    expect((await granted.json()).audience).toBe(SECRET);
  });

  test('a refused convex resize changes nothing: not the links, not the name', async () => {
    const res = await call('PATCH', `/${BUSY}`, { uses: ['links-hub'], cpu: 2, name: 'renamed' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('app_busy');
    expect(await linksOf(BUSY)).toEqual([]);
    const [row] = await db.select({ name: apps.name }).from(apps).where(eq(apps.appId, BUSY));
    expect(row!.name).toBe('links-busy');
  });
});
