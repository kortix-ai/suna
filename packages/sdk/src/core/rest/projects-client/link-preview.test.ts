import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { configureKortix } from '../../http/config';
import { getLinkPreview } from './artifacts';

describe('getLinkPreview', () => {
  const originalFetch = globalThis.fetch;
  let seen: string | null = null;

  beforeEach(() => {
    seen = null;
    configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen = String(input instanceof Request ? input.url : input);
      return new Response(
        JSON.stringify({ url: 'https://example.com/a?b=1', title: 'Art', description: 'Paintings', site_name: null, image_url: null }),
        { headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('reads the project route with the URL encoded, and returns the page', async () => {
    const page = await getLinkPreview('p1', 'https://example.com/a?b=1');
    expect(seen).toBe('http://test.local/projects/p1/link-preview?url=https%3A%2F%2Fexample.com%2Fa%3Fb%3D1');
    expect(page).toEqual({ url: 'https://example.com/a?b=1', title: 'Art', description: 'Paintings', site_name: null, image_url: null });
  });
});
