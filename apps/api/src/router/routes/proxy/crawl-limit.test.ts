import { describe, expect, test } from 'bun:test';
import type { ProxyServiceConfig } from '../../config/proxy-services';
import { FIRECRAWL_MAX_CRAWL_PAGES, capFirecrawlCrawlLimit } from './crawl-limit';
import { getToolCost } from '../../../config';
import { getProxyServices, matchAllowedRoute } from '../../config/proxy-services';

const firecrawl = { name: 'firecrawl' } as ProxyServiceConfig;
const limitOf = (body: unknown) => JSON.parse(body as string).limit;

describe('capFirecrawlCrawlLimit', () => {
  test('an explicit limit of 10,000 pages is clamped to the cap', () => {
    const headers = new Headers();
    const out = capFirecrawlCrawlLimit(firecrawl, 'POST', '/v1/crawl', JSON.stringify({ url: 'https://example.com', limit: 10_000 }), headers);
    expect(limitOf(out)).toBe(FIRECRAWL_MAX_CRAWL_PAGES);
    expect(headers.get('content-length')).toBe(String(new TextEncoder().encode(out as string).length));
  });

  test('a missing limit (upstream default 10,000) gets the cap', () => {
    expect(limitOf(capFirecrawlCrawlLimit(firecrawl, 'POST', '/v2/crawl', JSON.stringify({ url: 'https://example.com' }), new Headers()))).toBe(100);
  });

  test('a limit under the cap passes through; a non-crawl route is untouched', () => {
    expect(limitOf(capFirecrawlCrawlLimit(firecrawl, 'POST', '/v1/crawl', JSON.stringify({ limit: 7 }), new Headers()))).toBe(7);
    const scrape = JSON.stringify({ url: 'https://example.com' });
    expect(capFirecrawlCrawlLimit(firecrawl, 'POST', '/v1/scrape', scrape, new Headers())).toBe(scrape);
  });
});

describe('Firecrawl crawl billing routes', () => {
  const routes = getProxyServices().firecrawl!.allowedRoutes;

  test('starting a crawl bills $0.015; a status poll bills $0', () => {
    const start = matchAllowedRoute('POST', '/v1/crawl', routes);
    const poll = matchAllowedRoute('GET', '/v1/crawl/abc123', routes);
    expect(getToolCost(start!.billingToolName ?? 'proxy_firecrawl')).toBeCloseTo(0.015, 10);
    expect(getToolCost(poll!.billingToolName ?? 'proxy_firecrawl')).toBe(0);
  });
});
