import { describe, expect, test } from 'bun:test';

import {
  buildMarketplaceGridRows,
  MARKETPLACE_GRID_COLUMNS,
  marketplaceGridRowKey,
  resolveEffectiveMarketplaceType,
  resolveMarketplaceQueryParams,
  shouldFetchNextMarketplacePage,
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

describe('resolveEffectiveMarketplaceType', () => {
  test('keeps the selected type when it is a valid option', () => {
    expect(resolveEffectiveMarketplaceType('skill', [{ value: 'all' }, { value: 'skill' }])).toBe(
      'skill',
    );
  });

  test('falls back to all when the selected type is no longer an option', () => {
    expect(resolveEffectiveMarketplaceType('agent', [{ value: 'all' }, { value: 'skill' }])).toBe(
      'all',
    );
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

describe('resolveMarketplaceQueryParams', () => {
  test('maps control state into query params', () => {
    const params = resolveMarketplaceQueryParams({
      debounced: 'agent',
      effectiveType: 'skill',
      source: 'src-1',
      publicOnly: true,
    });

    expect(params).toEqual({ query: 'agent', type: 'skill', source: 'src-1', publicOnly: true });
  });

  test('different search/type/source controls produce different params', () => {
    const base = { debounced: '', effectiveType: 'all', source: 'all', publicOnly: false };

    const bySearch = resolveMarketplaceQueryParams({ ...base, debounced: 'notion' });
    const byType = resolveMarketplaceQueryParams({ ...base, effectiveType: 'skill' });
    const bySource = resolveMarketplaceQueryParams({ ...base, source: 'src-1' });
    const baseline = resolveMarketplaceQueryParams(base);

    expect(bySearch).not.toEqual(baseline);
    expect(byType).not.toEqual(baseline);
    expect(bySource).not.toEqual(baseline);
  });
});
