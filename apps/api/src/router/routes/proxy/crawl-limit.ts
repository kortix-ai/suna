import type { ProxyServiceConfig } from '../../config/proxy-services';

/**
 * Upper bound on the pages one managed Firecrawl crawl may fetch. A crawl costs
 * one upstream credit per page but is billed as one flat request, so an
 * unbounded `limit` (the upstream default is 10,000) lets one call spend far
 * more than it pays. A lower or equal `limit` passes through unchanged.
 */
export const FIRECRAWL_MAX_CRAWL_PAGES = 100;

/** Clamp `limit` on a managed Firecrawl `POST …/crawl` body; any other request is returned as is. */
export function capFirecrawlCrawlLimit(
  service: ProxyServiceConfig,
  method: string,
  subPath: string,
  body: ArrayBuffer | string | undefined,
  headers: Headers,
): ArrayBuffer | string | undefined {
  if (service.name !== 'firecrawl' || method.toUpperCase() !== 'POST' || !body) return body;
  if (!/^\/v[12]\/crawl\/?$/.test(subPath.split('?')[0]!)) return body;
  try {
    const json = JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body));
    const requested = Number(json.limit);
    json.limit =
      Number.isFinite(requested) && requested > 0
        ? Math.min(Math.floor(requested), FIRECRAWL_MAX_CRAWL_PAGES)
        : FIRECRAWL_MAX_CRAWL_PAGES;
    const next = JSON.stringify(json);
    headers.set('Content-Length', new TextEncoder().encode(next).length.toString());
    return next;
  } catch {
    return body; // no JSON body: the upstream rejects it
  }
}
