import { beforeEach, describe, expect, mock, test } from 'bun:test';

describe('loadMarketplaceExploreData', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('requests a bounded limit for the landing page, not the full catalog', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes('/marketplace/items')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ marketplaces: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { loadMarketplaceExploreData, MARKETPLACE_EXPLORE_LANDING_LIMIT } = await import(
      './marketplace-public'
    );

    await loadMarketplaceExploreData();

    const itemsCall = calls.find((c) => c.includes('/marketplace/items'));
    expect(itemsCall).toContain(`limit=${MARKETPLACE_EXPLORE_LANDING_LIMIT}`);
  });

  test('falls back to an empty page when the fetch fails, instead of throwing', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const { loadMarketplaceExploreData } = await import('./marketplace-public');

    const { itemsPage, marketplacesPage } = await loadMarketplaceExploreData();

    expect(itemsPage.items).toEqual([]);
    expect(marketplacesPage.marketplaces).toEqual([]);
  });
});

describe('loadMarketplaceCompanyData', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('requests a bounded limit scoped to the source, not the full catalog', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      calls.push(String(url));
      if (String(url).includes('/marketplace/items')) {
        return new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ marketplaces: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { loadMarketplaceCompanyData, MARKETPLACE_COMPANY_PAGE_LIMIT } = await import(
      './marketplace-public'
    );

    await loadMarketplaceCompanyData('kortix');

    const itemsCall = calls.find((c) => c.includes('/marketplace/items'));
    expect(itemsCall).toContain(`limit=${MARKETPLACE_COMPANY_PAGE_LIMIT}`);
    expect(itemsCall).toContain('source=kortix');
  });

  test('falls back to an empty page when the fetch fails, instead of throwing', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const { loadMarketplaceCompanyData } = await import('./marketplace-public');

    const { itemsPage, marketplacesPage } = await loadMarketplaceCompanyData('kortix');

    expect(itemsPage.items).toEqual([]);
    expect(marketplacesPage.marketplaces).toEqual([]);
  });
});
