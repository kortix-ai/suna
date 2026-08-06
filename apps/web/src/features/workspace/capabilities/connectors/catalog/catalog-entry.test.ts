import type { AdminConnector, DiscoverConnector, PipedreamApp } from '@kortix/sdk';
import { describe, expect, test } from 'bun:test';

import {
  catalogEntryFromDiscover,
  catalogEntryFromEasyConnect,
  catalogSections,
  connectedCatalogKeys,
  isCatalogEntryConnected,
  POPULAR_SECTION,
} from './catalog-entry';
import { CATEGORY_ROW_CAP } from './connector-categories';

const connector = (over: Partial<DiscoverConnector> = {}): DiscoverConnector =>
  ({
    id: 'int_1',
    kind: 'mcp',
    slug: 'linear',
    name: 'Linear',
    description: 'Issue tracking',
    url: null,
    icon: null,
    domain: 'linear.app',
    categories: ['productivity'],
    feeds: [],
    popularity: null,
    ...over,
  }) as DiscoverConnector;

const app = (over: Partial<PipedreamApp> = {}): PipedreamApp => ({
  slug: 'google_sheets',
  name: 'Google Sheets',
  description: 'Spreadsheets',
  imgSrc: null,
  authType: 'oauth',
  categories: ['productivity'],
  ...over,
});

const conn = (over: Partial<AdminConnector> = {}): AdminConnector =>
  ({
    slug: 'linear',
    name: 'Linear',
    provider: 'mcp',
    status: 'active',
    credentialMode: 'shared',
    authorizationStrategy: 'project',
    sensitive: false,
    actions: [],
    authSecret: null,
    secretSet: false,
    ...over,
  }) as AdminConnector;

describe('normalising the two catalogues', () => {
  test('a Discover entry keeps its rank and its raw connector', () => {
    const entry = catalogEntryFromDiscover(connector({ popularity: 42 }));
    expect(entry.source).toBe('discover');
    expect(entry.popularity).toBe(42);
    if (entry.source === 'discover') expect(entry.connector.id).toBe('int_1');
  });

  // Pipedream publishes no ranking. `null` keeps these out of the Popular
  // section entirely rather than sorting them to the bottom of it.
  test('an Easy Connect entry is unranked and maps imgSrc to icon', () => {
    const entry = catalogEntryFromEasyConnect(app({ imgSrc: 'https://x/i.png' }));
    expect(entry.source).toBe('easy-connect');
    expect(entry.popularity).toBeNull();
    expect(entry.icon).toBe('https://x/i.png');
  });

  // Both catalogues publish a `slack`. Un-prefixed keys would collide into one
  // React key the moment anything renders them in the same list.
  test('keys are namespaced by source so the two catalogues cannot collide', () => {
    expect(catalogEntryFromDiscover(connector({ id: 'slack', slug: 'slack' })).key).toBe(
      'discover:slack',
    );
    expect(catalogEntryFromEasyConnect(app({ slug: 'slack' })).key).toBe('easy-connect:slack');
  });
});

describe('connected join', () => {
  // The default add flow proposes a connection slug from the app's NAME, so a
  // catalogue slug of `google_sheets` becomes a connector slug of
  // `google-sheets`. Folding both sides is what makes that card show ✓.
  test('matches across slug spellings', () => {
    const keys = connectedCatalogKeys([conn({ slug: 'google-sheets', name: 'Google Sheets' })]);
    expect(isCatalogEntryConnected(catalogEntryFromEasyConnect(app()), keys)).toBe(true);
  });

  test('matches on the connector display name when the slug diverges', () => {
    const keys = connectedCatalogKeys([conn({ slug: 'my-tracker', name: 'Linear' })]);
    expect(isCatalogEntryConnected(catalogEntryFromDiscover(connector()), keys)).toBe(true);
  });

  test('an unrelated connector does not light up a catalogue card', () => {
    const keys = connectedCatalogKeys([conn({ slug: 'stripe', name: 'Stripe' })]);
    expect(isCatalogEntryConnected(catalogEntryFromDiscover(connector()), keys)).toBe(false);
  });

  // The documented ceiling of this join. It must degrade to a redundant `+`,
  // never to a wrong `✓` on some other app.
  test('a fully renamed connector falls back to + rather than matching wrongly', () => {
    const keys = connectedCatalogKeys([conn({ slug: 'tracker', name: 'Tracker' })]);
    expect(isCatalogEntryConnected(catalogEntryFromDiscover(connector()), keys)).toBe(false);
  });

  // A connector with a blank name must not index the empty string, or every
  // entry whose name folds to '' would match it.
  test('a nameless connector contributes no empty key', () => {
    expect(connectedCatalogKeys([conn({ slug: 'x', name: '   ' })]).has('')).toBe(false);
  });
});

describe('catalogSections', () => {
  const ranked = (slug: string, popularity: number, categories: string[]) =>
    catalogEntryFromDiscover(connector({ id: slug, slug, name: slug, popularity, categories }));

  test('Popular leads, ordered by descending rank and capped', () => {
    const sections = catalogSections(
      [ranked('a', 1, ['dev']), ranked('b', 9, ['dev']), ranked('c', 5, ['dev'])],
      { popularCap: 2 },
    );
    expect(sections[0]?.category).toBe(POPULAR_SECTION);
    expect(sections[0]?.items.map((i) => i.slug)).toEqual(['b', 'c']);
  });

  // An app is both popular and a developer tool. Removing it from Developer to
  // avoid repeating it would make that section lie about what it contains.
  test('a popular entry still appears in its real category', () => {
    const sections = catalogSections([ranked('b', 9, ['dev'])], { popularCap: 6 });
    expect(sections.map((s) => s.category)).toEqual([POPULAR_SECTION, 'dev']);
    expect(sections[1]?.items.map((i) => i.slug)).toEqual(['b']);
  });

  // Easy Connect ranks nothing, so it must produce no Popular heading at all
  // rather than an empty one.
  test('an unranked catalogue gets no Popular section', () => {
    const sections = catalogSections([catalogEntryFromEasyConnect(app())], { popularCap: 6 });
    expect(sections.some((s) => s.category === POPULAR_SECTION)).toBe(false);
  });

  test('an empty catalogue produces no sections', () => {
    expect(catalogSections([], { popularCap: 6 })).toEqual([]);
  });

  // `CategorySection` offers "View all" on `items.length > CATEGORY_ROW_CAP`
  // alone — there is no `category !== POPULAR_SECTION` special case any more,
  // and this is what makes dropping it safe rather than an oversight. Popular
  // is synthesised from a per-item rank, not published as a category, so
  // expanding it would mean expanding a bucket that has no more members to
  // load. Capping it at exactly the row cap means the button never appears.
  test('Popular never exceeds the row cap, so it never offers "View all"', () => {
    const many = Array.from({ length: CATEGORY_ROW_CAP * 3 }, (_, index) =>
      ranked(`app-${index}`, index, ['dev']),
    );
    const sections = catalogSections(many, { popularCap: CATEGORY_ROW_CAP });
    expect(sections[0]?.category).toBe(POPULAR_SECTION);
    expect(sections[0]?.items.length).toBe(CATEGORY_ROW_CAP);
  });
});
