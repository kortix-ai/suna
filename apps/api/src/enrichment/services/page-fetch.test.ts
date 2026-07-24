import { describe, expect, test } from 'bun:test';
import { UnsafeEgressError } from '../../shared/ssrf-guard';
import type { BoundedResponse } from './safe-fetch';
import {
  fetchPages,
  RateLimiter,
  readerUrl,
  type PageCachePort,
} from './page-fetch';

const ORIGIN = 'https://example.com';
const FIRECRAWL_BASE = 'https://firecrawl.test';
const JINA_KEY = 'jina-key';
const FIRECRAWL_KEY = 'firecrawl-key';

const NO_LIMIT = { rpm: 100_000, now: () => 0, sleep: async () => {} };

function ok(body: string, contentType = 'text/plain'): BoundedResponse {
  return { url: '', status: 200, ok: true, contentType, body, truncated: false };
}

function statusResponse(status: number, body = ''): BoundedResponse {
  return { url: '', status, ok: false, contentType: 'text/plain', body, truncated: false };
}

interface Call {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

interface RouterHandlers {
  jina?: (target: string) => BoundedResponse | Promise<BoundedResponse>;
  firecrawl?: (target: string) => BoundedResponse | Promise<BoundedResponse>;
  direct?: (url: string) => BoundedResponse | Promise<BoundedResponse>;
}

/** Routes a fake `boundedFetch` to the tier the literal URL identifies. */
function router(handlers: RouterHandlers = {}) {
  const calls: Call[] = [];
  const impl = (async (
    url: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (url.startsWith('https://r.jina.ai/')) {
      const target = url.slice('https://r.jina.ai/'.length);
      return handlers.jina ? handlers.jina(target) : ok(`# ${target}`);
    }
    if (url.startsWith(FIRECRAWL_BASE)) {
      const target = init.body ? (JSON.parse(init.body) as { url: string }).url : '';
      return handlers.firecrawl
        ? handlers.firecrawl(target)
        : ok(JSON.stringify({ data: { markdown: `# firecrawl ${target}` } }), 'application/json');
    }
    return handlers.direct
      ? handlers.direct(url)
      : ok(`<html><body><h1>direct ${url}</h1></body></html>`, 'text/html');
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
  test('fetches via jina when a key is configured', async () => {
    const { impl, calls } = router();
    const result = await fetchPages([`${ORIGIN}/`], { ...NO_LIMIT, fetchImpl: impl, jinaApiKey: JINA_KEY });

    expect(result.pages[0].tier).toBe('jina');
    expect(result.pages[0].markdown).toContain(ORIGIN);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://r.jina.ai/${ORIGIN}/`);
  });

  test('sends the jina key as a bearer token', async () => {
    const { impl, calls } = router();
    await fetchPages([`${ORIGIN}/`], { ...NO_LIMIT, fetchImpl: impl, jinaApiKey: JINA_KEY });
    expect(calls[0].headers?.authorization).toBe(`Bearer ${JINA_KEY}`);
  });

  test('skips jina entirely when no key is configured', async () => {
    const { impl, calls } = router();
    const result = await fetchPages([`${ORIGIN}/`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      firecrawlApiKey: FIRECRAWL_KEY,
      firecrawlApiUrl: FIRECRAWL_BASE,
    });
    expect(calls.some((c) => c.url.startsWith('https://r.jina.ai/'))).toBe(false);
    expect(result.pages[0].tier).toBe('firecrawl');
  });

  test('falls through from jina to firecrawl on a 402', async () => {
    let jinaAttempts = 0;
    const { impl, calls } = router({
      jina: () => {
        jinaAttempts += 1;
        return statusResponse(402, 'payment required');
      },
    });
    const result = await fetchPages([`${ORIGIN}/`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      jinaApiKey: JINA_KEY,
      firecrawlApiKey: FIRECRAWL_KEY,
      firecrawlApiUrl: FIRECRAWL_BASE,
    });

    // One retry on the jina tier before falling through.
    expect(jinaAttempts).toBe(2);
    expect(result.pages[0].tier).toBe('firecrawl');
    expect(result.failures).toEqual([]);
    expect(calls.some((c) => c.url.startsWith(FIRECRAWL_BASE))).toBe(true);
  });

  test('sends the firecrawl request as a POST with url and markdown format', async () => {
    const { impl, calls } = router();
    await fetchPages([`${ORIGIN}/about`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      firecrawlApiKey: FIRECRAWL_KEY,
      firecrawlApiUrl: FIRECRAWL_BASE,
    });

    const call = calls.find((c) => c.url.startsWith(FIRECRAWL_BASE))!;
    expect(call.url).toBe(`${FIRECRAWL_BASE}/v1/scrape`);
    expect(call.method).toBe('POST');
    expect(call.headers?.authorization).toBe(`Bearer ${FIRECRAWL_KEY}`);
    expect(JSON.parse(call.body!)).toEqual({ url: `${ORIGIN}/about`, formats: ['markdown'] });
  });

  test('falls through to direct when both jina and firecrawl fail', async () => {
    const { impl } = router({
      jina: () => statusResponse(500, 'down'),
      firecrawl: () => statusResponse(500, 'down'),
      direct: () => ok('<html><body><main><h1>Hello</h1></main></body></html>', 'text/html'),
    });
    const result = await fetchPages([`${ORIGIN}/`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      jinaApiKey: JINA_KEY,
      firecrawlApiKey: FIRECRAWL_KEY,
      firecrawlApiUrl: FIRECRAWL_BASE,
    });

    expect(result.pages[0].tier).toBe('direct');
    expect(result.pages[0].markdown).toContain('Hello');
    expect(result.failures).toEqual([]);
  });

  test('converts direct HTML to markdown, stripping chrome and preferring main', async () => {
    const html = `
      <html>
        <head><style>.x{color:red}</style></head>
        <body>
          <nav>Home | About</nav>
          <script>trackPageview();</script>
          <main>
            <h1>About Acme</h1>
            <p>We build widgets.</p>
            <svg><circle /></svg>
          </main>
          <footer>Copyright Acme</footer>
        </body>
      </html>`;
    const { impl } = router({ direct: () => ok(html, 'text/html') });
    const result = await fetchPages([`${ORIGIN}/about`], { ...NO_LIMIT, fetchImpl: impl });

    const markdown = result.pages[0].markdown;
    expect(markdown).toContain('About Acme');
    expect(markdown).toContain('We build widgets');
    expect(markdown).not.toContain('Home | About');
    expect(markdown).not.toContain('Copyright Acme');
    expect(markdown).not.toContain('trackPageview');
  });

  test('treats an empty document as a failure on every tier', async () => {
    const { impl } = router({
      jina: () => ok('   '),
      firecrawl: () => ok(JSON.stringify({ data: { markdown: '' } }), 'application/json'),
      direct: () => ok('<html><body><nav>only chrome</nav></body></html>', 'text/html'),
    });
    const result = await fetchPages([`${ORIGIN}/`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      jinaApiKey: JINA_KEY,
      firecrawlApiKey: FIRECRAWL_KEY,
      firecrawlApiUrl: FIRECRAWL_BASE,
    });

    expect(result.pages).toEqual([]);
    expect(result.failures[0].reason).toContain('empty');
  });

  test('treats a non-2xx reader response as a failure that still falls through', async () => {
    const { impl } = router({ jina: () => statusResponse(402, 'payment required') });
    const result = await fetchPages([`${ORIGIN}/`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      jinaApiKey: JINA_KEY,
    });
    expect(result.pages[0].tier).toBe('direct');
  });

  test('gives up and records a failure once every tier is exhausted', async () => {
    const { impl } = router({
      jina: () => statusResponse(500),
      firecrawl: () => statusResponse(500),
      direct: () => statusResponse(500),
    });
    const result = await fetchPages([`${ORIGIN}/`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      jinaApiKey: JINA_KEY,
      firecrawlApiKey: FIRECRAWL_KEY,
      firecrawlApiUrl: FIRECRAWL_BASE,
    });
    expect(result.pages).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].url).toBe(`${ORIGIN}/`);
  });

  test('does not retry or fall through on a guard rejection', async () => {
    const { impl, calls } = router();
    let assertions = 0;
    const result = await fetchPages([`${ORIGIN}/`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      jinaApiKey: JINA_KEY,
      firecrawlApiKey: FIRECRAWL_KEY,
      firecrawlApiUrl: FIRECRAWL_BASE,
      assertUrl: (async (url: string) => {
        assertions += 1;
        throw new UnsafeEgressError('blocked', url);
      }) as never,
    });

    expect(assertions).toBe(1);
    expect(calls).toHaveLength(0);
    expect(result.failures[0].reason).toBe('blocked');
  });

  test('preserves input order', async () => {
    const { impl } = router();
    const urls = [`${ORIGIN}/a`, `${ORIGIN}/b`, `${ORIGIN}/c`];
    const result = await fetchPages(urls, { ...NO_LIMIT, fetchImpl: impl, concurrency: 3 });
    expect(result.pages.map((p) => p.url)).toEqual(urls);
  });

  test('dedupes repeated urls', async () => {
    const { impl, calls } = router();
    const result = await fetchPages([`${ORIGIN}/a`, `${ORIGIN}/a`], { ...NO_LIMIT, fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(result.pages).toHaveLength(1);
  });

  test('serves cached pages without invoking any tier', async () => {
    const cache = memoryCache({ [`${ORIGIN}/about`]: '# cached about' });
    const { impl, calls } = router();

    const result = await fetchPages([`${ORIGIN}/about`, `${ORIGIN}/new`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      cache: cache.port,
      jinaApiKey: JINA_KEY,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/new');
    const aboutPage = result.pages.find((p) => p.url === `${ORIGIN}/about`);
    expect(aboutPage?.fromCache).toBe(true);
    expect(aboutPage?.tier).toBe('cache');
    expect(aboutPage?.markdown).toBe('# cached about');
  });

  test('writes newly fetched pages to the cache', async () => {
    const cache = memoryCache();
    const { impl } = router();
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
    const { impl } = router();
    const result = await fetchPages([`${ORIGIN}/new`], {
      ...NO_LIMIT,
      fetchImpl: impl,
      cache: failing,
    });
    expect(result.pages).toHaveLength(1);
  });

  test('never exceeds the concurrency bound', async () => {
    let inFlight = 0;
    let peak = 0;
    const { impl } = router({
      direct: async (url) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return ok(`<html><body>${url}</body></html>`, 'text/html');
      },
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
    const { impl } = router({
      direct: async (url) => {
        fetched += 1;
        if (fetched === 2) controller.abort();
        return ok(`<html><body>${url}</body></html>`, 'text/html');
      },
    });

    await fetchPages(
      Array.from({ length: 10 }, (_, i) => `${ORIGIN}/p${i}`),
      { ...NO_LIMIT, fetchImpl: impl, concurrency: 1, signal: controller.signal },
    );

    expect(fetched).toBeLessThan(10);
  });

  test('returns nothing for an empty url list', async () => {
    const { impl, calls } = router();
    const result = await fetchPages([], { ...NO_LIMIT, fetchImpl: impl });
    expect(result).toEqual({ pages: [], failures: [] });
    expect(calls).toHaveLength(0);
  });
});
