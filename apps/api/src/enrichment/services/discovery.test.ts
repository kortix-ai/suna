import { describe, expect, test } from 'bun:test';
import type { BoundedResponse } from './safe-fetch';
import {
  discover,
  extractLinks,
  extractSignals,
  parseSitemap,
  sitemapIsSufficient,
} from './discovery';

const ORIGIN = 'https://example.com';

function html(body: string, head = ''): string {
  return `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
}

function ok(body: string, contentType = 'text/html'): BoundedResponse {
  return { url: '', status: 200, ok: true, contentType, body, truncated: false };
}

function notFound(): BoundedResponse {
  return { url: '', status: 404, ok: false, contentType: 'text/html', body: '', truncated: false };
}

function fakeFetcher(routes: Record<string, BoundedResponse | (() => BoundedResponse)>) {
  const calls: string[] = [];
  const impl = (async (url: string) => {
    calls.push(url);
    const route = routes[url];
    if (!route) return notFound();
    return typeof route === 'function' ? route() : route;
  }) as unknown as typeof import('./safe-fetch').boundedFetch;
  return { impl, calls };
}

const ORG_JSON_LD = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Example Inc',
  sameAs: ['https://twitter.com/example'],
});

describe('extractSignals', () => {
  test('reads the title', () => {
    expect(extractSignals(html('', '<title>  Example Inc  </title>')).title).toBe('Example Inc');
  });

  test('parses a schema.org organization block', () => {
    const signals = extractSignals(
      html('', `<script type="application/ld+json">${ORG_JSON_LD}</script>`),
    );
    expect(signals.jsonLd).toHaveLength(1);
    expect((signals.jsonLd[0] as { name: string }).name).toBe('Example Inc');
  });

  test('flattens an @graph wrapper', () => {
    const graph = JSON.stringify({ '@graph': [{ '@type': 'Organization' }, { '@type': 'Person' }] });
    const signals = extractSignals(html('', `<script type="application/ld+json">${graph}</script>`));
    expect(signals.jsonLd).toHaveLength(2);
  });

  test('collects an array of json-ld nodes', () => {
    const arr = JSON.stringify([{ '@type': 'Organization' }, { '@type': 'WebSite' }]);
    const signals = extractSignals(html('', `<script type="application/ld+json">${arr}</script>`));
    expect(signals.jsonLd).toHaveLength(2);
  });

  test('skips malformed json-ld without failing', () => {
    const signals = extractSignals(
      html('', '<script type="application/ld+json">{not json}</script>'),
    );
    expect(signals.jsonLd).toEqual([]);
  });

  test('reads opengraph and plain meta tags separately', () => {
    const signals = extractSignals(
      html(
        '',
        `<meta property="og:title" content="Example"><meta property="og:description" content="Does things">
         <meta name="description" content="Meta description">`,
      ),
    );
    expect(signals.openGraph).toEqual({ title: 'Example', description: 'Does things' });
    expect(signals.meta.description).toBe('Meta description');
  });

  test('ignores meta tags with no content', () => {
    expect(extractSignals(html('', '<meta name="description" content="">')).meta).toEqual({});
  });
});

describe('extractLinks', () => {
  test('resolves relative and absolute hrefs', () => {
    const links = extractLinks(
      html('<a href="/about">a</a><a href="https://example.com/pricing">p</a>'),
      `${ORIGIN}/`,
    );
    expect(links).toEqual(['https://example.com/about', 'https://example.com/pricing']);
  });

  test('drops non-http hrefs', () => {
    const links = extractLinks(
      html('<a href="mailto:x@example.com">m</a><a href="/ok">o</a>'),
      `${ORIGIN}/`,
    );
    expect(links).toEqual(['https://example.com/ok']);
  });
});

describe('parseSitemap', () => {
  test('extracts page urls from a urlset', () => {
    const xml = `<urlset><url><loc>https://example.com/about</loc></url><url><loc>https://example.com/pricing</loc></url></urlset>`;
    expect(parseSitemap(xml).urls).toEqual([
      'https://example.com/about',
      'https://example.com/pricing',
    ]);
  });

  test('extracts nested sitemaps from an index', () => {
    const xml = `<sitemapindex><sitemap><loc>https://example.com/sitemap-1.xml</loc></sitemap></sitemapindex>`;
    const parsed = parseSitemap(xml);
    expect(parsed.sitemaps).toEqual(['https://example.com/sitemap-1.xml']);
    expect(parsed.urls).toEqual([]);
  });

  test('returns nothing for junk input', () => {
    expect(parseSitemap('<html>not a sitemap</html>').urls).toEqual([]);
  });
});

describe('sitemapIsSufficient', () => {
  test('accepts a sitemap containing company pages', () => {
    expect(sitemapIsSufficient(['https://example.com/about'], ORIGIN)).toBe(true);
  });

  test('rejects a sitemap of only blog posts', () => {
    expect(
      sitemapIsSufficient(['https://example.com/blog/a', 'https://example.com/blog/b'], ORIGIN),
    ).toBe(false);
  });

  test('rejects a homepage-only sitemap', () => {
    expect(sitemapIsSufficient(['https://example.com/'], ORIGIN)).toBe(false);
  });
});

describe('discover', () => {
  test('uses the sitemap and skips crawling when it lists company pages', async () => {
    const { impl, calls } = fakeFetcher({
      [`${ORIGIN}/robots.txt`]: ok('User-agent: *\nAllow: /', 'text/plain'),
      [`${ORIGIN}/`]: ok(html('<a href="/deep">deep</a>', `<title>Example</title>`)),
      [`${ORIGIN}/sitemap.xml`]: ok(
        `<urlset><url><loc>${ORIGIN}/about</loc></url><url><loc>${ORIGIN}/pricing</loc></url></urlset>`,
        'application/xml',
      ),
    });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.usedSitemap).toBe(true);
    expect(result.status).toBe('complete');
    expect(result.urls).toContain(`${ORIGIN}/about`);
    expect(result.urls).toContain(`${ORIGIN}/pricing`);
    expect(calls).not.toContain(`${ORIGIN}/deep`);
  });

  test('still harvests homepage signals in sitemap mode', async () => {
    const { impl } = fakeFetcher({
      [`${ORIGIN}/`]: ok(
        html('', `<title>Example Inc</title><script type="application/ld+json">${ORG_JSON_LD}</script>`),
      ),
      [`${ORIGIN}/sitemap.xml`]: ok(`<urlset><url><loc>${ORIGIN}/about</loc></url></urlset>`),
    });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.usedSitemap).toBe(true);
    expect(result.signals.title).toBe('Example Inc');
    expect(result.signals.jsonLd).toHaveLength(1);
  });

  test('harvests outbound links from the homepage even in sitemap mode', async () => {
    const { impl } = fakeFetcher({
      [`${ORIGIN}/`]: ok(html('<a href="https://github.com/example">GH</a>')),
      [`${ORIGIN}/sitemap.xml`]: ok(`<urlset><url><loc>${ORIGIN}/about</loc></url></urlset>`),
    });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.signals.socials).toEqual([
      { platform: 'github', url: 'https://github.com/example' },
    ]);
  });

  test('merges outbound links harvested across several crawled pages', async () => {
    const { impl } = fakeFetcher({
      [`${ORIGIN}/`]: ok(html('<a href="/about">about</a><a href="https://github.com/example">GH</a>')),
      [`${ORIGIN}/about`]: ok(html('<a href="https://x.com/example">X</a><a href="mailto:hi@example.com">m</a>')),
    });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.signals.socials).toContainEqual({ platform: 'github', url: 'https://github.com/example' });
    expect(result.signals.socials).toContainEqual({ platform: 'x', url: 'https://x.com/example' });
    expect(result.signals.emails).toEqual(['hi@example.com']);
  });

  test('crawls when the sitemap has no company pages', async () => {
    const { impl, calls } = fakeFetcher({
      [`${ORIGIN}/`]: ok(html('<a href="/about">about</a>')),
      [`${ORIGIN}/about`]: ok(html('<h1>About</h1>')),
      [`${ORIGIN}/sitemap.xml`]: ok(`<urlset><url><loc>${ORIGIN}/blog/a</loc></url></urlset>`),
    });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.usedSitemap).toBe(false);
    expect(calls).toContain(`${ORIGIN}/about`);
    expect(result.urls).toContain(`${ORIGIN}/about`);
  });

  test('follows a sitemap index to its child sitemaps', async () => {
    const { impl } = fakeFetcher({
      [`${ORIGIN}/`]: ok(html('')),
      [`${ORIGIN}/sitemap.xml`]: ok(
        `<sitemapindex><sitemap><loc>${ORIGIN}/sitemap-pages.xml</loc></sitemap></sitemapindex>`,
      ),
      [`${ORIGIN}/sitemap-pages.xml`]: ok(`<urlset><url><loc>${ORIGIN}/team</loc></url></urlset>`),
    });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.usedSitemap).toBe(true);
    expect(result.urls).toContain(`${ORIGIN}/team`);
  });

  test('honours robots disallow rules during the crawl', async () => {
    const { impl, calls } = fakeFetcher({
      [`${ORIGIN}/robots.txt`]: ok('User-agent: *\nDisallow: /secret', 'text/plain'),
      [`${ORIGIN}/`]: ok(html('<a href="/secret">s</a><a href="/open">o</a>')),
      [`${ORIGIN}/open`]: ok(html('<h1>Open</h1>')),
      [`${ORIGIN}/secret`]: ok(html('<h1>Secret</h1>')),
    });

    await discover(ORIGIN, { fetchImpl: impl });

    expect(calls).toContain(`${ORIGIN}/open`);
    expect(calls).not.toContain(`${ORIGIN}/secret`);
  });

  test('drops sitemap urls that robots disallows', async () => {
    const { impl } = fakeFetcher({
      [`${ORIGIN}/robots.txt`]: ok('User-agent: *\nDisallow: /about', 'text/plain'),
      [`${ORIGIN}/`]: ok(html('')),
      [`${ORIGIN}/sitemap.xml`]: ok(`<urlset><url><loc>${ORIGIN}/about</loc></url></urlset>`),
    });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.urls).not.toContain(`${ORIGIN}/about`);
  });

  test('stops at the page budget', async () => {
    const links = Array.from({ length: 30 }, (_, i) => `<a href="/p${i}">p</a>`).join('');
    const routes: Record<string, BoundedResponse> = {
      [`${ORIGIN}/`]: ok(html(links)),
    };
    for (let i = 0; i < 30; i += 1) routes[`${ORIGIN}/p${i}`] = ok(html('<h1>p</h1>'));
    const { impl } = fakeFetcher(routes);

    const result = await discover(ORIGIN, { fetchImpl: impl, maxPages: 5 });

    expect(result.pagesCrawled).toBeLessThanOrEqual(5);
  });

  test('does not follow links deeper than the depth limit', async () => {
    const { impl, calls } = fakeFetcher({
      [`${ORIGIN}/`]: ok(html('<a href="/one">1</a>')),
      [`${ORIGIN}/one`]: ok(html('<a href="/two">2</a>')),
      [`${ORIGIN}/two`]: ok(html('<a href="/three">3</a>')),
      [`${ORIGIN}/three`]: ok(html('<h1>3</h1>')),
    });

    await discover(ORIGIN, { fetchImpl: impl, maxDepth: 1 });

    expect(calls).toContain(`${ORIGIN}/one`);
    expect(calls).not.toContain(`${ORIGIN}/three`);
  });

  test('never leaves the origin', async () => {
    const { impl, calls } = fakeFetcher({
      [`${ORIGIN}/`]: ok(html('<a href="https://evil.com/x">e</a><a href="/ok">o</a>')),
      [`${ORIGIN}/ok`]: ok(html('<h1>ok</h1>')),
    });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(calls.some((c) => c.includes('evil.com'))).toBe(false);
    expect(result.urls.some((u) => u.includes('evil.com'))).toBe(false);
  });

  test('reports blocked when the homepage returns a challenge status', async () => {
    const { impl } = fakeFetcher({
      [`${ORIGIN}/`]: {
        url: '',
        status: 403,
        ok: false,
        contentType: 'text/html',
        body: 'forbidden',
        truncated: false,
      },
    });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.status).toBe('blocked');
  });

  test('reports blocked for a 200 interstitial challenge page', async () => {
    const { impl } = fakeFetcher({
      [`${ORIGIN}/`]: ok(html('<h1>Just a moment...</h1><div id="cf-browser-verification"></div>')),
    });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.status).toBe('blocked');
  });

  test('reports blocked when the homepage fetch throws', async () => {
    const impl = (async (url: string) => {
      if (url.endsWith('/robots.txt')) return notFound();
      throw new Error('connection refused');
    }) as unknown as typeof import('./safe-fetch').boundedFetch;

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.status).toBe('blocked');
    expect(result.pagesCrawled).toBe(0);
  });

  test('survives a site with no robots and no sitemap', async () => {
    const { impl } = fakeFetcher({ [`${ORIGIN}/`]: ok(html('<a href="/about">a</a>')) });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.status).toBe('complete');
    expect(result.urls).toContain(`${ORIGIN}/about`);
  });

  test('skips non-html responses during the crawl', async () => {
    const { impl } = fakeFetcher({
      [`${ORIGIN}/`]: ok(html('<a href="/data">d</a>')),
      [`${ORIGIN}/data`]: ok('{"a":1}', 'application/json'),
    });

    const result = await discover(ORIGIN, { fetchImpl: impl });

    expect(result.status).toBe('complete');
    expect(result.signals.title).toBeNull();
  });
});
