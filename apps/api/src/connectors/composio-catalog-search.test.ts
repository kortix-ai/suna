import { expect, test } from 'bun:test';
import {
  composioCatalogSections,
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
