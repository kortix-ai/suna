/**
 * An agent session cannot point the project at a server nobody chose: a
 * `POST …/connectors` from a session with a remote source the project does
 * not already have answers 403 `custom_connector_needs_human` and a link a
 * person confirms. People (JWT, PAT) are unchanged. Fake deps, no database.
 */
import { describe, expect, test } from 'bun:test';
import { createConnectorRouter, type ConnectorRouterDeps } from '../connectors/router';

function app(created: unknown[]) {
  return createConnectorRouter({
    featureFlagEnabled: async () => false,
    resolvePrincipal: async () => null,
    resolveProjectPrincipal: async () => null,
    makeGatewayDeps: (() => ({})) as unknown as ConnectorRouterDeps['makeGatewayDeps'],
    listCatalog: async () => [],
    resolveAdmin: async () => ({ accountId: 'acct-1', userId: 'user-1' }),
    listConnectors: async () => [],
    syncConnectors: async () => ({ synced: 0, errors: [] }),
    isAgentCaller: (c) => c.req.header('x-test-session') === '1',
    customConnectorSetupUrl: (projectId, draft) => `https://app.test/projects/${projectId}/customize/connectors?custom_url=${encodeURIComponent(String(draft.url ?? draft.spec ?? draft.endpoint ?? draft.baseUrl))}`,
    listConnectorIdentities: async () => [{ slug: 'wiki', identity: 'mcp:https://mcp.deepwiki.com/mcp' }],
    createConnector: async (_p, _a, draft) => {
      created.push(draft.slug);
      return { ok: true, sync: { synced: 1, errors: [] } };
    },
  } as ConnectorRouterDeps);
}

const post = (body: Record<string, unknown>, session: boolean, created: unknown[]) =>
  app(created).fetch(
    new Request('http://x/projects/p1/connectors', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(session ? { 'x-test-session': '1' } : {}) },
      body: JSON.stringify({ auth: { type: 'none', in: 'header' }, ...body }),
    }),
  );

describe('POST /connectors from an agent session', () => {
  test('a new remote server is refused with the code and a link for a person', async () => {
    const created: unknown[] = [];
    for (const body of [
      { slug: 'evil', provider: 'mcp', url: 'https://mcp.example.com/mcp' },
      { slug: 'api', provider: 'openapi', spec: 'https://example.com/openapi.json' },
      { slug: 'gql', provider: 'graphql', endpoint: 'https://example.com/graphql' },
      { slug: 'wiki', provider: 'mcp', url: 'https://mcp.deepwiki.com/mcp', baseUrl: 'https://example.com' },
    ]) {
      const res = await post(body, true, created);
      expect(res.status).toBe(403);
      const json = (await res.json()) as { code: string; setup_url: string };
      expect(json.code).toBe('custom_connector_needs_human');
      expect(json.setup_url).toStartWith('https://app.test/projects/p1/customize/connectors?custom_url=');
    }
    expect(created).toEqual([]);
  });

  test('a server the project already has, a toolkit, and a repo spec still work', async () => {
    const created: unknown[] = [];
    expect((await post({ slug: 'wiki', provider: 'mcp', url: 'https://mcp.deepwiki.com/mcp/', name: 'Wiki' }, true, created)).status).toBe(200);
    expect((await post({ slug: 'mail', provider: 'composio', app: 'gmail' }, true, created)).status).toBe(200);
    expect((await post({ slug: 'local', provider: 'openapi', spec: 'specs/api.yaml' }, true, created)).status).toBe(200);
    expect(created).toEqual(['wiki', 'mail', 'local']);
  });

  test('a person adds any server', async () => {
    const created: unknown[] = [];
    expect((await post({ slug: 'evil', provider: 'mcp', url: 'https://mcp.example.com/mcp' }, false, created)).status).toBe(200);
    expect(created).toEqual(['evil']);
  });
});
