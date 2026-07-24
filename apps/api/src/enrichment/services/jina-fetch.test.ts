import { describe, expect, test } from 'bun:test';
import type { BoundedResponse } from './safe-fetch';
import {
  fetchPages,
  RateLimiter,
  readerUrl,
  type PageCachePort,
} from './jina-fetch';

const ORIGIN = 'https://example.com';

function ok(body: string): BoundedResponse {
  return { url: '', status: 200, ok: true, contentType: 'text/plain', body, truncated: false };
}

function fetcherFor(
  handler: (url: string, init: { headers?: Record<string, string> }) => BoundedResponse | Promise<BoundedResponse>,
) {
  const calls: Array<{ url: string; headers?: Record<string, string> }> = [];
  const impl = (async (url: string, init: { headers?: Record<string, string> } = {}) => {
    calls.push({ url, headers: init.headers });
    return handler(url, init);
  }) as unknown as typeof import('./safe-fetch').boundedFetch;
  return { impl, calls };
}

function memoryCache(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  const writes: string[] = [];
  const port: PageCachePort = {
    get: async (urls) => new Map(urls.filter((u) => store.has(u)).map((u) => [u, store.get(u)!])),
    put: async (url, markdown) => {
      writes.push(url);
      store.set(url, markdown);
    },
  };
  return { port, store, writes };
}

const NO_LIMIT = { rpm: 100_000, now: () => 0, sleep: async () => {} };

describe('readerUrl', () => {
  test('prefixes the reader origin', () => {
    expect(readerUrl(`${ORIGIN}/about`)).toBe('https://r.jina.ai/https://example.com/about');
  });
});

describe('RateLimiter', () => {
  test('allows requests up to the bucket size without waiting', async () => {
    let slept = 0;
    const limiter = new RateLimiter(3, () => 0, async (ms) => {
      slept += ms;
    });
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(slept).toBe(0);
  });

  test('waits once the bucket is empty', async () => {
    let now = 0;
    let slept = 0;
    const limiter = new RateLimiter(
      1,
      () => now,
      async (ms) => {
        slept += ms;
        now += ms;
      },
    );
    await limiter.acquire();
    await limiter.acquire();
    expect(slept).toBeGreaterThan(0);
  });

  test('refills as time passes', async () => {
    let now = 0;
    const limiter = new RateLimiter(60, () => now, async () => {});
    for (let i = 0; i < 60; i += 1) await limiter.acquire();
    now += 60_000;
    let slept = 0;
    const limiter2 = new RateLimiter(60, () => now, async (ms) => {
      slept += ms;
    });
    await limiter2.acquire();
    expect(slept).toBe(0);
  });
});

describe('fetchPages', () => {
  test('returns markdown for each url', async () => {
    const { impl } = fetcherFor((url) => ok(`# ${url}`));
    const result = await fetchPages([`${ORIGIN}/`, `${ORIGIN}/about`], { ...NO_LIMIT, fetchImpl: impl });

    expect(result.pages).toHaveLength(2);
    expect(result.pages[0].markdown).toContain(`${ORIGIN}/`);
    expect(result.failures).toEqual([]);
  });

  test('preserves input order', async () => {
    const { impl } = fetcherFor((url) => ok(url));
    const urls = [`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`];
    const result = await fetchPages(urls, { ...NO_LIMIT, fetchImpl: impl, concurrency: 3 });
    expect(result.pages.map((p) => p.url)).toEqual(urls);
  });

  test('sends the api key as a bearer token', async () => {
    const { impl, calls } = fetcherFor(() => ok('x'));
    await fetchPages([`${ORIGIN}/`], { ...NO_LIMIT, fetchImpl: impl, apiKey: 'jina-key' });
    expect(calls[0].headers?.authorization).toBe('Bearer jina-key');
  });

  test('omits the authorization header when no key is configured', async () => {
    const { impl, calls } = fetcherFor(() => ok('x'));
    await fetchPages([`${ORIGIN}/`], { ...NO_LIMIT, fetchImpl: impl });
    expect(calls[0].headers?.authorization).toBeUndefined();
  });

  test('skips failing pages instead of failing the batch', async () => {
    const { impl } = fetcherFor((url) => {
      if (url.includes('/bad')) throw new Error('connection reset');
      return ok('good');
    });
    const result = await fetchPages([`${ORIGIN}/good`, `${ORIGIN}/bad`], {
      ...NO_LIMIT,
      fetchImpl: impl,
    });

    expect(result.pages.map((p) => p.url)).toEqual([`${ORIGIN}/good`]);
    expect(result.failures[0].url).toBe(`${ORIGIN}/bad`);
  });

  test('retries a failed page once', async () => {
    let attempts = 0;
    const { impl } = fetcherFor(() => {
      attempts += 1;
      if (attempts === 1) throw new Error('flaky');
      return ok('recovered');
    });
    const result = await fetchPages([`${ORIGIN}/`], { ...NO_LIMIT, fetchImpl: impl });

    expect(attempts).toBe(2);
    expect(result.pages[0].markdown).toBe('recovered');
  });

  test('gives up after the single retry', async () => {
    let attempts = 0;
    const { impl } = fetcherFor(() => {
      attempts += 1;
      throw new Error('always down');
    });
    const result = await fetchPages([`${ORIGIN}/`], { ...NO_LIMIT, fetchImpl: impl });

    expect(attempts).toBe(2);
    expect(result.pages).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  test('treats a non-2xx reader response as a failure', async () => {
    const { impl } = fetcherFor(() => ({
      url: '',
      status: 402,
      ok: false,
      contentType: 'text/plain',
      body: 'payment required',
      truncated: false,
    }));
    const result = await fetchPages([`${ORIGIN}/`], { ...NO_LIMIT, fetchImpl: impl });
    expect(result.failures[0].reason).toContain('402');
  });

  test('treats an empty document as a failure', async () => {
    const { impl } = fetcherFor(() => ok('   '));
    const result = await fetchPages([`${ORIGIN}/`], { ...NO_LIMIT, fetchImpl: impl });
    expect(result.failures[0].reason).toContain('empty');
  });

  test('serves cached pages without fetching', async () => {
    const cache = memoryCache({ [`${ORIGIN}/about`]: '# cached about' });
    const { impl, calls } = fetcherFor(() => ok('# fresh'));

    const result = await fetchPages([`${ORIGIN}/about`, `${ORIGIN}/new`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      cache: cache.port,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/new');
    const aboutPage = result.pages.find((p) => p.url === `${ORIGIN}/about`);
    expect(aboutPage?.fromCache).toBe(true);
    expect(aboutPage?.markdown).toBe('# cached about');
  });

  test('writes newly fetched pages to the cache', async () => {
    const cache = memoryCache();
    const { impl } = fetcherFor(() => ok('# fresh'));
    await fetchPages([`${ORIGIN}/new`], { ...NO_LIMIT, fetchImpl: impl, cache: cache.port });
    expect(cache.writes).toEqual([`${ORIGIN}/new`]);
  });

  test('does not fail a page when the cache write throws', async () => {
    const cache = memoryCache();
    const failing: PageCachePort = {
      get: cache.port.get,
      put: async () => {
        throw new Error('db down');
      },
    };
    const { impl } = fetcherFor(() => ok('# fresh'));
    const result = await fetchPages([`${ORIGIN}/new`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      cache: failing,
    });
    expect(result.pages).toHaveLength(1);
  });

  test('dedupes repeated urls', async () => {
    const { impl, calls } = fetcherFor(() => ok('x'));
    const result = await fetchPages([`${ORIGIN}/a`, `${ORIGIN}/a`], { ...NO_LIMIT, fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(result.pages).toHaveLength(1);
  });

  test('never exceeds the concurrency bound', async () => {
    let inFlight = 0;
    let peak = 0;
    const { impl } = fetcherFor(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return ok('x');
    });

    await fetchPages(
      Array.from({ length: 12 }, (_, i) => `${ORIGIN}/p${i}`),
      { ...NO_LIMIT, fetchImpl: impl, concurrency: 3 },
    );

    expect(peak).toBeLessThanOrEqual(3);
  });

  test('stops early when the job is aborted', async () => {
    const controller = new AbortController();
    let fetched = 0;
    const { impl } = fetcherFor(async () => {
      fetched += 1;
      if (fetched === 2) controller.abort();
      return ok('x');
    });

    await fetchPages(
      Array.from({ length: 10 }, (_, i) => `${ORIGIN}/p${i}`),
      { ...NO_LIMIT, fetchImpl: impl, concurrency: 1, signal: controller.signal },
    );

    expect(fetched).toBeLessThan(10);
  });

  test('returns nothing for an empty url list', async () => {
    const { impl, calls } = fetcherFor(() => ok('x'));
    const result = await fetchPages([], { ...NO_LIMIT, fetchImpl: impl });
    expect(result).toEqual({ pages: [], failures: [] });
    expect(calls).toHaveLength(0);
  });
});
