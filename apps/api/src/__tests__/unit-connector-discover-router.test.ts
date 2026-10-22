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
    expect((await request(app, `/projects/${PROJECT}/discover/connectors/detail?id=kortix:gmail`, { headers: ADMIN })).status).toBe(200);
    expect(seen).toEqual([{ catalogue: 'kortix', q: 'mail' }, { id: 'kortix:gmail', catalogue: 'kortix' }]);
    flags = new Set();
    const gated = await request(app, `/projects/${PROJECT}/discover/connectors`, { headers: ADMIN });
    expect(gated.status).toBe(403);
    expect(seen).toHaveLength(2);
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
