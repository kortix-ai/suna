import { expect, test } from 'bun:test';
import {
  composioCatalogSections,
  composioHiddenToolkits,
  customAuthConfigIds,
  requiresOwnAuthConfig,
  searchComposioCatalog,
  type ComposioCatalogClient,
} from './composio-catalog-search';

function toolkit(slug: string, categories: string[]) {
  return {
    slug,
    name: slug.toUpperCase(),
    meta: { categories: categories.map((id) => ({ id, name: id.replace(/-/g, ' ') })) },
  };
}

function catalogOf(items: ReturnType<typeof toolkit>[]): ComposioCatalogClient {
  return {
    toolkits: {
      async list() {
        return { items };
      },
    },
  };
}

test('sections state each category’s true size over a fixed top slice in usage order', async () => {
  // Usage order is the provider's `sort_by: 'usage'` order. `crm` holds 5, so a
  // 2-card slice must still report 5 — the count a page of 48 used to report
  // was however many CRM apps that page happened to contain.
  const catalogClient = catalogOf([
    toolkit('hubspot', ['crm', 'marketing']),
    toolkit('sentry', ['server-monitoring']),
    toolkit('salesforce', ['crm']),
    toolkit('pipedrive', ['crm']),
    toolkit('mailchimp', ['marketing']),
    toolkit('attio', ['crm']),
    toolkit('close', ['crm', 'crm']),
  ]);
  const result = await composioCatalogSections({
    perCategory: 2,
    maxCategories: 2,
    catalogClient,
  });
  expect(result.provider).toBe('composio');
  expect(result.sections.map(({ key, label, total }) => ({ key, label, total }))).toEqual([
    { key: 'crm', label: 'crm', total: 5 },
    { key: 'marketing', label: 'marketing', total: 2 },
  ]);
  expect(result.sections[0].toolkits.map((item) => item.slug)).toEqual(['hubspot', 'salesforce']);
  expect(result.sections[0].toolkits[0]).toEqual({
    slug: 'hubspot',
    name: 'HUBSPOT',
    logo: null,
    description: null,
    categories: ['crm', 'marketing'],
    isNoAuth: false,
    connected: false,
  });
  // The facet lists every category, not only the sections shown, so an open
  // category can name itself and state its size.
  expect(result.categories).toEqual([
    { key: 'crm', label: 'crm', count: 5 },
    { key: 'marketing', label: 'marketing', count: 2 },
    { key: 'server-monitoring', label: 'server monitoring', count: 1 },
  ]);
});

test('sections break count ties by key and drop blank categories', async () => {
  const catalogClient = catalogOf([
    toolkit('zendesk', ['support', ' ']),
    toolkit('asana', ['productivity']),
    toolkit('notion', ['']),
  ]);
  const result = await composioCatalogSections({ catalogClient });
  expect(result.categories.map((category) => category.key)).toEqual(['productivity', 'support']);
});

test('sections clamp their limits to the pipedream-compatible bounds', async () => {
  const items = Array.from({ length: 50 }, (_, index) =>
    toolkit(`app-${index}`, [`category-${index}`, 'shared']),
  );
  const catalogClient = catalogOf(items);
  const defaults = await composioCatalogSections({ catalogClient });
  expect(defaults.sections).toHaveLength(12);
  expect(defaults.sections[0]).toMatchObject({ key: 'shared', total: 50 });
  expect(defaults.sections[0].toolkits).toHaveLength(6);

  const capped = await composioCatalogSections({
    perCategory: 1000,
    maxCategories: 1000,
    catalogClient,
  });
  expect(capped.sections).toHaveLength(40);
  expect(capped.sections[0].toolkits).toHaveLength(24);
});

test('short searches match names, slugs, and descriptions and preserve public metadata', async () => {
  const catalogClient: ComposioCatalogClient = {
    toolkits: {
      async list() {
        return {
          items: [
            { slug: 'first', name: 'A Name', meta: {} },
            { slug: 'a_slug', name: 'Second', meta: {} },
            {
              slug: 'third',
              name: 'Third',
              no_auth: true,
              meta: {
                description: 'An email tool',
                logo: 'https://example.test/logo.svg',
                categories: [{ id: 'email', name: 'Email' }],
              },
            },
            { slug: 'THIRD', name: 'Duplicate', meta: {} },
            { slug: 'zoom', name: 'Zoom', meta: {} },
          ],
        };
      },
    },
  };
  const result = await searchComposioCatalog({ q: ' A ', catalogClient });
  expect(result.total).toBe(3);
  expect(result.toolkits.map((item) => item.slug)).toEqual(['first', 'a_slug', 'third']);
  expect(result.toolkits[2]).toEqual({
    slug: 'third',
    name: 'Third',
    isNoAuth: true,
    connected: false,
    description: 'An email tool',
    logo: 'https://example.test/logo.svg',
    categories: ['email'],
  });
});

test('concurrent short searches share one catalogue load', async () => {
  let calls = 0;
  const catalogClient: ComposioCatalogClient = {
    toolkits: {
      async list() {
        calls++;
        return { items: [{ slug: 'gmail', name: 'Gmail', meta: {} }] };
      },
    },
  };
  const results = await Promise.all(
    ['g', 'gm', 'ma'].map((q) => searchComposioCatalog({ q, catalogClient })),
  );
  expect(calls).toBe(1);
  expect(results.map((result) => result.total)).toEqual([1, 1, 1]);
});

test('a failed later page never publishes a partial catalogue and the next request retries', async () => {
  let fail = true;
  const cursors: Array<string | undefined> = [];
  const catalogClient: ComposioCatalogClient = {
    toolkits: {
      async list(query) {
        cursors.push(query.cursor);
        if (!query.cursor)
          return { items: [{ slug: 'alpha', name: 'Alpha', meta: {} }], next_cursor: 'page-2' };
        if (fail) throw new Error('provider unavailable');
        return { items: [{ slug: 'gmail', name: 'Gmail', meta: {} }] };
      },
    },
  };
  await expect(searchComposioCatalog({ q: 'a', catalogClient })).rejects.toThrow(
    'provider unavailable',
  );
  fail = false;
  expect(await searchComposioCatalog({ q: 'a', catalogClient })).toMatchObject({ total: 2 });
  expect(cursors).toEqual([undefined, 'page-2', undefined, 'page-2']);
});

test('repeated provider cursors fail instead of looping indefinitely', async () => {
  let calls = 0;
  const catalogClient: ComposioCatalogClient = {
    toolkits: {
      async list() {
        calls++;
        return { items: [], next_cursor: 'same-page' };
      },
    },
  };
  await expect(searchComposioCatalog({ q: 'a', catalogClient })).rejects.toThrow(
    'repeated a cursor',
  );
  expect(calls).toBe(2);
});

test('catalogue caches are isolated by provider client', async () => {
  const client = (slug: string): ComposioCatalogClient => ({
    toolkits: {
      async list() {
        return { items: [{ slug, name: slug, meta: {} }] };
      },
    },
  });
  expect(
    (await searchComposioCatalog({ q: 'a', catalogClient: client('alpha') })).toolkits[0].slug,
  ).toBe('alpha');
  expect(
    (await searchComposioCatalog({ q: 'a', catalogClient: client('beta') })).toolkits[0].slug,
  ).toBe('beta');
});

test('invalid cursors restart and offsets past the last match return an empty page', async () => {
  const catalogClient: ComposioCatalogClient = {
    toolkits: {
      async list() {
        return { items: [{ slug: 'alpha', name: 'Alpha', meta: {} }] };
      },
    },
  };
  for (const cursor of [
    'invalid!',
    Buffer.from('-1').toString('base64url'),
    Buffer.from('1e9').toString('base64url'),
  ]) {
    expect(await searchComposioCatalog({ q: 'a', cursor, catalogClient })).toMatchObject({
      total: 1,
      toolkits: [{ slug: 'alpha' }],
      hasMore: false,
    });
  }
  expect(
    await searchComposioCatalog({
      q: 'a',
      cursor: Buffer.from('99').toString('base64url'),
      catalogClient,
    }),
  ).toMatchObject({ total: 1, toolkits: [], hasMore: false });
});

test('a catalogue snapshot expires after six hours', async () => {
  let calls = 0;
  const catalogClient: ComposioCatalogClient = {
    toolkits: {
      async list() {
        calls++;
        return { items: [{ slug: 'alpha', name: 'Alpha', meta: {} }] };
      },
    },
  };
  const originalNow = Date.now;
  const now = Date.now();
  try {
    Date.now = () => now;
    await searchComposioCatalog({ q: 'a', catalogClient });
    Date.now = () => now + 6 * 60 * 60_000 - 1;
    await searchComposioCatalog({ q: 'al', catalogClient });
    expect(calls).toBe(1);
    Date.now = () => now + 6 * 60 * 60_000;
    await searchComposioCatalog({ q: 'a', catalogClient });
    expect(calls).toBe(2);
  } finally {
    Date.now = originalNow;
  }
});

test('an expired load that fails cannot evict a newer successful catalogue', async () => {
  type CatalogPage = Awaited<ReturnType<ComposioCatalogClient['toolkits']['list']>>;
  let rejectOldLoad!: (reason: Error) => void;
  const oldLoad = new Promise<CatalogPage>((_resolve, reject) => {
    rejectOldLoad = reject;
  });
  let calls = 0;
  const catalogClient: ComposioCatalogClient = {
    toolkits: {
      async list() {
        calls++;
        if (calls === 1) return oldLoad;
        return { items: [{ slug: 'gmail', name: 'Gmail', meta: {} }] };
      },
    },
  };
  const originalNow = Date.now;
  const now = Date.now();
  try {
    Date.now = () => now;
    const pendingSearch = searchComposioCatalog({ q: 'g', catalogClient });
    Date.now = () => now + 6 * 60 * 60_000;
    expect(await searchComposioCatalog({ q: 'gm', catalogClient })).toMatchObject({
      toolkits: [{ slug: 'gmail' }],
    });
    rejectOldLoad(new Error('old request failed'));
    await expect(pendingSearch).rejects.toThrow('old request failed');
    expect(await searchComposioCatalog({ q: 'g', catalogClient })).toMatchObject({
      toolkits: [{ slug: 'gmail' }],
    });
    expect(calls).toBe(2);
  } finally {
    Date.now = originalNow;
  }
});

test('a search matches category names and ids, after name matches', async () => {
  const catalogClient: ComposioCatalogClient = {
    toolkits: {
      async list() {
        return {
          items: [
            { slug: 'hubspot', name: 'HubSpot', meta: { categories: [{ id: 'crm', name: 'CRM' }] } },
            { slug: 'crm_tool', name: 'CRM Tool', meta: {} },
            {
              slug: 'pipedrive',
              name: 'Pipedrive',
              meta: { categories: [{ id: 'sales-and-crm', name: 'Sales & CRM' }] },
            },
            { slug: 'gmail', name: 'Gmail', meta: { categories: [{ id: 'email', name: 'Email' }] } },
          ],
        };
      },
    },
  };

  const byName = await searchComposioCatalog({ q: 'crm', catalogClient });
  expect(byName.toolkits.map((t) => t.slug)).toEqual(['crm_tool', 'hubspot', 'pipedrive']);

  const byLabel = await searchComposioCatalog({ q: 'Email', catalogClient });
  expect(byLabel.toolkits.map((t) => t.slug)).toEqual(['gmail']);
});

// Composio holds no OAuth app for these toolkits (X since 2026-02-12). Tool
// Router refuses them with 400 code 4300 until the project has an auth config
// carrying the operator's own app. Live check on 2026-09-26: 47 of 47 toolkits
// this rule selects were refused; 0 of 25 sampled other toolkits were.
function authToolkit(
  slug: string,
  auth: { schemes?: string[]; managed?: string[]; noAuth?: boolean },
) {
  return {
    slug,
    name: slug.toUpperCase(),
    no_auth: auth.noAuth === true,
    auth_schemes: auth.schemes ?? [],
    composio_managed_auth_schemes: auth.managed ?? [],
    meta: { categories: [{ id: 'social', name: 'Social' }] },
  };
}

const AUTH_CATALOG = [
  authToolkit('twitter', { schemes: ['OAUTH2'] }),
  authToolkit('gmail', { schemes: ['OAUTH2'], managed: ['OAUTH2'] }),
  authToolkit('firecrawl', { schemes: ['API_KEY'] }),
  authToolkit('shopify', { schemes: ['OAUTH2', 'API_KEY'] }),
  authToolkit('composio_search', { noAuth: true }),
];

type AuthConfigRow = {
  id: string;
  status: 'ENABLED' | 'DISABLED';
  is_composio_managed?: boolean;
  toolkit: { slug: string };
  created_at?: string;
};

function catalogWithAuthConfigs(
  configs: AuthConfigRow[] | Error,
  calls: Array<Record<string, unknown>> = [],
): ComposioCatalogClient {
  return {
    toolkits: {
      async list() {
        return { items: AUTH_CATALOG };
      },
    },
    authConfigs: {
      async list(query) {
        calls.push(query);
        if (configs instanceof Error) throw configs;
        return { items: configs, next_cursor: null };
      },
    },
  };
}

test('only an OAuth-only toolkit with no Composio-managed scheme needs its own auth config', () => {
  expect(AUTH_CATALOG.filter(requiresOwnAuthConfig).map((item) => item.slug)).toEqual(['twitter']);
});

test('the catalogue hides a toolkit Composio cannot connect until an auth config exists', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const catalogClient = catalogWithAuthConfigs(
    [
      // Neither of these can serve twitter: one is disabled, one is Composio's own.
      { id: 'ac_disabled', status: 'DISABLED', is_composio_managed: false, toolkit: { slug: 'twitter' } },
      { id: 'ac_managed', status: 'ENABLED', is_composio_managed: true, toolkit: { slug: 'twitter' } },
    ],
    calls,
  );
  const sections = await composioCatalogSections({ catalogClient });
  expect(sections.sections[0].toolkits.map((item) => item.slug)).toEqual([
    'gmail',
    'firecrawl',
    'shopify',
    'composio_search',
  ]);
  expect(sections.categories).toEqual([{ key: 'social', label: 'Social', count: 4 }]);
  const search = await searchComposioCatalog({ q: 'tw', catalogClient });
  expect(search).toMatchObject({ total: 0, toolkits: [] });
  expect(calls[0]).toMatchObject({ is_composio_managed: false, show_disabled: false });
});

test('the catalogue shows that toolkit once an enabled custom auth config exists', async () => {
  const catalogClient = catalogWithAuthConfigs([
    { id: 'ac_twitter', status: 'ENABLED', is_composio_managed: false, toolkit: { slug: 'TWITTER' } },
  ]);
  const search = await searchComposioCatalog({ q: 'tw', catalogClient });
  expect(search).toMatchObject({ total: 1, toolkits: [{ slug: 'twitter' }] });
  expect(await composioHiddenToolkits(catalogClient)).toEqual(new Set());
});

test('the catalogue hides nothing when the auth config list is unavailable', async () => {
  const catalogClient = catalogWithAuthConfigs(new Error('503 upstream'));
  const search = await searchComposioCatalog({ q: 'tw', catalogClient });
  expect(search).toMatchObject({ total: 1, toolkits: [{ slug: 'twitter' }] });
});

test('customAuthConfigIds keeps the newest enabled custom config per toolkit across pages', async () => {
  const queries: Array<Record<string, unknown>> = [];
  const catalogClient: ComposioCatalogClient = {
    toolkits: { async list() { return { items: [] }; } },
    authConfigs: {
      async list(query) {
        queries.push(query);
        return query.cursor
          ? {
              items: [
                { id: 'ac_new', status: 'ENABLED', is_composio_managed: false, toolkit: { slug: 'twitter' }, created_at: '2026-09-02T00:00:00Z' },
              ],
              next_cursor: null,
            }
          : {
              items: [
                { id: 'ac_old', status: 'ENABLED', is_composio_managed: false, toolkit: { slug: 'twitter' }, created_at: '2026-09-01T00:00:00Z' },
                { id: 'ac_off', status: 'DISABLED', is_composio_managed: false, toolkit: { slug: 'xero' } },
                { id: 'ac_managed', status: 'ENABLED', is_composio_managed: true, toolkit: { slug: 'xero' } },
              ],
              next_cursor: 'page-2',
            };
      },
    },
  };
  expect(await customAuthConfigIds({ catalogClient, toolkit: 'twitter' })).toEqual(
    new Map([['twitter', 'ac_new']]),
  );
  expect(queries).toEqual([
    { toolkit_slug: 'twitter', is_composio_managed: false, show_disabled: false, limit: 100 },
    { toolkit_slug: 'twitter', is_composio_managed: false, show_disabled: false, limit: 100, cursor: 'page-2' },
  ]);
});
