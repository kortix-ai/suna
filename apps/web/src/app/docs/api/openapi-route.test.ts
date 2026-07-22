import { afterEach, describe, expect, it } from 'bun:test';

import { GET } from './openapi.json/route';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('GET /docs/api/openapi.json', () => {
  it('returns the upstream spec with caching headers', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ openapi: '3.1.0', paths: {} }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=300');
    const body = await res.json();
    expect(body.openapi).toBe('3.1.0');
  });

  it('returns 502 when the upstream fails', async () => {
    globalThis.fetch = (async () =>
      new Response('nope', { status: 500 })) as typeof fetch;

    const res = await GET();
    expect(res.status).toBe(502);
  });
});
