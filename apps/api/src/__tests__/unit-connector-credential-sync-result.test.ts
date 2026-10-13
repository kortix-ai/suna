import { describe, expect, test } from 'bun:test';

/**
 * KRTX-2185: storing a connector credential re-syncs an MCP connector, and the
 * PUT returns that sync. Without it the web form reported "Added and
 * connected" while tools/list still answered 401 with the stored credential.
 */
import { createConnectorRouter, type ConnectorRouterDeps } from '../connectors/router';

const PROJECT = 'proj-1';
const errors = [{ slug: 'linear-mcp', error: 'MCP tools/list failed: HTTP 401' }];

function routerWith(setConnectorCredential: ConnectorRouterDeps['setConnectorCredential']) {
  const deps: ConnectorRouterDeps = {
    featureFlagEnabled: async () => true,
    resolvePrincipal: async () => null,
    resolveProjectPrincipal: async () => null,
    makeGatewayDeps: (() => ({}) as unknown) as ConnectorRouterDeps['makeGatewayDeps'],
    listCatalog: async () => [],
    resolveAdmin: async () => ({ accountId: 'acct-1', userId: 'user-alice' }),
    listConnectors: async () => [],
    syncConnectors: async () => ({ synced: 0, errors: [] }),
    setConnectorCredential,
  };
  const app = createConnectorRouter(deps);
  return (body: unknown) =>
    app.fetch(
      new Request(`http://x/projects/${PROJECT}/connectors/linear-mcp/credential`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
}

describe('PUT /connectors/:slug/credential returns the re-sync it ran', () => {
  test('the sync result reaches the caller, errors included', async () => {
    const put = routerWith(async () => ({ ok: true, sync: { synced: 1, errors } }));
    const res = await put({ value: 'synthetic-token' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, sync: { synced: 1, errors } });
  });

  test('a credential write that ran no sync answers { ok: true } alone', async () => {
    const put = routerWith(async () => ({ ok: true }));
    const res = await put({ value: 'synthetic-token' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
