import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { protectResponseCache } from './cache-control';
import { compressResponse } from './compress';

function app() {
  const app = new Hono<{ Variables: { authType: string } }>();
  app.use('*', protectResponseCache);
  app.use('*', compressResponse);
  app.get('*', (c) => {
    c.header('Cache-Control', 'public, max-age=3600, s-maxage=3600');
    c.header('CDN-Cache-Control', 'public, max-age=3600');
    c.header('Cloudflare-CDN-Cache-Control', 'public, max-age=3600');
    c.header('Surrogate-Control', 'max-age=3600');
    c.header('Vary', 'Origin');
    if (c.req.path === '/error') throw new HTTPException(401);
    if (c.req.path === '/cookie') c.header('Set-Cookie', 'synthetic=value; HttpOnly');
    if (c.req.path === '/principal') c.set('authType', 'synthetic');
    return c.text('synthetic response '.repeat(200));
  });
  return app;
}

describe('response cache protection', () => {
  const credentials: Record<string, string>[] = [
    { Authorization: 'Bearer synthetic' },
    { Cookie: '__preview_session=synthetic' },
    { 'X-Kortix-Token': 'synthetic' },
  ];
  for (const headers of credentials) {
    test('credential-bearing responses override shared-cache directives: ' + Object.keys(headers)[0], async () => {
      for (const encoding of ['identity', 'gzip']) {
        const res = await app().request('/', { headers: { ...headers, 'Accept-Encoding': encoding } });
        for (const name of ['Cache-Control', 'CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control', 'Surrogate-Control']) {
          expect(res.headers.get(name)).toBe('private, no-store');
        }
        expect(res.headers.get('vary')).toBe('Origin, Accept-Encoding');
        const body = encoding === 'gzip'
          ? await new Response(res.body?.pipeThrough(new DecompressionStream('gzip'))).text()
          : await res.text();
        expect(body).toBe('synthetic response '.repeat(200));
      }
    });
  }

  test('protects cookie-setting and resolved-principal responses without credential headers', async () => {
    for (const path of ['/cookie', '/principal']) {
      const res = await app().request(path);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(await res.text()).toContain('synthetic response');
    }
  });

  test('protects authentication errors', async () => {
    const res = await app().request('/error', { headers: { Authorization: 'Bearer synthetic' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  test('preserves anonymous public caching and Vary metadata', async () => {
    const res = await app().request('/');
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600, s-maxage=3600');
    expect(res.headers.get('vary')).toBe('Origin, Accept-Encoding');
  });
});
