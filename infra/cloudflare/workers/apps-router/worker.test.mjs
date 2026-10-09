import { afterEach, describe, expect, test } from 'bun:test';
import worker, { signAppRequest } from './worker.mjs';

const originalFetch = globalThis.fetch;
const originalCaches = globalThis.caches;
afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.caches = originalCaches;
});

/** caches.default: a Map keyed on the request URL, like the Workers Cache API. */
function memoryCache() {
  const entries = new Map();
  globalThis.caches = {
    default: {
      async match(request) {
        const hit = entries.get(request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        entries.set(request.url, response);
      },
    },
  };
  return entries;
}

/** A context whose waitUntil promises the test can await. */
function context() {
  const pending = [];
  return { waitUntil: (promise) => pending.push(promise), settle: () => Promise.all(pending) };
}

const immutableAsset = (body = 'asset', extra = {}) => new Response(body, {
  status: 200,
  headers: {
    'content-type': 'text/javascript',
    'cache-control': 'public, max-age=31536000, immutable',
    'cloudflare-cdn-cache-control': 'no-store',
    vary: 'accept-encoding',
    'x-kortix-edge-cacheable': 'public',
    ...extra,
  },
});

const env = {
  DEV_EDGE_SECRET: 'test-dev-edge-secret-at-least-sixteen',
  STAGING_EDGE_SECRET: 'test-staging-edge-secret-at-least-sixteen',
  PROD_EDGE_SECRET: 'test-prod-edge-secret-at-least-sixteen',
  PREVIEW_EDGE_SECRET: 'test-preview-edge-secret-at-least-sixteen',
  DEV_API_ORIGIN: 'https://dev-api.kortix.com',
  STAGING_API_ORIGIN: 'https://staging-api.kortix.com',
  PROD_API_ORIGIN: 'https://api.kortix.com',
  PREVIEW_API_ORIGIN: 'https://dev-api.kortix.com',
};

describe('Kortix Apps Cloudflare router', () => {
  test('selects the API by the hostname environment and replaces internal headers', async () => {
    let forwarded;
    globalThis.fetch = async (request) => {
      forwarded = request;
      return new Response('hello', { status: 200 });
    };
    const request = new Request(
      'https://dev-hello-0123456789abcdef.apps.kortix.com/path?q=1',
      { headers: { 'x-kortix-app-signature': 'caller-controlled' } },
    );
    const response = await worker.fetch(request, env);

    expect(forwarded.url).toBe('https://dev-api.kortix.com/path?q=1');
    expect(forwarded.headers.get('x-kortix-app-host')).toBe(
      'dev-hello-0123456789abcdef.apps.kortix.com',
    );
    expect(forwarded.headers.get('x-kortix-app-signature')).not.toBe('caller-controlled');
    const timestamp = forwarded.headers.get('x-kortix-app-timestamp');
    expect(forwarded.headers.get('x-kortix-app-signature')).toBe(
      await signAppRequest(request, timestamp, env.DEV_EDGE_SECRET),
    );
    expect(response.headers.get('x-kortix-app-environment')).toBe('dev');
    expect(response.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self' https://kortix.com https://*.kortix.com http://localhost:* http://127.0.0.1:*",
    );
    expect(response.headers.get('x-frame-options')).toBeNull();
  });

  test('a client with no User-Agent reaches the API with one; a client User-Agent passes through', async () => {
    // The API zone refuses a request without a User-Agent (403). Node's `ws`
    // (the Convex CLI and every server-side Convex client) sends none.
    const forwarded = [];
    globalThis.fetch = async (request) => {
      forwarded.push(request);
      return new Response('ok', { status: 200 });
    };
    await worker.fetch(new Request('https://dev-convex-0123456789abcdef.apps.kortix.com/version'), env);
    await worker.fetch(new Request('https://dev-convex-0123456789abcdef.apps.kortix.com/version', {
      headers: { 'user-agent': 'node-fetch/3' },
    }), env);

    expect(forwarded[0].headers.get('user-agent')).toBe('kortix-apps-router');
    expect(forwarded[1].headers.get('user-agent')).toBe('node-fetch/3');
  });

  test('replaces upstream framing restrictions and preserves other CSP directives', async () => {
    globalThis.fetch = async () => new Response('hello', {
      status: 200,
      headers: {
        'x-frame-options': 'DENY',
        'content-security-policy': "default-src 'self'; frame-ancestors https://example.com",
      },
    });

    const response = await worker.fetch(
      new Request('https://dev-hello-0123456789abcdef.apps.kortix.com/'),
      env,
    );

    expect(response.headers.get('x-frame-options')).toBeNull();
    expect(response.headers.get('content-security-policy')).toBe(
      "default-src 'self'; frame-ancestors 'self' https://kortix.com https://*.kortix.com http://localhost:* http://127.0.0.1:*",
    );
  });

  test('signs method, host, path, and query deterministically', async () => {
    const request = new Request('https://prod-app-0123456789abcdef.apps.kortix.com/api?q=1', {
      method: 'POST',
    });
    const first = await signAppRequest(request, '1234', env.PROD_EDGE_SECRET);
    expect(first).toBe(await signAppRequest(request, '1234', env.PROD_EDGE_SECRET));
    expect(first).not.toBe(await signAppRequest(
      new Request('https://prod-app-0123456789abcdef.apps.kortix.com/other?q=1', { method: 'POST' }),
      '1234',
      env.PROD_EDGE_SECRET,
    ));
  });

  test('rejects unrecognized environment labels', async () => {
    const response = await worker.fetch(
      new Request('https://qa-app-0123456789abcdef.apps.kortix.com/'),
      env,
    );
    expect(response.status).toBe(404);
  });

  describe('edge cache', () => {
    const appA = 'https://dev-hello-0123456789abcdef.apps.kortix.com/assets/index-D8j1YYcB.js';
    const appB = 'https://dev-other-fedcba9876543210.apps.kortix.com/assets/index-D8j1YYcB.js';

    async function get(url, init = {}) {
      const ctx = context();
      const response = await worker.fetch(new Request(url, init), env, ctx);
      await ctx.settle();
      return response;
    }

    test('serves a public immutable asset from the edge on the second request', async () => {
      const entries = memoryCache();
      let origin = 0;
      globalThis.fetch = async () => { origin += 1; return immutableAsset('A'); };

      const first = await get(appA, { headers: { 'accept-encoding': 'br, gzip' } });
      expect(first.headers.get('x-kortix-edge-cache')).toBe('MISS');
      expect(await first.text()).toBe('A');
      const second = await get(appA, { headers: { 'accept-encoding': 'gzip, br' } });

      expect(origin).toBe(1);
      expect(second.headers.get('x-kortix-edge-cache')).toBe('HIT');
      expect(await second.text()).toBe('A');
      // The browser keeps the origin's policy; only the stored copy has the edge TTL.
      expect(second.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(second.headers.get('x-kortix-edge-cacheable')).toBeNull();
      expect(second.headers.get('x-kortix-browser-cache-control')).toBeNull();
      expect(second.headers.get('x-kortix-app-environment')).toBe('dev');
      const [stored] = [...entries.values()];
      expect(stored.headers.get('cache-control')).toBe('public, max-age=3600');
      expect(stored.headers.get('cloudflare-cdn-cache-control')).toBeNull();
    });

    test('keys the cache on the App host: the same path on another App is a miss', async () => {
      memoryCache();
      globalThis.fetch = async (request) => immutableAsset(
        request.headers.get('x-kortix-app-host').startsWith('dev-hello') ? 'A' : 'B',
      );

      await get(appA);
      const other = await get(appB);

      expect(other.headers.get('x-kortix-edge-cache')).toBe('MISS');
      expect(await other.text()).toBe('B');
      expect(await (await get(appA)).text()).toBe('A');
      expect(await (await get(appB)).text()).toBe('B');
    });

    test('keys the cache on the negotiated encoding and forwards only that encoding', async () => {
      const entries = memoryCache();
      const asked = [];
      globalThis.fetch = async (request) => {
        asked.push(request.headers.get('accept-encoding'));
        return immutableAsset('A');
      };

      await get(appA, { headers: { 'accept-encoding': 'gzip, deflate, br' } });
      await get(appA, { headers: { 'accept-encoding': 'gzip' } });
      await get(appA, { headers: { 'accept-encoding': 'identity' } });
      await get(appA);

      expect(asked).toEqual(['br', 'gzip', 'identity']);
      expect([...entries.keys()].map((key) => new URL(key).searchParams.get('__kortix_enc'))).toEqual(
        ['br', 'gzip', 'identity'],
      );
    });

    test('never stores a response the API did not mark shareable', async () => {
      const cases = [
        // A private App's file.
        () => new Response('x', { headers: { 'cache-control': 'private, max-age=31536000, immutable' } }),
        // A server App that sends its own public immutable header.
        () => new Response('x', { headers: { 'cache-control': 'public, max-age=31536000, immutable' } }),
        // Marked, but HTML or a mutable file that revalidates.
        () => immutableAsset('x', { 'cache-control': 'public, no-cache' }),
        () => immutableAsset('x', { 'cache-control': 'public, max-age=0, must-revalidate' }),
        // Marked, but it sets a cookie or varies on more than the encoding.
        () => immutableAsset('x', { 'set-cookie': 'session=1' }),
        () => immutableAsset('x', { vary: 'accept-encoding, cookie' }),
        () => immutableAsset('x', { vary: '*' }),
        // Marked, but not a full 200.
        () => new Response('x', { status: 404, headers: immutableAsset().headers }),
      ];
      for (const upstream of cases) {
        const entries = memoryCache();
        globalThis.fetch = async () => upstream();
        const response = await get(appA);
        expect(entries.size).toBe(0);
        expect(response.headers.get('x-kortix-edge-cacheable')).toBeNull();
      }
    });

    test('bypasses the cache for writes, HEAD, and range requests', async () => {
      const entries = memoryCache();
      let origin = 0;
      globalThis.fetch = async () => { origin += 1; return immutableAsset('A'); };

      for (const init of [{ method: 'POST', body: 'x' }, { method: 'HEAD' }, { headers: { range: 'bytes=0-1' } }]) {
        const response = await get(appA, init);
        expect(response.headers.get('x-kortix-edge-cache')).toBeNull();
      }
      expect(origin).toBe(3);
      expect(entries.size).toBe(0);
    });

    test('a cache failure falls through to the origin', async () => {
      globalThis.caches = { default: { match: async () => { throw new Error('down'); }, put: async () => {} } };
      globalThis.fetch = async () => immutableAsset('A');
      const response = await get(appA);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('A');
    });
  });
});
