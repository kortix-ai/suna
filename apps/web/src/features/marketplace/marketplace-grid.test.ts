import { describe, expect, test } from 'bun:test';

import {
  buildMarketplaceGridRows,
  flattenMarketplaceItems,
  MARKETPLACE_GRID_COLUMNS,
  marketplaceGridRowKey,
  resolveMarketplaceTypeSectionTotal,
  shouldFetchNextMarketplacePage,
  shouldVirtualizeMarketplacePagedGrid,
  sumMarketplaceTypeCounts,
} from './marketplace-grid';
import type { MarketplaceItem } from '@/lib/marketplace-client';

function makeItems(type: string, ids: string[]): MarketplaceItem[] {
  return ids.map((id) => ({ id, type, name: id, title: id }) as unknown as MarketplaceItem);
}

describe('buildMarketplaceGridRows', () => {
  test('flat mode chunks items into rows of the column size with no headers', () => {
    const items = makeItems('registry:skill', ['a', 'b', 'c', 'd']);

    const rows = buildMarketplaceGridRows({ items, grouped: false });

    expect(rows).toEqual([
      { kind: 'items', items: items.slice(0, 3) },
      { kind: 'items', items: items.slice(3) },
    ]);
  });

  test('grouped mode inserts one header row per type section before its item chunks', () => {
    const skills = makeItems('registry:skill', ['s1', 's2']);
    const other = makeItems('registry:unknown', ['o1']);

    const rows = buildMarketplaceGridRows({ items: [...skills, ...other], grouped: true });

    expect(rows).toEqual([
      { kind: 'header', label: 'Skills', count: 2 },
      { kind: 'items', items: skills },
      { kind: 'header', label: 'Other', count: 1 },
      { kind: 'items', items: other },
    ]);
  });

  test('groups skills, agents, commands, and bundles into their own sections in taxonomy order', () => {
    // Interleaved + out of section order on input; grouping must sort into the
    // TYPE_SECTIONS order regardless.
    const rows = buildMarketplaceGridRows({
      items: [
        ...makeItems('registry:command', ['c1']),
        ...makeItems('registry:bundle', ['b1']),
        ...makeItems('registry:skill', ['s1', 's2']),
        ...makeItems('registry:agent', ['a1']),
      ],
      grouped: true,
    });

    const headers = rows.flatMap((r) => (r.kind === 'header' ? [r.label] : []));
    expect(headers).toEqual(['Skills', 'Agents', 'Commands', 'Bundles']);
  });

  test('for a large dataset, row count is far smaller than item count', () => {
    const items = makeItems(
      'registry:skill',
      Array.from({ length: 3000 }, (_, i) => `item-${i}`),
    );

    const rows = buildMarketplaceGridRows({ items, grouped: false });

    expect(rows.length).toBe(Math.ceil(items.length / MARKETPLACE_GRID_COLUMNS));
    expect(rows.length).toBeLessThan(items.length / 2);
  });

  test('an empty item list produces no rows', () => {
    expect(buildMarketplaceGridRows({ items: [], grouped: true })).toEqual([]);
    expect(buildMarketplaceGridRows({ items: [], grouped: false })).toEqual([]);
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
  test('header rows key off their label', () => {
    const row = { kind: 'header', label: 'Skills', count: 3 } as const;

    expect(marketplaceGridRowKey(row, 0)).toBe('header:Skills');
  });

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

describe('sumMarketplaceTypeCounts', () => {
  test('sums per-type counts across every marketplace summary', () => {
    const marketplaces: { types: Record<string, number> }[] = [
      { types: { skill: 3, agent: 1 } },
      { types: { skill: 2 } },
    ];

    expect(sumMarketplaceTypeCounts(marketplaces)).toEqual({ skill: 5, agent: 1 });
  });

  test('an empty marketplace list produces no counts', () => {
    expect(sumMarketplaceTypeCounts([])).toEqual({});
  });

  test('a marketplace with no types map contributes nothing', () => {
    expect(sumMarketplaceTypeCounts([{}])).toEqual({});
  });
});

describe('resolveMarketplaceTypeSectionTotal', () => {
  test('strips the registry: prefix to match the summary counts', () => {
    const total = resolveMarketplaceTypeSectionTotal('registry:skill', { skill: 42 }, 9);

    expect(total).toBe(42);
  });

  test('falls back to the SSR-bounded local count when the type is absent from the summary', () => {
    const total = resolveMarketplaceTypeSectionTotal('registry:agent', { skill: 42 }, 9);

    expect(total).toBe(9);
  });

  test('a large true total (beyond the bounded page) is reported, not the local preview count', () => {
    const total = resolveMarketplaceTypeSectionTotal('registry:skill', { skill: 500 }, 9);

    expect(total).toBe(500);
  });
});

describe('company explore paged grid bounding (A4)', () => {
  test('a large source renders a bounded row window at the company page column count', () => {
    const items = Array.from(
      { length: 4000 },
      (_, i) => ({ id: `item-${i}`, type: 'registry:skill' }) as unknown as MarketplaceItem,
    );

    const rows = buildMarketplaceGridRows({ items, grouped: false, columns: 2 });

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
