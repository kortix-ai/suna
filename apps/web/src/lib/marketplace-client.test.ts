import { beforeEach, describe, expect, mock, test } from 'bun:test';

describe('listPublicMarketplaceItems', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('omits limit/offset from the query string when not passed', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { listPublicMarketplaceItems } = await import('./marketplace-public');

    await listPublicMarketplaceItems({ type: 'skill' });

    expect(calls[0]).toContain('/v1/marketplace/items?type=skill');
    expect(calls[0]).not.toContain('limit');
    expect(calls[0]).not.toContain('offset');
  });

  test('includes limit/offset in the query string when passed', async () => {
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { listPublicMarketplaceItems } = await import('./marketplace-public');

    await listPublicMarketplaceItems({ limit: 30, offset: 30 });

    expect(calls[0]).toContain('limit=30');
    expect(calls[0]).toContain('offset=30');
  });

  test('defaults total/hasMore when the server omits them', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { listPublicMarketplaceItems } = await import('./marketplace-public');

    const page = await listPublicMarketplaceItems();

    expect(page.total).toBe(3);
    expect(page.hasMore).toBe(false);
  });

  test('passes through server-reported total and hasMore', async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ items: [{ id: 'a' }], total: 12, hasMore: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    const { listPublicMarketplaceItems } = await import('./marketplace-public');

    const page = await listPublicMarketplaceItems({ limit: 1, offset: 0 });

    expect(page.total).toBe(12);
    expect(page.hasMore).toBe(true);
  });
});
