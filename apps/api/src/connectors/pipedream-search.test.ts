import { describe, expect, test } from 'bun:test';

import {
  compareByProminence,
  filterByCategory,
  pageOf,
  rankApps,
  type CatalogApp,
} from './pipedream-search';

function app(overrides: Partial<CatalogApp> & { slug: string; name: string }): CatalogApp {
  return {
    description: null,
    imgSrc: null,
    authType: 'keys',
    categories: [],
    hasActions: true,
    hasTriggers: false,
    featuredWeight: 0,
    ...overrides,
  };
}

describe('rankApps', () => {
  // The live catalogue answers `q=notion` with cloudpress, notion,
  // notion_api_key — alphabetical, exact match second. This is that fixture.
  const notionCase = [
    app({
      slug: 'cloudpress',
      name: 'Cloudpress',
      description: 'Export documents from Google Docs and Notion to your CMS.',
    }),
    app({ slug: 'notion', name: 'Notion' }),
    app({ slug: 'notion_api_key', name: 'Notion (API Key)' }),
  ];

  test('puts the exact name match first, ahead of a description mention', () => {
    expect(rankApps(notionCase, 'notion').map((a) => a.slug)).toEqual([
      'notion',
      'notion_api_key',
      'cloudpress',
    ]);
  });

  test('a whole word in the name beats a name that merely starts with it', () => {
    // The live `q=SAP` case. Both names begin with "sap", and a tie-break on
    // name put Sapling first — so the acronym the user typed lost to a word
    // that happens to contain it. "SAP" is a standalone word in one and not in
    // the other, and that is the distinction that matters.
    const apps = [
      app({ slug: 'sapling_ai', name: 'Sapling.ai' }),
      app({ slug: 'sap_s_4hana_cloud', name: 'SAP S/4HANA Cloud' }),
      app({ slug: 'whatsapp_business', name: 'WhatsApp Business' }),
    ];
    expect(rankApps(apps, 'SAP').map((a) => a.slug)).toEqual([
      'sap_s_4hana_cloud',
      'sapling_ai',
      'whatsapp_business',
    ]);
  });

  test('ranks a name prefix above a slug substring above a description hit', () => {
    const apps = [
      app({ slug: 'zdesc', name: 'Zdesc', description: 'talks to github all day' }),
      app({ slug: 'a_github_mirror', name: 'Amirror' }),
      app({ slug: 'zgithubby', name: 'GitHubby' }),
    ];
    expect(rankApps(apps, 'github').map((a) => a.slug)).toEqual([
      'zgithubby',
      'a_github_mirror',
      'zdesc',
    ]);
  });

  test('matches a word inside the name above a plain substring', () => {
    const apps = [
      app({ slug: 'unsheets', name: 'Unsheets' }),
      app({ slug: 'google_sheets', name: 'Google Sheets' }),
    ];
    expect(rankApps(apps, 'sheets').map((a) => a.slug)).toEqual(['google_sheets', 'unsheets']);
  });

  test('a snake_case slug and a spaced name are the same query', () => {
    const apps = [app({ slug: 'google_sheets', name: 'Google Sheets' })];
    expect(rankApps(apps, 'google sheets')).toHaveLength(1);
    expect(rankApps(apps, 'google_sheets')).toHaveLength(1);
    expect(rankApps(apps, 'Google-Sheets')).toHaveLength(1);
  });

  test('excludes non-matches rather than ranking them last', () => {
    expect(rankApps(notionCase, 'salesforce')).toEqual([]);
  });

  test('a blank query is the browse path — everything, in resting order', () => {
    const apps = [
      app({ slug: 'b', name: 'B' }),
      app({ slug: 'a', name: 'A' }),
      app({ slug: 'promoted', name: 'Zebra', featuredWeight: 10 }),
    ];
    expect(rankApps(apps, '   ').map((a) => a.slug)).toEqual(['promoted', 'a', 'b']);
  });

  test('equal scores break on prominence, then name', () => {
    const apps = [
      app({ slug: 'x2', name: 'Slackish B' }),
      app({ slug: 'x1', name: 'Slackish A' }),
      app({ slug: 'x3', name: 'Slackish C', featuredWeight: 5 }),
    ];
    expect(rankApps(apps, 'slackish').map((a) => a.slug)).toEqual(['x3', 'x1', 'x2']);
  });

  test('does not mutate its input', () => {
    const apps = [app({ slug: 'b', name: 'B' }), app({ slug: 'a', name: 'A' })];
    rankApps(apps, '');
    expect(apps.map((a) => a.slug)).toEqual(['b', 'a']);
  });
});

describe('compareByProminence', () => {
  test('higher featured weight wins regardless of name', () => {
    const heavy = app({ slug: 'z', name: 'Zzz', featuredWeight: 1 });
    const light = app({ slug: 'a', name: 'Aaa', featuredWeight: 0 });
    expect([light, heavy].sort(compareByProminence).map((a) => a.slug)).toEqual(['z', 'a']);
  });
});

describe('filterByCategory', () => {
  test('keeps only apps claiming that exact category', () => {
    const apps = [
      app({ slug: 'a', name: 'A', categories: ['Marketing', 'CRM'] }),
      app({ slug: 'b', name: 'B', categories: ['CRM'] }),
      app({ slug: 'c', name: 'C', categories: [] }),
    ];
    expect(filterByCategory(apps, 'CRM').map((a) => a.slug)).toEqual(['a', 'b']);
    expect(filterByCategory(apps, 'Marketing').map((a) => a.slug)).toEqual(['a']);
    expect(filterByCategory(apps, 'Nope')).toEqual([]);
  });
});

describe('pageOf', () => {
  const items = Array.from({ length: 10 }, (_, i) => i);

  test('first page reports the full total and the next offset', () => {
    expect(pageOf(items, undefined, 4)).toEqual({
      items: [0, 1, 2, 3],
      total: 10,
      nextCursor: '4',
      hasMore: true,
    });
  });

  test('walks to the end and stops', () => {
    expect(pageOf(items, '8', 4)).toEqual({ items: [8, 9], total: 10, hasMore: false });
  });

  test('an exact-boundary page reports no more', () => {
    expect(pageOf(items, '5', 5)).toEqual({ items: [5, 6, 7, 8, 9], total: 10, hasMore: false });
  });

  test('a garbage or negative cursor reads as the first page', () => {
    expect(pageOf(items, 'not-a-number', 2).items).toEqual([0, 1]);
    expect(pageOf(items, '-5', 2).items).toEqual([0, 1]);
  });

  test('a cursor past the end yields nothing rather than throwing', () => {
    expect(pageOf(items, '99', 4)).toEqual({ items: [], total: 10, hasMore: false });
  });
});
