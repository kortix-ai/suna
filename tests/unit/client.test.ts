import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANON, Client } from '../src/core/client';

describe('black-box HTTP client base paths', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('preserves a gateway path prefix across identity clones', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ status: 'healthy' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchImpl);

    await new Client('https://preview.example/_gateway').as(ANON).get('/health');

    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://preview.example/_gateway/health'),
      expect.any(Object),
    );
  });

  it('keeps API route templates rooted at the origin', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchImpl);

    const client = new Client('https://api.example/v1');
    await client.get('/v1/health');
    await client.get('/scim/v2/accounts/example/ServiceProviderConfig');

    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.example/v1/health',
      'https://api.example/scim/v2/accounts/example/ServiceProviderConfig',
    ]);
  });
});
