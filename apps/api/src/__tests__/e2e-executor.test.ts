/**
 * E2E for the executor HTTP surface — drives the REAL Hono router + REAL gateway
 * via app.fetch(), with in-memory backends. New model: access lives on the
 * connector (shareScope + grants); credentials are split per (connector, user)
 * and resolved by mode. Proves auth, catalog, a tool call, denials, admin
 * sync/sharing, and policy enforcement.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createExecutorRouter,
  type AdminConnectorView,
  type CatalogConnector,
  type ExecutorPrincipal,
  type ExecutorRouterDeps,
} from '../executor/router';
import type { GatewayAction, GatewayConnector, GatewayDeps, ExecutionRecord } from '../executor/gateway';
import type { SecretGrant, SharingIntent } from '../executor/share';
import { isSecretUsableBy, intentToScope, scopeToIntent } from '../executor/share';
import { resolvePolicyAction, type Policy } from '../executor/policy';

const ACCOUNT = 'acct-1';
const PROJECT = 'proj-1';
const ALICE = 'user-alice';
const BOB = 'user-bob';

interface World {
  connectors: Map<string, GatewayConnector>;
  actions: Map<string, GatewayAction>; // connectorId|relPath
  credentials: Map<string, string>; // connectorId|userId('shared'|uid) → value
  groups: Map<string, string[]>;
  policies: Policy[];
  executions: ExecutionRecord[];
  upstream: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }>;
  upstreamStatus: number;
  upstreamBody: string;
}

let world: World;

function freshWorld(): World {
  const stripe: GatewayConnector = {
    connectorId: 'conn-stripe',
    slug: 'stripe',
    provider: 'openapi',
    baseUrl: 'https://api.stripe.com',
    auth: { type: 'bearer', in: 'header', name: null, prefix: null },
    hasAuth: true,
    shareScope: 'project',
    grants: [],
    credentialMode: 'shared',
    enabled: true,
  };
  const action: GatewayAction = {
    path: 'stripe.charges.create',
    relPath: 'charges.create',
    inputSchema: { type: 'object', properties: { amount: {} } },
    risk: 'write',
    binding: { kind: 'openapi', method: 'POST', path: '/v1/charges', server: 'https://api.stripe.com' },
  };
  return {
    connectors: new Map([['stripe', stripe]]),
    actions: new Map([['conn-stripe|charges.create', action]]),
    credentials: new Map([['conn-stripe|shared', 'sk_live_xyz']]),
    groups: new Map(),
    policies: [],
    executions: [],
    upstream: [],
    upstreamStatus: 200,
    upstreamBody: '{"id":"ch_1","paid":true}',
  };
}

function credKey(connectorId: string, userId: string | null) {
  return `${connectorId}|${userId ?? 'shared'}`;
}

function makeGatewayDeps(): GatewayDeps {
  return {
    loadConnectorBySlug: async (_p, slug) => world.connectors.get(slug) ?? null,
    loadAction: async (connectorId, rel) => world.actions.get(`${connectorId}|${rel}`) ?? null,
    resolveCredential: async (connectorId, userId) => world.credentials.get(credKey(connectorId, userId)) ?? null,
    loadPolicies: async () => world.policies,
    enforcePolicies: true,
    recordExecution: async (r) => { world.executions.push(r); },
    fetchImpl: async (url, init) => {
      world.upstream.push({ url, ...init });
      return {
        status: world.upstreamStatus,
        ok: world.upstreamStatus >= 200 && world.upstreamStatus < 300,
        text: async () => world.upstreamBody,
      };
    },
  };
}

function principalFor(userId: string): ExecutorPrincipal {
  return { userId, accountId: ACCOUNT, projectId: PROJECT, sessionId: 'sess-1', subject: { userId, groupIds: world.groups.get(userId) ?? [] } };
}

function catalogFor(p: ExecutorPrincipal): CatalogConnector[] {
  const out: CatalogConnector[] = [];
  for (const conn of world.connectors.values()) {
    if (!isSecretUsableBy(conn.shareScope, conn.grants, p.subject)) continue;
    if (conn.hasAuth) {
      const uid = conn.credentialMode === 'per_user' ? p.userId : null;
      if (!world.credentials.has(credKey(conn.connectorId, uid))) continue;
    }
    const actions = [...world.actions.entries()]
      .filter(([k]) => k.startsWith(`${conn.connectorId}|`))
      .filter(([, a]) => resolvePolicyAction(a.relPath, world.policies) !== 'block')
      .map(([, a]) => ({ path: a.relPath, name: a.path, description: '', risk: a.risk, inputSchema: a.inputSchema }));
    out.push({ slug: conn.slug, name: conn.slug, provider: conn.provider, status: 'active', actions });
  }
  return out;
}

const deps: ExecutorRouterDeps = {
  resolvePrincipal: async (c) => {
    const u = c.req.header('x-test-user');
    return u ? principalFor(u) : null;
  },
  makeGatewayDeps,
  listCatalog: async (p) => catalogFor(p),
  resolveAdmin: async (c) => {
    const u = c.req.header('x-test-admin');
    return u ? { accountId: ACCOUNT, userId: u } : null;
  },
  listConnectors: async (_projectId, viewerUserId): Promise<AdminConnectorView[]> =>
    [...world.connectors.values()].map((conn) => ({
      slug: conn.slug,
      name: conn.slug,
      provider: conn.provider,
      status: 'active',
      credentialMode: conn.credentialMode,
      actions: [],
      authSecret: conn.hasAuth ? 'credential' : null,
      sharing: scopeToIntent(conn.shareScope, conn.grants),
      secretSet: conn.hasAuth
        ? world.credentials.has(credKey(conn.connectorId, conn.credentialMode === 'per_user' ? viewerUserId : null))
        : true,
    })),
  syncConnectors: async () => ({ synced: world.connectors.size, errors: [] }),
  setSharing: async (_projectId, slug, intent) => {
    const conn = world.connectors.get(slug);
    if (!conn) return false;
    const { shareScope, grants } = intentToScope(intent);
    conn.shareScope = shareScope;
    conn.grants = grants;
    return true;
  },
};

const app = createExecutorRouter(deps);
const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(`http://x${path}`, init));

beforeEach(() => { world = freshWorld(); });

describe('gateway auth', () => {
  test('401 without token', async () => {
    expect((await req('/connectors')).status).toBe(401);
    expect((await req('/call', { method: 'POST', body: '{}' })).status).toBe(401);
  });
});

describe('GET /connectors', () => {
  test('lists usable connectors + actions', async () => {
    const json = await (await req('/connectors', { headers: { 'x-test-user': ALICE } })).json();
    expect(json.connectors).toHaveLength(1);
    expect(json.connectors[0].actions[0]).toMatchObject({ path: 'charges.create', risk: 'write' });
  });

  test('restricted connector hidden from non-grantee', async () => {
    const conn = world.connectors.get('stripe')!;
    conn.shareScope = 'restricted';
    conn.grants = [{ principalType: 'member', principalId: ALICE }] as SecretGrant[];
    expect((await (await req('/connectors', { headers: { 'x-test-user': ALICE } })).json()).connectors).toHaveLength(1);
    expect((await (await req('/connectors', { headers: { 'x-test-user': BOB } })).json()).connectors).toHaveLength(0);
  });

  test('connector with no credential hidden until connected', async () => {
    world.credentials.delete('conn-stripe|shared');
    expect((await (await req('/connectors', { headers: { 'x-test-user': ALICE } })).json()).connectors).toHaveLength(0);
  });
});

describe('POST /call', () => {
  test('runs end-to-end: shared credential resolved server-side, upstream hit, audited', async () => {
    const res = await req('/call', {
      method: 'POST',
      headers: { 'x-test-user': ALICE, 'content-type': 'application/json' },
      body: JSON.stringify({ connector: 'stripe', action: 'charges.create', args: { amount: 999 } }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, data: { id: 'ch_1', paid: true }, risk: 'write' });
    expect(world.upstream[0]!.headers.Authorization).toBe('Bearer sk_live_xyz');
    expect(JSON.parse(world.upstream[0]!.body!)).toEqual({ amount: 999 });
    expect(world.executions.at(-1)).toMatchObject({ status: 'ok', actingUserId: ALICE });
  });

  test('400 missing fields', async () => {
    expect((await req('/call', { method: 'POST', headers: { 'x-test-user': ALICE, 'content-type': 'application/json' }, body: '{}' })).status).toBe(400);
  });

  test('404 unknown connector', async () => {
    const res = await req('/call', { method: 'POST', headers: { 'x-test-user': ALICE, 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'nope', action: 'x' }) });
    expect(res.status).toBe(404);
  });

  test('403 not shared; no upstream call', async () => {
    const conn = world.connectors.get('stripe')!;
    conn.shareScope = 'restricted';
    conn.grants = [{ principalType: 'member', principalId: ALICE }] as SecretGrant[];
    const res = await req('/call', { method: 'POST', headers: { 'x-test-user': BOB, 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'stripe', action: 'charges.create', args: {} }) });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('not_shared');
    expect(world.upstream).toHaveLength(0);
  });

  test('403 needs_auth when credential missing', async () => {
    world.credentials.delete('conn-stripe|shared');
    const res = await req('/call', { method: 'POST', headers: { 'x-test-user': ALICE, 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'stripe', action: 'charges.create', args: {} }) });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('needs_auth');
  });

  test('502 upstream failure', async () => {
    world.upstreamStatus = 500;
    const res = await req('/call', { method: 'POST', headers: { 'x-test-user': ALICE, 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'stripe', action: 'charges.create', args: {} }) });
    expect(res.status).toBe(502);
  });
});

describe('per_user credential mode', () => {
  test('resolves the acting user\'s own credential', async () => {
    const conn = world.connectors.get('stripe')!;
    conn.credentialMode = 'per_user';
    world.credentials.delete('conn-stripe|shared');
    world.credentials.set('conn-stripe|user-alice', 'sk_alice');
    // alice connected → can call
    const a = await req('/call', { method: 'POST', headers: { 'x-test-user': ALICE, 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'stripe', action: 'charges.create', args: {} }) });
    expect(a.status).toBe(200);
    expect(world.upstream[0]!.headers.Authorization).toBe('Bearer sk_alice');
    // bob hasn't → needs_auth
    const b = await req('/call', { method: 'POST', headers: { 'x-test-user': BOB, 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'stripe', action: 'charges.create', args: {} }) });
    expect(b.status).toBe(403);
    expect((await b.json()).reason).toBe('needs_auth');
  });
});

describe('admin routes', () => {
  test('list shows credential mode + sharing + secretSet', async () => {
    expect((await req(`/projects/${PROJECT}/connectors`)).status).toBe(403);
    const json = await (await req(`/projects/${PROJECT}/connectors`, { headers: { 'x-test-admin': ALICE } })).json();
    expect(json.connectors[0]).toMatchObject({ slug: 'stripe', credentialMode: 'shared', secretSet: true, sharing: { mode: 'project' } });
  });

  test('sync returns count', async () => {
    expect((await (await req(`/projects/${PROJECT}/connectors/sync`, { method: 'POST', headers: { 'x-test-admin': ALICE } })).json()).synced).toBe(1);
  });

  test('set sharing restricts → gateway then denies the excluded user', async () => {
    const put = await req(`/projects/${PROJECT}/connectors/stripe/sharing`, {
      method: 'PUT', headers: { 'x-test-admin': ALICE, 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'members', memberIds: [ALICE] }),
    });
    expect(put.status).toBe(200);
    const bob = await req('/call', { method: 'POST', headers: { 'x-test-user': BOB, 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'stripe', action: 'charges.create', args: {} }) });
    expect(bob.status).toBe(403);
    const alice = await req('/call', { method: 'POST', headers: { 'x-test-user': ALICE, 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'stripe', action: 'charges.create', args: {} }) });
    expect(alice.status).toBe(200);
  });
});

describe('policy enforcement', () => {
  const callCharges = () => req('/call', { method: 'POST', headers: { 'x-test-user': ALICE, 'content-type': 'application/json' }, body: JSON.stringify({ connector: 'stripe', action: 'charges.create', args: {} }) });

  test('block → 403, no upstream', async () => {
    world.policies = [{ match: '*.create', action: 'block', position: 0 }];
    const res = await callCharges();
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe('policy_block');
    expect(world.upstream).toHaveLength(0);
  });

  test('require_approval → 202', async () => {
    world.policies = [{ match: 'charges.*', action: 'require_approval', position: 0 }];
    expect((await callCharges()).status).toBe(202);
  });

  test('always_run catch-all → 200', async () => {
    world.policies = [{ match: '*', action: 'always_run', position: 0 }];
    expect((await callCharges()).status).toBe(200);
  });

  test('blocked tool hidden from catalog', async () => {
    world.policies = [{ match: 'charges.*', action: 'block', position: 0 }];
    expect((await (await req('/connectors', { headers: { 'x-test-user': ALICE } })).json()).connectors[0].actions).toHaveLength(0);
  });
});
