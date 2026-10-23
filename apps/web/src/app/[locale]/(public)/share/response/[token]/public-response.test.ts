import { afterEach, expect, mock, test } from 'bun:test';

mock.module('server-only', () => ({}));
mock.module('@/lib/env-config', () => ({ getEnv: () => ({ BACKEND_URL: 'https://api.example.test/v1' }) }));

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const { loadPublicResponse } = await import('./public-response');

test('the shared response is read with no-store, never from the Next fetch cache', async () => {
  // Next caches only 200 responses: a cached 200 would outlive a revoke (410) forever.
  const inits: RequestInit[] = [];
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    inits.push(init ?? {});
    return Response.json({
      response: { title: 'T', prompt: null, markdown: 'M', agent_name: null, model_id: null, responded_at: 'x', shared_at: 'y' },
    });
  }) as typeof fetch;

  const result = await loadPublicResponse('kps_00000000000040008000000000000001');

  expect(result.kind).toBe('shared');
  expect(inits).toHaveLength(1);
  expect(inits[0]?.cache).toBe('no-store');
  expect((inits[0] as { next?: unknown }).next).toBeUndefined();
});
