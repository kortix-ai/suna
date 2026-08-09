import { describe, expect, test } from 'bun:test';
import { createConnectorCatalog } from '../connectors/connector-catalog';
import { isCatalogApp } from '../connectors/pipedream-catalog';

const INDEX = {
  version: 1,
  generatedAt: '2026-07-08T01:44:23.703Z',
  data: [
    {
      id: 'openapi/1forge-com',
      kind: 'openapi',
      slug: '1forge-com',
      name: '1Forge Finance APIs',
      description: 'Stock and Forex Data',
      icon: 'https://integrations.sh/logo/1forge.com',
      domain: '1forge.com',
      categories: ['financial'],
      feeds: ['apis-guru'],
    },
    {
      id: 'mcp/notion',
      kind: 'mcp',
      slug: 'notion',
      name: 'Notion',
      description: 'Workspace tools',
      icon: 'https://integrations.sh/logo/notion.com',
      domain: 'notion.com',
      categories: ['productivity'],
      feeds: ['openai'],
      popularity: 100,
    },
    {
      id: 'cli/example',
      kind: 'cli',
      slug: 'example',
      name: 'Example CLI',
      domain: 'example.com',
      categories: ['developer-tools'],
      feeds: [],
    },
  ],
};

describe('Discover integrations.sh catalogue', () => {
  test('pages and searches the validated public index without refetching a warm cache', async () => {
    let calls = 0;
    const catalog = createConnectorCatalog({
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify(INDEX));
      },
      ttlMs: 60_000,
    });

    const first = await catalog.list({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual(['openapi/1forge-com', 'mcp/notion']);
    expect(first.nextCursor).toBe('2');
    expect(first.hasMore).toBe(true);
    expect(first.total).toBe(3);

    const search = await catalog.list({ q: 'productivity', limit: 10 });
    expect(search.items.map((item) => item.id)).toEqual(['mcp/notion']);
    expect(search.hasMore).toBe(false);
    expect(calls).toBe(1);
  });

  test('normalizes every domain surface and only makes runnable variants connectable', async () => {
    const requested: string[] = [];
    const catalog = createConnectorCatalog({
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url.endsWith('/api.json')) return new Response(JSON.stringify(INDEX));
        return new Response(
          JSON.stringify({
            version: 3,
            domain: 'notion.com',
            surfaces: [
              {
                type: 'http',
                slug: 'notion-api',
                name: 'Notion API',
                url: 'https://api.notion.com',
                docs: 'https://developers.notion.com/reference/intro',
                auth: {
                  status: 'required',
                  entries: [
                    {
                      use: [
                        {
                          mechanics: {
                            source: 'http',
                            in: 'header',
                            headerName: 'Authorization',
                            scheme: 'Bearer',
                          },
                        },
                      ],
                    },
                  ],
                },
              },
              {
                type: 'mcp',
                slug: 'notion-mcp',
                name: 'Notion MCP',
                url: 'https://mcp.notion.com/mcp',
                transports: ['streamable-http', 'sse'],
                docs: 'https://developers.notion.com/guides/mcp/overview',
                auth: { status: 'required', entries: [] },
              },
              {
                type: 'graphql',
                slug: 'notion-graphql',
                name: 'Notion GraphQL',
                url: 'https://api.notion.com/graphql',
                spec: 'introspection',
              },
              {
                type: 'cli',
                slug: 'notion-cli',
                name: 'Notion CLI',
                command: 'ntn',
                docs: 'https://developers.notion.com/cli',
              },
            ],
          }),
        );
      },
    });

    const detail = await catalog.detail('mcp/notion');
    expect(detail.item.domain).toBe('notion.com');
    expect(detail.variants.map((variant) => variant.kind)).toEqual([
      'http',
      'mcp',
      'graphql',
      'cli',
    ]);
    expect(detail.variants[0]?.connector).toBeNull();
    expect(detail.variants[1]?.connector).toEqual({
      provider: 'mcp',
      url: 'https://mcp.notion.com/mcp',
      transport: 'http',
      auth: {
        type: 'bearer',
        in: 'header',
        name: 'Authorization',
        prefix: 'Bearer',
      },
    });
    expect(detail.variants[2]?.connector).toEqual({
      provider: 'graphql',
      endpoint: 'https://api.notion.com/graphql',
    });
    expect(detail.variants[3]?.connector).toBeNull();
    expect(requested.at(-1)).toBe('https://integrations.sh/api/notion.com/surface');
  });

  test('rejects detail ids that are not present in the trusted index', async () => {
    const catalog = createConnectorCatalog({
      fetch: async () => new Response(JSON.stringify(INDEX)),
    });
    await expect(catalog.detail('mcp/unknown')).rejects.toThrow('Connector not found');
  });

  test('enriches HubSpot with its official public Postman repository', async () => {
    const catalog = createConnectorCatalog({
      fetch: async (input) => {
        if (String(input).endsWith('/api.json')) {
          return new Response(
            JSON.stringify({
              version: 1,
              data: [
                {
                  id: 'mcp/hubspot',
                  kind: 'mcp',
                  slug: 'hubspot',
                  name: 'HubSpot',
                  domain: 'hubspot.com',
                  categories: [],
                  feeds: [],
                },
              ],
            }),
          );
        }
        return new Response(JSON.stringify({ version: 3, domain: 'hubspot.com', surfaces: [] }));
      },
    });

    const detail = await catalog.detail('mcp/hubspot');
    expect(detail.variants).toContainEqual(
      expect.objectContaining({
        kind: 'postman',
        name: 'HubSpot Public API Collection',
        connector: {
          provider: 'postman',
          spec: 'https://github.com/HubSpot/HubSpot-public-api-spec-collection',
          auth: {
            type: 'bearer',
            in: 'header',
            name: 'Authorization',
            prefix: 'Bearer',
          },
        },
      }),
    );
  });
});

describe('Pipedream catalogue membership', () => {
  test('accepts any auth type, so long as the app has actions', () => {
    expect(isCatalogApp({ slug: 'github', hasActions: true })).toBe(true);
    // The regression this predicate was changed to fix: every SAP and Oracle
    // hit on the live catalogue is `auth_type: "keys"`, and requiring OAuth
    // made the page report "No matches for SAP" over a catalogue that had it.
    expect(isCatalogApp({ slug: 'sap_s_4hana_cloud', hasActions: true })).toBe(true);
    expect(isCatalogApp({ slug: 'oracle_cloud_infrastructure', hasActions: true })).toBe(true);
  });

  test('rejects apps with no actions — a connector with no tools is a dead end', () => {
    expect(isCatalogApp({ slug: 'github', hasActions: false })).toBe(false);
  });

  test('rejects workflow utilities and natively-handled apps', () => {
    expect(isCatalogApp({ slug: 'schedule', hasActions: true })).toBe(false);
    expect(isCatalogApp({ slug: 'slack', hasActions: true })).toBe(false);
  });
});
