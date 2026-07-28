import { describe, expect, test } from 'bun:test';

import {
  CURATED_GROUPS,
  type CatalogueAvailableInput,
  type CatalogueConnectedInput,
  GROUP_PAGE_SIZE,
  buildCatalogueEntries,
  catalogueCategories,
  catalogueMatchesQuery,
  filterCatalogue,
  groupCatalogue,
  pageCount,
  pageSlice,
} from './connector-catalogue';

function connected(overrides: Partial<CatalogueConnectedInput> = {}): CatalogueConnectedInput {
  return {
    slug: 'gmail',
    name: 'Gmail',
    provider: 'pipedream',
    iconUrl: 'https://icons.test/gmail.png',
    status: 'active',
    actions: [{}, {}, {}],
    authSecret: 'GMAIL_TOKEN',
    secretSet: true,
    ...overrides,
  };
}

function available(overrides: Partial<CatalogueAvailableInput> = {}): CatalogueAvailableInput {
  return {
    slug: 'notion',
    name: 'Notion',
    description: 'Read and write Notion pages and databases.',
    imgSrc: 'https://icons.test/notion.png',
    categories: ['Productivity'],
    ...overrides,
  };
}

describe('buildCatalogueEntries', () => {
  test('lists what the project already has before what it could add', () => {
    const entries = buildCatalogueEntries({
      connectors: [connected()],
      apps: [available()],
    });
    expect(entries.map((entry) => entry.slug)).toEqual(['gmail', 'notion']);
    expect(entries[0]?.connected).toBe(true);
    expect(entries[1]?.connected).toBe(false);
  });

  test('a connected slug never also appears as available', () => {
    const entries = buildCatalogueEntries({
      connectors: [connected({ slug: 'notion', name: 'Notion' })],
      apps: [available()],
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.connected).toBe(true);
  });

  test('borrows the catalogue description for a connector that has none', () => {
    const entries = buildCatalogueEntries({
      connectors: [connected({ slug: 'notion', name: 'Notion' })],
      apps: [available()],
    });
    expect(entries[0]?.description).toBe('Read and write Notion pages and databases.');
    expect(entries[0]?.categories).toEqual(['Productivity']);
  });

  test('counts tools and flags a connector whose credential is missing', () => {
    const entries = buildCatalogueEntries({
      connectors: [connected({ secretSet: false })],
      apps: [],
    });
    expect(entries[0]?.toolCount).toBe(3);
    expect(entries[0]?.needsSetup).toBe(true);
    expect(entries[0]?.failing).toBe(false);
  });

  test('a connector with no auth secret does not read as needing setup', () => {
    const entries = buildCatalogueEntries({
      connectors: [connected({ authSecret: null, secretSet: false })],
      apps: [],
    });
    expect(entries[0]?.needsSetup).toBe(false);
  });

  test('surfaces the error status', () => {
    const entries = buildCatalogueEntries({
      connectors: [connected({ status: 'error' })],
      apps: [],
    });
    expect(entries[0]?.failing).toBe(true);
  });

  test('only one-click apps are marked official', () => {
    const entries = buildCatalogueEntries({
      connectors: [connected({ slug: 'my-api', name: 'My API', provider: 'openapi' })],
      apps: [available()],
    });
    expect(entries[0]?.official).toBe(false);
    expect(entries[1]?.official).toBe(true);
  });
});

describe('catalogueMatchesQuery', () => {
  const [entry] = buildCatalogueEntries({ connectors: [], apps: [available()] });
  const match = (query: string) => (entry ? catalogueMatchesQuery(entry, query) : null);

  test('an empty query matches everything', () => {
    expect(match('   ')).toBe(true);
  });

  test('matches on name, slug and description', () => {
    expect(match('NOTI')).toBe(true);
    expect(match('databases')).toBe(true);
    expect(match('salesforce')).toBe(false);
  });
});

describe('filterCatalogue', () => {
  const entries = buildCatalogueEntries({
    connectors: [connected()],
    apps: [available(), available({ slug: 'linear', name: 'Linear', categories: ['Developer'] })],
  });

  test('Connected keeps only what the project has', () => {
    expect(filterCatalogue(entries, { pill: 'connected' }).map((e) => e.slug)).toEqual(['gmail']);
  });

  test('Available keeps only what it does not', () => {
    expect(filterCatalogue(entries, { pill: 'available' }).map((e) => e.slug)).toEqual([
      'notion',
      'linear',
    ]);
  });

  test('All keeps both', () => {
    expect(filterCatalogue(entries, { pill: 'all' })).toHaveLength(3);
  });

  test('category and query stack with the pill', () => {
    expect(
      filterCatalogue(entries, { pill: 'available', category: 'Productivity' }).map((e) => e.slug),
    ).toEqual(['notion']);
    expect(filterCatalogue(entries, { pill: 'all', query: 'linear' }).map((e) => e.slug)).toEqual([
      'linear',
    ]);
  });
});

describe('catalogueCategories', () => {
  test('deduplicates, trims and sorts what the loaded pages happen to carry', () => {
    const entries = buildCatalogueEntries({
      connectors: [],
      apps: [
        available({ categories: ['Productivity', ' Productivity '] }),
        available({ slug: 'linear', categories: ['Developer Tools', ''] }),
      ],
    });
    expect(catalogueCategories(entries)).toEqual(['Developer Tools', 'Productivity']);
  });
});

describe('groupCatalogue', () => {
  test('puts the project’s own connectors first, outside the curation', () => {
    const groups = groupCatalogue(
      buildCatalogueEntries({ connectors: [connected()], apps: [available()] }),
    );
    expect(groups[0]?.id).toBe('connected');
    expect(groups[0]?.curated).toBe(false);
    expect(groups[0]?.entries.map((e) => e.slug)).toEqual(['gmail']);
  });

  test('a curated slug the API never returned simply does not render', () => {
    const groups = groupCatalogue(buildCatalogueEntries({ connectors: [], apps: [available()] }), [
      { id: 'popular', label: 'Popular', slugs: ['notion', 'a-slug-the-api-never-returns'] },
    ]);
    expect(groups.map((group) => group.id)).toEqual(['popular']);
    expect(groups[0]?.entries.map((e) => e.slug)).toEqual(['notion']);
  });

  test('curation order wins over API order', () => {
    const entries = buildCatalogueEntries({
      connectors: [],
      apps: [available({ slug: 'linear', name: 'Linear' }), available()],
    });
    const groups = groupCatalogue(entries, [
      { id: 'popular', label: 'Popular', slugs: ['notion', 'linear'] },
    ]);
    expect(groups[0]?.entries.map((e) => e.slug)).toEqual(['notion', 'linear']);
  });

  test('an empty group is dropped rather than rendered', () => {
    const groups = groupCatalogue(buildCatalogueEntries({ connectors: [], apps: [available()] }), [
      { id: 'popular', label: 'Popular', slugs: ['notion'] },
      { id: 'sales', label: 'Sales', slugs: ['salesforce'] },
    ]);
    expect(groups.map((group) => group.id)).toEqual(['popular']);
  });

  test('anything the curation misses lands in one trailing group', () => {
    const entries = buildCatalogueEntries({
      connectors: [],
      apps: [available(), available({ slug: 'weird_app', name: 'Weird App' })],
    });
    const groups = groupCatalogue(entries, [
      { id: 'popular', label: 'Popular', slugs: ['notion'] },
    ]);
    expect(groups.map((group) => group.id)).toEqual(['popular', 'more']);
    expect(groups[1]?.entries.map((e) => e.slug)).toEqual(['weird_app']);
    expect(groups[1]?.curated).toBe(false);
  });

  test('a connected connector is not repeated in the trailing group', () => {
    const groups = groupCatalogue(
      buildCatalogueEntries({ connectors: [connected()], apps: [] }),
      [],
    );
    expect(groups.map((group) => group.id)).toEqual(['connected']);
  });

  test('the same app may be filed under more than one curated group', () => {
    const entries = buildCatalogueEntries({ connectors: [], apps: [available({ slug: 'gmail' })] });
    const groups = groupCatalogue(entries, [
      { id: 'popular', label: 'Popular', slugs: ['gmail'] },
      { id: 'communication', label: 'Communication', slugs: ['gmail'] },
    ]);
    expect(groups.map((group) => group.id)).toEqual(['popular', 'communication']);
  });
});

describe('CURATED_GROUPS', () => {
  test('files only real slugs, with no duplicates inside a group', () => {
    for (const group of CURATED_GROUPS) {
      expect(group.slugs.length).toBe(new Set(group.slugs).size);
      for (const slug of group.slugs) {
        expect(slug).toMatch(/^[a-z0-9_]+$/);
      }
    }
  });

  test('never files Slack, which ships as a built-in channel', () => {
    const all = CURATED_GROUPS.flatMap((group) => group.slugs);
    expect(all).not.toContain('slack');
    expect(all).not.toContain('slack_v2');
  });

  test('group ids are unique so the grid can key on them', () => {
    const ids = CURATED_GROUPS.map((group) => group.id);
    expect(ids.length).toBe(new Set(ids).size);
  });
});

describe('paging', () => {
  const items = Array.from({ length: 14 }, (_, index) => index);

  test('an empty list is still one page', () => {
    expect(pageCount(0)).toBe(1);
  });

  test('counts pages at the group page size', () => {
    expect(pageCount(items.length)).toBe(3);
    expect(GROUP_PAGE_SIZE).toBe(6);
  });

  test('slices the requested page', () => {
    expect(pageSlice(items, 0)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pageSlice(items, 2)).toEqual([12, 13]);
  });

  test('clamps out-of-range pages instead of blanking the group', () => {
    expect(pageSlice(items, 99)).toEqual([12, 13]);
    expect(pageSlice(items, -3)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('added is not connected', () => {
  test('an unauthorized connector is not reported as connected', () => {
    // It can call nothing until its credential is set, so it must not sit in
    // the Connected group, match the Connected pill, or wear the green tick.
    const [entry] = buildCatalogueEntries({
      connectors: [
        {
          slug: 'hubspot',
          name: 'HubSpot',
          provider: 'pipedream',
          status: 'ok',
          authSecret: 'HUBSPOT_TOKEN',
          secretSet: false,
          actions: [],
        } as unknown as CatalogueConnectedInput,
      ],
      apps: [],
    });
    expect(entry?.needsSetup).toBe(true);
    expect(entry?.connected).toBe(false);
  });

  test('an authorized connector is connected', () => {
    const [entry] = buildCatalogueEntries({
      connectors: [
        {
          slug: 'gmail',
          name: 'Gmail',
          provider: 'pipedream',
          status: 'ok',
          authSecret: 'GMAIL_TOKEN',
          secretSet: true,
          actions: [],
        } as unknown as CatalogueConnectedInput,
      ],
      apps: [],
    });
    expect(entry?.connected).toBe(true);
    expect(entry?.needsSetup).toBe(false);
  });
});
