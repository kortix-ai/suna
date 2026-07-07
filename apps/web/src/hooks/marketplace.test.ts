import { describe, expect, test } from 'bun:test';

import { nextMarketplaceItemsPageParam } from './marketplace';
import type { ItemsPage, MarketplaceItem } from '@/lib/marketplace-client';

function page(overrides: Partial<ItemsPage> = {}): ItemsPage {
  return {
    items: [],
    total: 0,
    hasMore: false,
    loading: false,
    pending: 0,
    sources: [],
    ...overrides,
  };
}

function itemsWithIds(ids: string[]): MarketplaceItem[] {
  return ids.map((id) => ({ id }) as unknown as MarketplaceItem);
}

describe('nextMarketplaceItemsPageParam', () => {
  test('advances the offset by limit when the last page has more', () => {
    const lastPage = page({ hasMore: true });

    expect(nextMarketplaceItemsPageParam(lastPage, [lastPage], 30)).toBe(30);
  });

  test('advances by limit * number of pages already fetched', () => {
    const lastPage = page({ hasMore: true });

    expect(nextMarketplaceItemsPageParam(lastPage, [lastPage, lastPage, lastPage], 30)).toBe(90);
  });

  test('returns undefined when the last page reports no more items', () => {
    const lastPage = page({ hasMore: false });

    expect(nextMarketplaceItemsPageParam(lastPage, [lastPage], 30)).toBeUndefined();
  });

  test('flattens items across pages in order', () => {
    const pages: ItemsPage[] = [
      page({ items: itemsWithIds(['a', 'b']) }),
      page({ items: itemsWithIds(['c', 'd']) }),
    ];

    expect(pages.flatMap((p) => p.items).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
  });
});
