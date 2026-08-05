import { describe, expect, test } from 'bun:test';

import { catalogSections } from './catalog-entry';
import { CATALOG_PREFETCH_PAGES, shouldPrefetchMorePages } from './catalog-prefetch';
import {
  CATEGORY_PICKS,
  CURATED_SECTIONS,
  PICKED_SECTION_KEYS,
  UNPINNED_RANK,
  pinRank,
  sortByPicks,
} from './connector-picks';

const app = (slug: string, name = slug) => ({ slug, name });

describe('pinRank', () => {
  test('a pick ranks by its position in the list', () => {
    expect(pinRank('productivity', app('notion'))).toBe(0);
    expect(pinRank('productivity', app('googledrive'))).toBeGreaterThan(0);
  });

  test('matches either spelling the two catalogues use', () => {
    // Easy Connect ships `google_sheets` as a slug; the Discover feed can ship
    // an opaque id and carry the readable string in the name.
    expect(pinRank('productivity', app('google_sheets'))).toBe(
      pinRank('productivity', app('x9f2', 'Google Sheets')),
    );
    expect(pinRank('productivity', app('google-sheets'))).not.toBe(UNPINNED_RANK);
  });

  test('an app nobody picked sorts last', () => {
    expect(pinRank('productivity', app('some-obscure-tool'))).toBe(UNPINNED_RANK);
  });

  test('a section with no picks pins nothing', () => {
    expect(pinRank('life-sciences', app('notion'))).toBe(UNPINNED_RANK);
  });
});

describe('sortByPicks', () => {
  test('picks lead, in pick order', () => {
    const sorted = sortByPicks('productivity', [
      app('zzz-unknown'),
      app('trello'),
      app('notion'),
    ]).map((a) => a.slug);
    expect(sorted[0]).toBe('notion');
    expect(sorted[1]).toBe('trello');
    expect(sorted[2]).toBe('zzz-unknown');
  });

  // The whole point of a stable sort here. Re-ordering the unpicked would
  // replace the feed's order with no order at all.
  test('feed order survives among everything unpicked', () => {
    const sorted = sortByPicks('productivity', [
      app('unknown-a'),
      app('unknown-b'),
      app('unknown-c'),
    ]).map((a) => a.slug);
    expect(sorted).toEqual(['unknown-a', 'unknown-b', 'unknown-c']);
  });

  test('a section with no picks is returned untouched', () => {
    const items = [app('b'), app('a'), app('c')];
    expect(sortByPicks('life-sciences', items).map((i) => i.slug)).toEqual(['b', 'a', 'c']);
  });

  test('never drops or duplicates an item', () => {
    const items = [app('notion'), app('unknown'), app('trello'), app('notion')];
    expect(sortByPicks('productivity', items)).toHaveLength(items.length);
  });
});

/**
 * The list is written from product knowledge, not from a catalogue dump, so
 * these are the invariants that keep a wrong guess cheap: a bad token is inert,
 * and a bad KEY is a test failure rather than a silently dead list.
 */
describe('CATEGORY_PICKS hygiene', () => {
  test('every key is a real curated section', () => {
    const sections = new Set(CURATED_SECTIONS.map((s) => s.key));
    for (const key of PICKED_SECTION_KEYS) expect(sections.has(key)).toBe(true);
  });

  test('every token is already folded', () => {
    // Lookups fold before comparing, so `google_sheets` here could never match.
    for (const [, picks] of Object.entries(CATEGORY_PICKS)) {
      for (const token of picks) expect(token).toMatch(/^[a-z0-9]+$/);
    }
  });

  test('no token is repeated inside a category', () => {
    for (const [key, picks] of Object.entries(CATEGORY_PICKS)) {
      expect(new Set(picks).size, `duplicate pick in ${key}`).toBe(picks.length);
    }
  });

  test('the sections a newcomer meets first all carry picks', () => {
    // Productivity leads the page; developer tools is last but is the one a
    // technical user checks. An empty list in either is the failure this
    // whole change exists to fix.
    expect(CATEGORY_PICKS.productivity?.length ?? 0).toBeGreaterThan(6);
    expect(CATEGORY_PICKS['developer-tools']?.length ?? 0).toBeGreaterThan(6);
  });
});

describe('catalogSections applies picks', () => {
  const entry = (slug: string, categories: string[]) =>
    ({ slug, name: slug, categories, popularity: null }) as never;

  test('a section leads with its picks, not with feed order', () => {
    const sections = catalogSections(
      [
        entry('zzz-unknown', ['productivity']),
        entry('trello', ['productivity']),
        entry('notion', ['productivity']),
      ],
      { popularCap: 6 },
    );
    expect(sections[0]?.items.map((i) => i.slug)).toEqual(['notion', 'trello', 'zzz-unknown']);
  });
});

describe('shouldPrefetchMorePages', () => {
  const base = { loadedPages: 1, maxPages: 4, hasNextPage: true, isFetchingNextPage: false };

  test('pulls the next page once the first has landed', () => {
    expect(shouldPrefetchMorePages(base)).toBe(true);
  });

  // react-query reports hasNextPage false while a fresh infinite query is
  // pending, which is indistinguishable from an exhausted one — firing here
  // would race a second request against the same cursor.
  test('never fires before the first page lands', () => {
    expect(shouldPrefetchMorePages({ ...base, loadedPages: 0 })).toBe(false);
  });

  test('stops at the cap', () => {
    expect(shouldPrefetchMorePages({ ...base, loadedPages: 4 })).toBe(false);
    expect(shouldPrefetchMorePages({ ...base, loadedPages: 3 })).toBe(true);
  });

  test('stops at the end of the catalogue', () => {
    expect(shouldPrefetchMorePages({ ...base, hasNextPage: false })).toBe(false);
  });

  test('never doubles up on a request already in flight', () => {
    expect(shouldPrefetchMorePages({ ...base, isFetchingNextPage: true })).toBe(false);
  });

  test('the cap is more than one page, or this change does nothing', () => {
    expect(CATALOG_PREFETCH_PAGES).toBeGreaterThan(1);
  });
});
