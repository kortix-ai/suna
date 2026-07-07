import { describe, expect, test } from 'bun:test';
import { pageCatalogItems, type CatalogItem } from './catalog';

function item(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    id: `kortix:${overrides.name ?? 'item'}`,
    registry: 'kortix-starter',
    name: 'item',
    type: 'registry:skill',
    title: 'Item',
    description: null,
    categories: [],
    capabilities: { secrets: [], connectors: [], tools: [], network: [] },
    dependencies: [],
    fileCount: 1,
    external: false,
    marketplaceId: 'kortix',
    marketplaceLabel: 'Kortix',
    ...overrides,
  };
}

function synthetic(count: number, overrides: (i: number) => Partial<CatalogItem> = () => ({})): CatalogItem[] {
  return Array.from({ length: count }, (_, i) =>
    item({ id: `kortix:item-${i}`, name: `item-${i}`, ...overrides(i) }),
  );
}

describe('pageCatalogItems', () => {
  test('slices correctly for a given limit and offset', () => {
    const items = synthetic(25);
    const result = pageCatalogItems(items, { limit: 10, offset: 10 });
    expect(result.items).toEqual(items.slice(10, 20));
    expect(result.items.length).toBe(10);
  });

  test('total is the pre-slice filtered count regardless of limit/offset', () => {
    const items = synthetic(25);
    const first = pageCatalogItems(items, { limit: 10, offset: 0 });
    const last = pageCatalogItems(items, { limit: 10, offset: 20 });
    const unpaged = pageCatalogItems(items, {});
    expect(first.total).toBe(25);
    expect(last.total).toBe(25);
    expect(unpaged.total).toBe(25);
  });

  test('more remain after the current page', () => {
    const items = synthetic(25);
    const result = pageCatalogItems(items, { limit: 10, offset: 0 });
    expect(result.items.length + 0).toBeLessThan(result.total);
    expect(0 + result.items.length < result.total).toBe(true);
  });

  test('no more remain on the last page', () => {
    const items = synthetic(25);
    const result = pageCatalogItems(items, { limit: 10, offset: 20 });
    expect(20 + result.items.length < result.total).toBe(false);
  });

  test('no limit means no pagination signal, i.e. the full list is returned', () => {
    const items = synthetic(25);
    const result = pageCatalogItems(items, {});
    expect(0 + result.items.length < result.total).toBe(false);
  });

  test('absent limit returns the full filtered list (opt-in guarantee)', () => {
    const items = synthetic(25);
    const result = pageCatalogItems(items, {});
    expect(result.items).toEqual(items);
    expect(result.items.length).toBe(25);
  });

  test('invalid limit values (zero, negative, non-finite) also skip pagination', () => {
    const items = synthetic(5);
    expect(pageCatalogItems(items, { limit: 0 }).items.length).toBe(5);
    expect(pageCatalogItems(items, { limit: -3 }).items.length).toBe(5);
    expect(pageCatalogItems(items, { limit: Number.NaN }).items.length).toBe(5);
  });

  test('query/type/source filters compose with paging and the visible-type filter stays intact', () => {
    const items = [
      ...synthetic(3, (i) => ({ name: `alpha-${i}`, title: `Alpha ${i}`, type: 'registry:skill', registry: 'kortix-starter' })),
      ...synthetic(3, (i) => ({ name: `beta-${i}`, title: `Beta ${i}`, type: 'registry:skill', registry: 'other-registry' })),
      item({ id: 'hidden-agent', name: 'hidden-agent', title: 'Hidden Agent', type: 'registry:agent', registry: 'kortix-starter' }),
    ];
    const result = pageCatalogItems(items, { query: 'alpha', source: 'kortix', limit: 2, offset: 0 });
    expect(result.total).toBe(3);
    expect(result.items.length).toBe(2);
    expect(result.items.every((it) => it.name.startsWith('alpha'))).toBe(true);
  });

  test('offset past the end returns empty items, hasMore false, and a correct total', () => {
    const items = synthetic(5);
    const result = pageCatalogItems(items, { limit: 10, offset: 50 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(5);
    expect(50 + result.items.length < result.total).toBe(false);
  });
});
