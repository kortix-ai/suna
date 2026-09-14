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

describe('Discover browse sections', () => {
  const entry = (
    slug: string,
    categories: string[],
    popularity: number | null = null,
    name = slug,
  ) => ({
    id: `mcp/${slug}`,
    kind: 'mcp',
    slug,
    name,
    domain: `${slug}.example`,
    categories,
    feeds: [],
    ...(popularity === null ? {} : { popularity }),
  });

  // Shaped like the live feed on 2026-09-11: raw categories spelled several ways
  // (`financial`, `financial-services`, `developer_tools`), uncurated ones
  // (`cloud`), and uncategorized records. The page used to bucket one 48-item
  // page of 5531 and head each bucket with its card count — `Finance · 1`.
  const catalogOf = (data: unknown[]) =>
    createConnectorCatalog({
      fetch: async () => new Response(JSON.stringify({ version: 1, data })),
      ttlMs: 60_000,
    });

  const LIVE_SHAPED = [
    entry('ledgerly', ['financial']),
    entry('coinbase', ['financial-services']),
    entry('stripe', ['payments'], 50),
    entry('acme-cloud', ['cloud']),
    entry('skyhost', ['cloud']),
    entry('github', ['developer_tools'], 90),
    entry('mystery', []),
    entry('notion', ['productivity', 'documents'], 100),
    entry('asana', ['project-management', 'productivity']),
  ];

  test('sections state each curated category’s size across the COMPLETE catalogue', async () => {
    const result = await catalogOf(LIVE_SHAPED).sections({ perCategory: 2, maxCategories: 4 });
    // Curated rank first (Productivity, Finance, then Developer tools is last of
    // the curated list), the uncurated tail by size, `Other` at the very end.
    expect(result.sections.map(({ key, label, total }) => ({ key, label, total }))).toEqual([
      { key: 'productivity', label: 'Productivity', total: 2 },
      { key: 'finance', label: 'Finance', total: 3 },
      { key: 'developer-tools', label: 'Developer tools', total: 1 },
      { key: 'cloud', label: 'Cloud', total: 2 },
    ]);
    // Picks lead a section: Stripe is Finance's first pick, ahead of feed order.
    expect(result.sections[1].items.map((item) => item.slug)).toEqual(['stripe', 'ledgerly']);
    // The facet counts every category, `Other` included, so an open category
    // can name itself and state its size.
    expect(result.categories).toEqual([
      { key: 'productivity', label: 'Productivity', count: 2 },
      { key: 'finance', label: 'Finance', count: 3 },
      { key: 'developer-tools', label: 'Developer tools', count: 1 },
      { key: 'cloud', label: 'Cloud', count: 2 },
      { key: 'Other', label: 'Other', count: 1 },
    ]);
  });

  test('Popular is the top of the whole catalogue by rank, capped to one slice', async () => {
    const result = await catalogOf(LIVE_SHAPED).sections({ perCategory: 2 });
    expect(result.popular.map((item) => item.slug)).toEqual(['notion', 'github']);
    // A popular app still appears in its real category. Hiding it there would
    // make that section lie about what it contains.
    const productivity = result.sections.find((section) => section.key === 'productivity');
    expect(productivity?.items.map((item) => item.slug)).toContain('notion');

    const unranked = await catalogOf([entry('ledgerly', ['financial'])]).sections();
    expect(unranked.popular).toEqual([]);
  });

  test('a section slice shows one card per product domain, not one per surface', async () => {
    // Live feed: `stripe-com` (MCP), `stripe-com-openapi` and `stripe-com-cli`
    // are three records for one product. Picks match by name, so all three
    // floated into Finance's six cards as "Stripe, Stripe, Stripe". The add
    // flow resolves every surface for a domain, so one card per domain loses
    // nothing — and the section total still counts every record "View all"
    // lists.
    const surface = (slug: string, domain: string, categories: string[], popularity?: number) => ({
      ...entry(slug, categories, popularity ?? null, 'Stripe'),
      domain,
    });
    const result = await catalogOf([
      surface('stripe-com', 'stripe.com', ['payments'], 70),
      surface('stripe-com-openapi', 'stripe.com', ['payments'], 60),
      surface('stripe-com-cli', 'stripe.com', ['payments']),
      entry('ledgerly', ['financial'], 50),
    ]).sections();
    const finance = result.sections.find((section) => section.key === 'finance');
    expect(finance?.total).toBe(4);
    expect(finance?.items.map((item) => item.slug)).toEqual(['stripe-com', 'ledgerly']);
    expect(result.popular.map((item) => item.slug)).toEqual(['stripe-com', 'ledgerly']);
  });

  test('section limits default to 6 x 12 and cap at 24 x 40', async () => {
    const many = Array.from({ length: 60 }, (_, index) =>
      entry(`app-${index}`, [`raw-${index}`, 'productivity']),
    );
    const catalog = catalogOf(many);
    const defaults = await catalog.sections();
    expect(defaults.sections).toHaveLength(12);
    expect(defaults.sections[0]).toMatchObject({ key: 'productivity', total: 60 });
    expect(defaults.sections[0].items).toHaveLength(6);
    const capped = await catalog.sections({ perCategory: 999, maxCategories: 999 });
    expect(capped.sections).toHaveLength(40);
    expect(capped.sections[0].items).toHaveLength(24);
  });

  test('a category filter serves exactly the set its section counted, picks first', async () => {
    const catalog = catalogOf(LIVE_SHAPED);
    const page = await catalog.list({ category: 'finance' });
    expect(page.total).toBe(3);
    expect(page.items.map((item) => item.slug)).toEqual(['stripe', 'ledgerly', 'coinbase']);

    const other = await catalog.list({ category: 'Other' });
    expect(other.items.map((item) => item.slug)).toEqual(['mystery']);

    const searched = await catalog.list({ category: 'finance', q: 'coin' });
    expect(searched.items.map((item) => item.slug)).toEqual(['coinbase']);

    expect(await catalog.list({ category: 'no-such-category' })).toMatchObject({
      total: 0,
      items: [],
      hasMore: false,
    });
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
