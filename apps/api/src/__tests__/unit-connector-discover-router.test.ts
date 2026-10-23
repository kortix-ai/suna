import { describe, expect, test } from 'bun:test';
import { createConnectorRouter, type ConnectorRouterDeps } from '../connectors/router';

const PROJECT = 'proj-discover';
const ADMIN = { 'x-test-admin': 'user-1' };

function deps(overrides: Partial<ConnectorRouterDeps>): ConnectorRouterDeps {
  return {
    // Discover on, Connectors v2 off: the integrations.sh catalogue.
    featureFlagEnabled: async (_projectId, key) => key === 'connectors_api_discover',
    resolvePrincipal: async () => null,
    resolveProjectPrincipal: async () => null,
    makeGatewayDeps: (() => ({}) as unknown) as ConnectorRouterDeps['makeGatewayDeps'],
    listCatalog: async () => [],
    resolveAdmin: async (c) =>
      c.req.header('x-test-admin') ? { accountId: 'acct-1', userId: 'user-1' } : null,
    listConnectors: async () => [],
    syncConnectors: async () => ({ synced: 0, errors: [] }),
    ...overrides,
  };
}

function request(app: ReturnType<typeof createConnectorRouter>, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://x${path}`, init));
}

describe('Discover catalogue routes', () => {
  test('the list forwards a category and page size', async () => {
    const seen: unknown[] = [];
    const app = createConnectorRouter(
      deps({
        listDiscoverConnectors: async (input) => {
          seen.push(input);
          return { items: [], total: 0, hasMore: false };
        },
      }),
    );
    const res = await request(
      app,
      `/projects/${PROJECT}/discover/connectors?q=pay&category=finance&cursor=48&limit=24`,
      { headers: ADMIN },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ catalogue: 'integrations', q: 'pay', category: 'finance', cursor: '48', limit: 24 }]);
  });

  test('a Connectors v2 project browses Kortix\'s own MCP apps; with neither flag the routes are gated', async () => {
    const seen: unknown[] = [];
    let flags = new Set(['connectors_v2']);
    const app = createConnectorRouter(
      deps({
        featureFlagEnabled: async (_projectId, key) => flags.has(key),
        listDiscoverConnectors: async (input) => {
          seen.push(input);
          return { items: [], total: 0, hasMore: false };
        },
        getDiscoverConnector: async (id, catalogue) => {
          seen.push({ id, catalogue });
          return { item: null, variants: [] };
        },
      }),
    );
    expect((await request(app, `/projects/${PROJECT}/discover/connectors?q=mail`, { headers: ADMIN })).status).toBe(200);
    expect((await request(app, `/projects/${PROJECT}/discover/connectors?oneClick=1`, { headers: ADMIN })).status).toBe(200);
    expect((await request(app, `/projects/${PROJECT}/discover/connectors?oneClick=nope`, { headers: ADMIN })).status).toBe(400);
    expect((await request(app, `/projects/${PROJECT}/discover/connectors/detail?id=kortix:gmail`, { headers: ADMIN })).status).toBe(200);
    expect(seen).toEqual([{ catalogue: 'kortix', q: 'mail' }, { catalogue: 'kortix', oneClick: true }, { id: 'kortix:gmail', catalogue: 'kortix' }]);
    flags = new Set();
    const gated = await request(app, `/projects/${PROJECT}/discover/connectors`, { headers: ADMIN });
    expect(gated.status).toBe(403);
    expect(seen).toHaveLength(3);
  });

  test('sections forward their limits behind admin and the Discover flag', async () => {
    const seen: unknown[] = [];
    let flag = true;
    const app = createConnectorRouter(
      deps({
        featureFlagEnabled: async (_projectId, key) => flag && key === 'connectors_api_discover',
        listDiscoverSections: async (input) => {
          seen.push(input);
          return { popular: [], sections: [], categories: [] };
        },
      }),
    );
    const path = `/projects/${PROJECT}/discover/sections?perCategory=6&maxCategories=12`;

    const res = await request(app, path, { headers: ADMIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ popular: [], sections: [], categories: [] });
    expect(seen).toEqual([{ catalogue: 'integrations', perCategory: 6, maxCategories: 12 }]);

    expect((await request(app, path)).status).toBe(403);
    flag = false;
    expect((await request(app, path, { headers: ADMIN })).status).toBe(403);
    expect(seen).toHaveLength(1);
  });

  test('sections report an upstream catalogue outage as 502', async () => {
    const app = createConnectorRouter(
      deps({
        listDiscoverSections: async () => {
          throw new Error('integrations.sh returned 503');
        },
      }),
    );
    const res = await request(app, `/projects/${PROJECT}/discover/sections`, { headers: ADMIN });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'integrations.sh returned 503' });
  });
});

describe('Connectors v2 catalogue: type filter, tools and install', () => {
  const stripe = {
    item: { id: 'kortix:stripe', kind: 'mcp', slug: 'stripe', name: 'Stripe', domain: 'stripe.com' },
    variants: [
      { id: 'kortix:stripe:mcp', kind: 'mcp', name: 'Stripe', url: 'https://mcp.stripe.com', connector: { provider: 'mcp', url: 'https://mcp.stripe.com', transport: 'http' }, oneClick: true, recommended: true },
      { id: 'composio:stripe', kind: 'composio', name: 'Stripe', url: null, connector: null, oneClick: true, composio: { slug: 'stripe' } },
    ],
  };
  function v2App(seen: unknown[], createStatus: Array<{ ok: boolean; status?: number }> = [{ ok: true }]) {
    return createConnectorRouter(
      deps({
        featureFlagEnabled: async (_projectId, key) => key === 'connectors_v2',
        listDiscoverConnectors: async (input) => {
          seen.push(input);
          return { items: [], total: 0, hasMore: false };
        },
        getDiscoverConnector: async () => stripe,
        discoverConnectorTools: async (variant) => {
          seen.push({ tools: variant.id });
          return { tools: [{ name: 'list_customers', description: 'List customers' }], total: 1, source: 'directory' };
        },
        createConnector: async (_projectId, _accountId, draft) => {
          seen.push({ create: draft });
          const next = createStatus.shift() ?? { ok: true };
          return next.ok ? { ok: true, sync: { synced: 1, errors: [] } } : { ok: false, status: next.status ?? 409, error: 'exists' };
        },
      } as Partial<ConnectorRouterDeps>),
    );
  }

  test('kind=mcp,composio reaches the catalogue; an unknown kind is 400', async () => {
    const seen: unknown[] = [];
    const app = v2App(seen);
    expect((await request(app, `/projects/${PROJECT}/discover/connectors?kind=mcp,composio`, { headers: ADMIN })).status).toBe(200);
    expect((await request(app, `/projects/${PROJECT}/discover/connectors?kind=soap`, { headers: ADMIN })).status).toBe(400);
    expect(seen).toEqual([{ catalogue: 'kortix', kinds: ['mcp', 'composio'] }]);
  });

  test('tools read the recommended way, or the way asked for', async () => {
    const seen: unknown[] = [];
    const app = v2App(seen);
    const res = await request(app, `/projects/${PROJECT}/discover/connectors/tools?id=kortix:stripe`, { headers: ADMIN });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ way: { id: 'kortix:stripe:mcp', kind: 'mcp', name: 'Stripe' }, tools: [{ name: 'list_customers', description: 'List customers' }], total: 1, source: 'directory' });
    await request(app, `/projects/${PROJECT}/discover/connectors/tools?id=kortix:stripe&way=composio:stripe`, { headers: ADMIN });
    expect(seen.at(-1)).toEqual({ tools: 'composio:stripe' });
    expect((await request(app, `/projects/${PROJECT}/discover/connectors/tools?id=kortix:stripe&way=nope`, { headers: ADMIN })).status).toBe(404);
  });

  test('install adds the recommended way as a profile, retries a taken default slug, and honours way and name', async () => {
    const seen: Array<{ create?: Record<string, unknown> }> = [];
    const app = v2App(seen as unknown[], [{ ok: false, status: 409 }, { ok: true }]);
    const post = (body: unknown) => request(app, `/projects/${PROJECT}/discover/install`, { method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const res = await post({ id: 'kortix:stripe' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; next: string; way: { kind: string } };
    expect(body.slug).toMatch(/^stripe-[a-z0-9]{1,6}$/);
    expect(body).toMatchObject({ provider: 'mcp', next: 'connect', way: { kind: 'mcp', oneClick: true } });
    expect(seen.filter((s) => s.create).map((s) => s.create!.slug)).toEqual([body.slug, body.slug]);
    const managed = await post({ id: 'kortix:stripe', way: 'composio:stripe', name: 'Billing' });
    expect(await managed.json()).toMatchObject({ slug: 'billing', provider: 'composio', next: 'connect' });
    expect(seen.at(-1)).toEqual({ create: { slug: 'billing', name: 'Billing', provider: 'composio', app: 'stripe', account: 'default', create_only: true } });
    expect((await post({})).status).toBe(400);
  });
});
