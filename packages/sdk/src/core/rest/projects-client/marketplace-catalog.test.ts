import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import {
  addMarketplaceSource,
  getMarketplaceCatalogItem,
  getMarketplaceCatalogItemFile,
  listFeaturedMarketplaces,
  listMarketplaceCatalogItems,
  listMarketplaceSources,
  listMarketplaces,
  removeMarketplaceSource,
} from './marketplace-catalog';

let calls: { url: string; method: string; body: unknown }[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

beforeEach(() => {
  calls = [];
  nextResponse = { status: 200, body: {} };
  globalThis.fetch = mock(async (url: unknown, opts: { method?: string; body?: string } = {}) => {
    calls.push({
      url: String(url),
      method: opts.method ?? 'GET',
      body: opts.body ? JSON.parse(opts.body) : undefined,
    });
    return new Response(JSON.stringify(nextResponse.body), {
      status: nextResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
});

configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
const last = () => calls[calls.length - 1];

test('listMarketplaceCatalogItems builds the query string from query/type/source', async () => {
  nextResponse = { status: 200, body: { items: [] } };
  await listMarketplaceCatalogItems({ query: 'slack', type: 'agent', source: 'kortix' });
  expect(last().url).toContain('/marketplace/items?');
  expect(last().url).toContain('query=slack');
  expect(last().url).toContain('type=agent');
  expect(last().url).toContain('source=kortix');
});

test('listMarketplaceCatalogItems omits the query string when no options given', async () => {
  nextResponse = { status: 200, body: { items: [] } };
  await listMarketplaceCatalogItems();
  expect(last().url).toBe('http://test.local/marketplace/items');
});

test('listMarketplaces and listFeaturedMarketplaces hit their own endpoints', async () => {
  nextResponse = { status: 200, body: { marketplaces: [] } };
  await listMarketplaces();
  expect(last().url).toContain('/marketplace/marketplaces');

  nextResponse = { status: 200, body: { featured: [] } };
  await listFeaturedMarketplaces();
  expect(last().url).toContain('/marketplace/marketplaces/featured');
});

test('getMarketplaceCatalogItem and getMarketplaceCatalogItemFile hit item-scoped endpoints', async () => {
  nextResponse = { status: 200, body: { id: 'kortix:researcher', title: 'Researcher' } };
  await getMarketplaceCatalogItem('kortix:researcher');
  expect(last().url).toContain('/marketplace/items/kortix%3Aresearcher');

  nextResponse = { status: 200, body: { path: 'agent.md', content: '# hi' } };
  await getMarketplaceCatalogItemFile('kortix:researcher', 'agent.md');
  expect(last().url).toContain('/marketplace/items/kortix%3Aresearcher/file?path=agent.md');
});

test('getMarketplaceCatalogItem throws with "Item not found" on a 404', async () => {
  nextResponse = { status: 404, body: {} };
  await expect(getMarketplaceCatalogItem('missing')).rejects.toThrow();
});

test('marketplace sources: list/add/remove', async () => {
  nextResponse = { status: 200, body: { sources: [] } };
  await listMarketplaceSources();
  expect(last().url).toContain('/marketplace/sources');
  expect(last().method).toBe('GET');

  nextResponse = { status: 200, body: { source: { id: 'SRC1', address: 'https://github.com/acme/registry' } } };
  const added = await addMarketplaceSource({ address: 'https://github.com/acme/registry' });
  expect(last().url).toContain('/marketplace/sources');
  expect(last().method).toBe('POST');
  expect(last().body).toMatchObject({ address: 'https://github.com/acme/registry' });
  expect(added.source.id).toBe('SRC1');

  nextResponse = { status: 200, body: { ok: true } };
  await removeMarketplaceSource('SRC1');
  expect(last().url).toContain('/marketplace/sources/SRC1');
  expect(last().method).toBe('DELETE');
});
