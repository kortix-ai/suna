import { describe, expect, test } from 'bun:test';

import type { MarketplaceItem } from '@/lib/marketplace-client';
import {
  buildMarketplaceGridRows,
  flattenMarketplaceItems,
  MARKETPLACE_GRID_COLUMNS,
  marketplaceGridRowKey,
  shouldFetchNextMarketplacePage,
  shouldVirtualizeMarketplacePagedGrid,
} from './marketplace-grid';

function makeItems(type: string, ids: string[]): MarketplaceItem[] {
  return ids.map((id) => ({ id, type, name: id, title: id }) as unknown as MarketplaceItem);
}

describe('buildMarketplaceGridRows', () => {
  test('flat mode chunks items into rows of the column size with no headers', () => {
    const items = makeItems('registry:skill', ['a', 'b', 'c', 'd']);

    const rows = buildMarketplaceGridRows({ items });

    expect(rows).toEqual([
      { kind: 'items', items: items.slice(0, 3) },
      { kind: 'items', items: items.slice(3) },
    ]);
  });

  test('for a large dataset, row count is far smaller than item count', () => {
    const items = makeItems(
      'registry:skill',
      Array.from({ length: 3000 }, (_, i) => `item-${i}`),
    );

    const rows = buildMarketplaceGridRows({ items });

    expect(rows.length).toBe(Math.ceil(items.length / MARKETPLACE_GRID_COLUMNS));
    expect(rows.length).toBeLessThan(items.length / 2);
  });

  test('an empty item list produces no rows', () => {
    expect(buildMarketplaceGridRows({ items: [] })).toEqual([]);
  });
});

describe('flattenMarketplaceItems', () => {
  test('concatenates pages in order when no ids repeat', () => {
    const pageA = makeItems('registry:skill', ['a', 'b']);
    const pageB = makeItems('registry:skill', ['c', 'd']);

    const result = flattenMarketplaceItems([{ items: pageA }, { items: pageB }]);

    expect(result.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('drops later duplicates by id, keeping the first occurrence', () => {
    const pageA = makeItems('registry:skill', ['a', 'b']);
    const pageB = makeItems('registry:skill', ['b', 'c']);

    const result = flattenMarketplaceItems([{ items: pageA }, { items: pageB }]);

    expect(result.map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(result[1]).toBe(pageA[1]);
  });

  test('an empty page list produces no items', () => {
    expect(flattenMarketplaceItems([])).toEqual([]);
  });

  test('a single page passes through unchanged', () => {
    const page = makeItems('registry:skill', ['a', 'b', 'c']);

    const result = flattenMarketplaceItems([{ items: page }]);

    expect(result).toEqual(page);
  });
});

describe('marketplaceGridRowKey', () => {
  test('item rows key off their member ids, independent of index', () => {
    const items = makeItems('registry:skill', ['a', 'b']);
    const row = { kind: 'items', items } as const;

    expect(marketplaceGridRowKey(row, 5)).toBe('items:a,b');
    expect(marketplaceGridRowKey(row, 9)).toBe('items:a,b');
  });
});

describe('shouldFetchNextMarketplacePage', () => {
  test('fetches when intersecting, a next page exists, and nothing is in flight', () => {
    const result = shouldFetchNextMarketplacePage(true, {
      hasNextPage: true,
      isFetchingNextPage: false,
    });

    expect(result).toBe(true);
  });

  test('does not fetch when the sentinel is not intersecting', () => {
    const result = shouldFetchNextMarketplacePage(false, {
      hasNextPage: true,
      isFetchingNextPage: false,
    });

    expect(result).toBe(false);
  });

  test('does not fetch when there is no next page', () => {
    const result = shouldFetchNextMarketplacePage(true, {
      hasNextPage: false,
      isFetchingNextPage: false,
    });

    expect(result).toBe(false);
  });

  test('does not fetch when a fetch is already in flight', () => {
    const result = shouldFetchNextMarketplacePage(true, {
      hasNextPage: true,
      isFetchingNextPage: true,
    });

    expect(result).toBe(false);
  });
});

describe('company explore paged grid bounding (A4)', () => {
  test('a large source renders a bounded row window at the company page column count', () => {
    const items = Array.from(
      { length: 4000 },
      (_, i) => ({ id: `item-${i}`, type: 'registry:skill' }) as unknown as MarketplaceItem,
    );

    const rows = buildMarketplaceGridRows({ items, columns: 2 });

    expect(rows.length).toBe(Math.ceil(items.length / 2));
    expect(rows.length).toBeLessThan(items.length);
  });
});

describe('shouldVirtualizeMarketplacePagedGrid', () => {
  test('a single loaded page (the SSR/first-hydration state) stays unvirtualized', () => {
    expect(shouldVirtualizeMarketplacePagedGrid(1)).toBe(false);
  });

  test('no page loaded yet stays unvirtualized', () => {
    expect(shouldVirtualizeMarketplacePagedGrid(0)).toBe(false);
  });

  test('a large source that has fetched multiple pages switches to the windowed render', () => {
    expect(shouldVirtualizeMarketplacePagedGrid(2)).toBe(true);
    expect(shouldVirtualizeMarketplacePagedGrid(50)).toBe(true);
  });
});
