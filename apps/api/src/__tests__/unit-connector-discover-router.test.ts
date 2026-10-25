import { describe, expect, test } from 'bun:test';
import { createConnectorRouter, type ConnectorRouterDeps } from '../connectors/router';

const PROJECT = 'proj-discover';
const ADMIN = { 'x-test-admin': 'user-1' };

function deps(overrides: Partial<ConnectorRouterDeps>): ConnectorRouterDeps {
  return {
    // Email on: no Kortix app hidden. Discover itself has no flag.
    featureFlagEnabled: async (_projectId, key) => key === 'email_channel',
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
    expect(seen).toEqual([{ q: 'pay', category: 'finance', cursor: '48', limit: 24, exclude: new Set() }]);
  });

  test('every project browses the one catalogue; there is no flag gate', async () => {
    const seen: unknown[] = [];
    const app = createConnectorRouter(
      deps({
        featureFlagEnabled: async () => false,
        listDiscoverConnectors: async (input) => {
          seen.push(input);
          return { items: [], total: 0, hasMore: false };
        },
        getDiscoverConnector: async (id) => {
          seen.push({ id });
          return { item: null, variants: [] };
        },
      }),
    );
    expect((await request(app, `/projects/${PROJECT}/discover/connectors?q=mail`, { headers: ADMIN })).status).toBe(200);
    expect((await request(app, `/projects/${PROJECT}/discover/connectors?oneClick=1`, { headers: ADMIN })).status).toBe(200);
    expect((await request(app, `/projects/${PROJECT}/discover/connectors?oneClick=nope`, { headers: ADMIN })).status).toBe(400);
    expect((await request(app, `/projects/${PROJECT}/discover/connectors/detail?id=kortix:gmail`, { headers: ADMIN })).status).toBe(200);
    expect(seen).toEqual([
      { q: 'mail', exclude: new Set(['native:email']) },
      { oneClick: true, exclude: new Set(['native:email']) },
      { id: 'kortix:gmail' },
    ]);
    // Admin still required.
    expect((await request(app, `/projects/${PROJECT}/discover/connectors`)).status).toBe(403);
  });

  test('Email is hidden from the catalogue until the project turns email_channel on', async () => {
    let flags = new Set<string>();
    const items = [
      { id: 'native:slack', name: 'Slack' },
      { id: 'native:email', name: 'Email' },
    ];
    const app = createConnectorRouter(
      deps({
        featureFlagEnabled: async (_projectId, key) => flags.has(key),
        // A fake catalogue that, like the real one, leaves `exclude`d ids out before counting.
        listDiscoverConnectors: async ({ exclude }) => {
          const kept = items.filter((item) => !exclude?.has(item.id));
          return { items: kept, total: kept.length, hasMore: false };
        },
        listDiscoverSections: async ({ exclude }) => {
          const kept = items.filter((item) => !exclude?.has(item.id));
          return { sections: [{ key: 'kortix', total: kept.length, items: kept }] };
        },
        getDiscoverConnector: async (id) => ({ item: { id }, variants: [] }),
      }),
    );
    const list = await request(app, `/projects/${PROJECT}/discover/connectors`, { headers: ADMIN });
    const listed = (item: (typeof items)[number]) => ({ ...item, installed: [] });
    expect(await list.json()).toEqual({ items: [listed(items[0]!)], total: 1, hasMore: false });
    const sections = await request(app, `/projects/${PROJECT}/discover/sections`, { headers: ADMIN });
    expect(await sections.json()).toEqual({ sections: [{ key: 'kortix', total: 1, items: [listed(items[0]!)] }] });
    // The old `channel:email` id is the same app: hidden too.
    for (const id of ['native:email', 'channel:email']) {
      const detail = await request(app, `/projects/${PROJECT}/discover/connectors/detail?id=${id}`, { headers: ADMIN });
      expect(detail.status).toBe(404);
    }

    flags = new Set(['email_channel']);
    const on = await request(app, `/projects/${PROJECT}/discover/connectors`, { headers: ADMIN });
    expect(await on.json()).toEqual({ items: items.map(listed), total: 2, hasMore: false });
    expect((await request(app, `/projects/${PROJECT}/discover/connectors/detail?id=native:email`, { headers: ADMIN })).status).toBe(200);
  });

  test('sections forward their limits behind admin', async () => {
    const seen: unknown[] = [];
    const app = createConnectorRouter(
      deps({
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
    expect(seen).toEqual([{ perCategory: 6, maxCategories: 12, exclude: new Set() }]);

    expect((await request(app, path)).status).toBe(403);
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

describe('the catalogue: type filter, tools and install', () => {
  const stripe = {
    item: { id: 'kortix:stripe', kind: 'mcp', slug: 'stripe', name: 'Stripe', domain: 'stripe.com' },
    variants: [
      { id: 'kortix:stripe:mcp', kind: 'mcp', name: 'Stripe', url: 'https://mcp.stripe.com', connector: { provider: 'mcp', url: 'https://mcp.stripe.com', transport: 'http' }, oneClick: true, recommended: true },
      { id: 'composio:stripe', kind: 'composio', name: 'Stripe', url: null, connector: null, oneClick: true, composio: { slug: 'stripe' } },
      { id: 'stripe-api', kind: 'openapi', name: 'Stripe API', url: null, connector: { provider: 'openapi', spec: 'https://example.test/spec.json', auth: { type: 'bearer', in: 'header', name: 'Authorization', prefix: 'Bearer' } } },
      { id: 'kortix:stripe:oauth', kind: 'mcp', name: 'Stripe sign-in', url: 'https://mcp.stripe.com/oauth', connector: { provider: 'mcp', url: 'https://mcp.stripe.com/oauth', transport: 'http', auth: { type: 'bearer', in: 'header', name: 'Authorization', prefix: 'Bearer' } }, oneClick: true },
    ],
  };
  function v2App(
    seen: unknown[],
    createStatus: Array<{ ok: boolean; status?: number; errors?: Array<{ slug: string; error: string }> }> = [{ ok: true }],
    identities: Array<{ slug: string; identity: string | null }> = [],
  ) {
    return createConnectorRouter(
      deps({
        featureFlagEnabled: async (_projectId, key) => key === 'email_channel',
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
          return next.ok ? { ok: true, sync: { synced: 1, errors: next.errors ?? [] } } : { ok: false, status: next.status ?? 409, error: 'exists' };
        },
        listConnectorIdentities: async () => identities,
      } as Partial<ConnectorRouterDeps>),
    );
  }

  test('kind=mcp,composio reaches the catalogue; an unknown kind is 400', async () => {
    const seen: unknown[] = [];
    const app = v2App(seen);
    expect((await request(app, `/projects/${PROJECT}/discover/connectors?kind=mcp,composio`, { headers: ADMIN })).status).toBe(200);
    expect((await request(app, `/projects/${PROJECT}/discover/connectors?kind=soap`, { headers: ADMIN })).status).toBe(400);
    expect(seen).toEqual([{ kinds: ['mcp', 'composio'], exclude: new Set() }]);
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

  test('install adds the recommended way as a profile and honours way and name', async () => {
    const seen: Array<{ create?: Record<string, unknown> }> = [];
    const app = v2App(seen as unknown[]);
    const post = (body: unknown) => request(app, `/projects/${PROJECT}/discover/install`, { method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const res = await post({ id: 'kortix:stripe' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, existing: false, slug: 'stripe', provider: 'mcp', next: 'ready', way: { kind: 'mcp', oneClick: true } });
    const managed = await post({ id: 'kortix:stripe', way: 'composio:stripe', name: 'Billing' });
    expect(await managed.json()).toMatchObject({ existing: false, slug: 'billing', provider: 'composio', next: 'connect' });
    expect(seen.at(-1)).toEqual({ create: { slug: 'billing', name: 'Billing', provider: 'composio', app: 'stripe', account: 'default', create_only: true } });
    expect((await post({})).status).toBe(400);
  });

  test('install is idempotent: the same way answers the existing profile; as_new_profile adds a numbered one', async () => {
    const seen: Array<{ create?: Record<string, unknown> }> = [];
    const app = v2App(seen as unknown[], [{ ok: true }], [
      { slug: 'stripe', identity: 'mcp:https://mcp.stripe.com' },
      { slug: 'stripe-2', identity: 'openapi:https://example.test/other.json' },
    ]);
    const post = (body: unknown) => request(app, `/projects/${PROJECT}/discover/install`, { method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const again = await post({ id: 'kortix:stripe' });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, existing: true, slug: 'stripe', next: 'ready' });
    expect(seen.filter((s) => s.create)).toEqual([]);
    const second = await post({ id: 'kortix:stripe', as_new_profile: true });
    expect(await second.json()).toMatchObject({ existing: false, slug: 'stripe-3' });
    expect(seen.filter((s) => s.create).map((s) => s.create!.slug)).toEqual(['stripe-3']);
  });

  test('the existing profile answers its own next step, and no probe runs', async () => {
    let probes = 0;
    const app = createConnectorRouter(
      deps({
        getDiscoverConnector: async () => stripe,
        discoverConnectorAuth: async () => {
          probes += 1;
          return { recommended: null } as never;
        },
        listConnectorIdentities: async () => [{ slug: 'stripe', identity: 'mcp:https://mcp.stripe.com' }],
        listConnectors: async () => [{ slug: 'stripe', state: 'error', state_reason: 'tools/list returned 500' }] as never,
        createConnector: async () => ({ ok: true }),
      } as Partial<ConnectorRouterDeps>),
    );
    const res = await request(app, `/projects/${PROJECT}/discover/install`, { method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'kortix:stripe' }) });
    expect(await res.json()).toMatchObject({ existing: true, slug: 'stripe', next: 'fix', error: 'tools/list returned 500' });
    expect(probes).toBe(0);
  });

  test('a taken slug without a matching way is 409, never a random suffix', async () => {
    const app = v2App([], [{ ok: false, status: 409 }], [{ slug: 'stripe', identity: 'openapi:https://example.test/other.json' }]);
    const res = await request(app, `/projects/${PROJECT}/discover/install`, { method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'kortix:stripe' }) });
    expect(res.status).toBe(409);
  });

  test('an install whose own sync failed answers next: fix with the reason', async () => {
    const app = v2App([], [{ ok: true, errors: [{ slug: 'stripe', error: 'tools/list returned 500' }] }]);
    const res = await request(app, `/projects/${PROJECT}/discover/install`, { method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify({ id: 'kortix:stripe' }) });
    expect(await res.json()).toMatchObject({ ok: true, slug: 'stripe', next: 'fix', error: 'tools/list returned 500' });
  });

  test('a way that signs in or takes a key says so', async () => {
    const app = v2App([]);
    const post = (body: unknown) => request(app, `/projects/${PROJECT}/discover/install`, { method: 'POST', headers: { ...ADMIN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(await (await post({ id: 'kortix:stripe', way: 'stripe-api' })).json()).toMatchObject({ next: 'credential' });
    expect(await (await post({ id: 'kortix:stripe', way: 'kortix:stripe:oauth' })).json()).toMatchObject({ next: 'connect' });
  });

  test('the list and the detail mark what the project installed; a source that failed is named', async () => {
    const app = createConnectorRouter(
      deps({
        listDiscoverConnectors: async () => ({
          items: [
            { id: 'kortix:stripe', kind: 'mcp', mcpUrl: 'https://mcp.stripe.com/' },
            { id: 'composio:gmail', kind: 'composio', composio: { slug: 'gmail' } },
            { id: 'linear', kind: 'openapi' },
          ],
          total: 3,
          hasMore: false,
          degraded: ['composio'],
        }),
        getDiscoverConnector: async () => stripe,
        listDiscoverSections: async () => ({
          popular: [{ id: 'composio:gmail', kind: 'composio', composio: { slug: 'gmail' } }],
          sections: [{ key: 'pay', total: 1, items: [{ id: 'kortix:stripe', kind: 'mcp', mcpUrl: 'https://mcp.stripe.com' }] }],
          categories: [],
        }),
        listConnectorIdentities: async () => [
          { slug: 'stripe', identity: 'mcp:https://mcp.stripe.com' },
          { slug: 'mail', identity: 'composio:gmail' },
        ],
      } as Partial<ConnectorRouterDeps>),
    );
    const list = (await (await request(app, `/projects/${PROJECT}/discover/connectors`, { headers: ADMIN })).json()) as { items: Array<{ installed: string[] }>; degraded: string[] };
    expect(list.items.map((i) => i.installed)).toEqual([['stripe'], ['mail'], []]);
    expect(list.degraded).toEqual(['composio']);
    const detail = (await (await request(app, `/projects/${PROJECT}/discover/connectors/detail?id=kortix:stripe`, { headers: ADMIN })).json()) as { installed: string[]; variants: Array<{ installed: string[] }> };
    expect(detail.installed).toEqual(['stripe']);
    const sections = (await (await request(app, `/projects/${PROJECT}/discover/sections`, { headers: ADMIN })).json()) as { popular: Array<{ installed: string[] }>; sections: Array<{ items: Array<{ installed: string[] }> }> };
    expect(sections.popular.map((i) => i.installed)).toEqual([['mail']]);
    expect(sections.sections[0]!.items.map((i) => i.installed)).toEqual([['stripe']]);
    expect(detail.variants.map((v) => v.installed)).toEqual([['stripe'], [], [], []]);
  });
});
