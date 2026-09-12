import { describe, expect, test } from 'bun:test';
import { createConnectorRouter, type ConnectorRouterDeps } from '../connectors/router';

const PROJECT = 'proj-discover';
const ADMIN = { 'x-test-admin': 'user-1' };

function deps(overrides: Partial<ConnectorRouterDeps>): ConnectorRouterDeps {
  return {
    featureFlagEnabled: async () => true,
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
    expect(seen).toEqual([{ q: 'pay', category: 'finance', cursor: '48', limit: 24 }]);
  });

  test('sections forward their limits behind admin and the Discover flag', async () => {
    const seen: unknown[] = [];
    let flag = true;
    const app = createConnectorRouter(
      deps({
        featureFlagEnabled: async () => flag,
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
    expect(seen).toEqual([{ perCategory: 6, maxCategories: 12 }]);

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
