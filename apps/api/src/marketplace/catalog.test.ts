import { describe, expect, test } from 'bun:test';
import { clampMarketplaceItemsLimit, pageCatalogItems, type CatalogItem } from './catalog';

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
      item({ id: 'hidden-tool', name: 'hidden-tool', title: 'Hidden Tool', type: 'registry:tool', registry: 'kortix-starter' }),
    ];
    const result = pageCatalogItems(items, { query: 'alpha', source: 'kortix', limit: 2, offset: 0 });
    expect(result.total).toBe(3);
    expect(result.items.length).toBe(2);
    expect(result.items.every((it) => it.name.startsWith('alpha'))).toBe(true);
  });

  test('surfaces skills, agents, commands, and bundles as browseable; hides support types', () => {
    const items = [
      item({ id: 'k:skill', name: 'a-skill', type: 'registry:skill' }),
      item({ id: 'k:agent', name: 'a-agent', type: 'registry:agent' }),
      item({ id: 'k:command', name: 'a-command', type: 'registry:command' }),
      item({ id: 'k:bundle', name: 'a-bundle', type: 'registry:bundle' }),
      item({ id: 'k:tool', name: 'a-tool', type: 'registry:tool' }),
      item({ id: 'k:rules', name: 'a-rules', type: 'registry:rules' }),
    ];
    const result = pageCatalogItems(items, {});
    const visible = new Set(result.items.map((it) => it.type));
    expect(visible).toEqual(
      new Set(['registry:skill', 'registry:agent', 'registry:command', 'registry:bundle']),
    );
    expect(result.total).toBe(4);
  });

  test('offset past the end returns empty items, hasMore false, and a correct total', () => {
    const items = synthetic(5);
    const result = pageCatalogItems(items, { limit: 10, offset: 50 });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(5);
    expect(50 + result.items.length < result.total).toBe(false);
  });
});

describe('clampMarketplaceItemsLimit', () => {
  test('passes an in-range limit through unchanged', () => {
    expect(clampMarketplaceItemsLimit(30)).toBe(30);
  });

  test('passes the explore-landing limit (120) through unchanged', () => {
    expect(clampMarketplaceItemsLimit(120)).toBe(120);
  });

  test('passes the ceiling itself (200) through unchanged', () => {
    expect(clampMarketplaceItemsLimit(200)).toBe(200);
  });

  test('clamps a limit above 200 down to 200', () => {
    expect(clampMarketplaceItemsLimit(201)).toBe(200);
    expect(clampMarketplaceItemsLimit(5000)).toBe(200);
  });

  test('clamps a non-positive limit up to 1', () => {
    expect(clampMarketplaceItemsLimit(0)).toBe(1);
    expect(clampMarketplaceItemsLimit(-3)).toBe(1);
  });
});
