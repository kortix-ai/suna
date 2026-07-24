/**
 * Discovery — find the pages worth reading, and harvest what the site already
 * states about itself in machine-readable form.
 *
 * Two ideas drive the shape here:
 *
 * 1. A sitemap, when it exists, is a better index than any crawl: it is
 *    authoritative, complete, and free of navigation noise. So we try it first
 *    and only fall back to a breadth-first walk when it does not yield real
 *    company pages.
 * 2. Page bodies are NOT kept. Discovery returns URLs plus structured signals
 *    (JSON-LD, OpenGraph, meta, harvested outbound links) and nothing else;
 *    readable page content comes later from Jina Reader, which renders
 *    JavaScript that this HTML-only pass cannot. Keeping bodies here would
 *    double memory for no benefit.
 *
 * JSON-LD in particular is worth more than the prose around it: a site that
 * publishes a schema.org Organization block is telling us its legal name,
 * logo, founders and social profiles as data, so the extraction step can treat
 * those as ground truth instead of inferring them. Outbound links (see
 * `./links`) cover the case JSON-LD does not: a personal site with no schema.org
 * markup at all, whose only machine-readable claim about its owner is the
 * X/GitHub/LinkedIn links in its own nav or footer.
 */
import * as cheerio from 'cheerio';
import robotsParser, { type Robot } from 'robots-parser';
import { harvestLinks, mergeLinkHarvest, type SocialLink } from './links';
import { boundedFetch, isUnsafeUrlError } from './safe-fetch';
import { isSameOrigin, normalizeUrl } from './url-filter';

export const MAX_CRAWL_PAGES = 40;
export const MAX_CRAWL_DEPTH = 2;
const MAX_SITEMAPS = 5;
const MAX_SITEMAP_URLS = 500;
const USER_AGENT = 'KortixEnrichmentBot';

export interface StructuredSignals {
  title: string | null;
  jsonLd: unknown[];
  openGraph: Record<string, string>;
  meta: Record<string, string>;
  /** Outbound links harvested deterministically — see `./links`. */
  socials: SocialLink[];
  emails: string[];
  phones: string[];
  otherExternal: string[];
}

export interface DiscoveryResult {
  urls: string[];
  signals: StructuredSignals;
  /** `blocked` means the site refused us, not that it has no content. */
  status: 'complete' | 'blocked';
  pagesCrawled: number;
  usedSitemap: boolean;
}

export interface DiscoveryOptions {
  signal?: AbortSignal;
  maxPages?: number;
  maxDepth?: number;
  /** Injected in tests; defaults to the SSRF-guarded bounded fetcher. */
  fetchImpl?: typeof boundedFetch;
}

// Text that a bot-wall serves instead of the page. Checked only when a status
// is already suspicious, so a company that merely writes about CAPTCHAs is not
// mistaken for a challenge page.
const CHALLENGE_MARKERS = [
  'cf-browser-verification',
  'just a moment...',
  'attention required!',
  'checking your browser',
  'ddos protection by',
  'px-captcha',
];

function emptySignals(): StructuredSignals {
  return {
    title: null,
    jsonLd: [],
    openGraph: {},
    meta: {},
    socials: [],
    emails: [],
    phones: [],
    otherExternal: [],
  };
}

function looksBlocked(status: number, body: string): boolean {
  if (status === 401 || status === 403 || status === 429) return true;
  if (status !== 503 && status < 200) return false;
  if (status === 503 || status === 200) {
    const haystack = body.slice(0, 4000).toLowerCase();
    return CHALLENGE_MARKERS.some((marker) => haystack.includes(marker));
  }
  return false;
}

/** Merge signals from a page into the accumulator, first value winning. */
function mergeSignals(into: StructuredSignals, from: StructuredSignals): void {
  into.title ??= from.title;
  into.jsonLd.push(...from.jsonLd);
  for (const [k, v] of Object.entries(from.openGraph)) into.openGraph[k] ??= v;
  for (const [k, v] of Object.entries(from.meta)) into.meta[k] ??= v;
}

export function extractSignals(html: string): StructuredSignals {
  const signals = emptySignals();
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return signals;
  }

  signals.title = $('title').first().text().trim() || null;

  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text().trim();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw);
      // A page may publish `@graph` containing several typed nodes.
      const nodes = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { '@graph'?: unknown[] })['@graph'])
          ? (parsed as { '@graph': unknown[] })['@graph']
          : [parsed];
      signals.jsonLd.push(...nodes);
    } catch {
      // Malformed JSON-LD is common and never fatal — skip this block.
    }
  });

  $('meta').each((_, el) => {
    const property = $(el).attr('property')?.toLowerCase();
    const name = $(el).attr('name')?.toLowerCase();
    const content = $(el).attr('content')?.trim();
    if (!content) return;
    if (property?.startsWith('og:')) signals.openGraph[property.slice(3)] ??= content;
    else if (name) signals.meta[name] ??= content;
  });

  return signals;
}

export function extractLinks(html: string, pageUrl: string): string[] {
  let $: cheerio.CheerioAPI;
  try {
    $ = cheerio.load(html);
  } catch {
    return [];
  }
  const found: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    const normalized = normalizeUrl(href, pageUrl);
    if (normalized) found.push(normalized);
  });
  return found;
}

/** Pull `<loc>` values out of a sitemap or sitemap index. */
export function parseSitemap(xml: string): { urls: string[]; sitemaps: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  return isIndex ? { urls: [], sitemaps: locs } : { urls: locs, sitemaps: [] };
}

async function fetchRobots(
  origin: string,
  fetcher: typeof boundedFetch,
  signal?: AbortSignal,
): Promise<Robot | null> {
  try {
    const res = await fetcher(`${origin}/robots.txt`, { signal, maxBytes: 512_000 });
    if (!res.ok) return null;
    return robotsParser(`${origin}/robots.txt`, res.body);
  } catch {
    // No robots.txt, or it failed to load — the permissive default. We still
    // stay inside the page budget and same-origin rules.
    return null;
  }
}

async function collectSitemapUrls(
  origin: string,
  robots: Robot | null,
  fetcher: typeof boundedFetch,
  signal?: AbortSignal,
): Promise<string[]> {
  const queue = (robots?.getSitemaps?.() ?? []).slice(0, MAX_SITEMAPS);
  if (queue.length === 0) queue.push(`${origin}/sitemap.xml`);

  const collected: string[] = [];
  const visited = new Set<string>();
  let fetched = 0;

  while (queue.length > 0 && fetched < MAX_SITEMAPS && collected.length < MAX_SITEMAP_URLS) {
    const next = queue.shift();
    if (!next || visited.has(next)) continue;
    visited.add(next);
    if (!isSameOrigin(next, origin)) continue;

    try {
      const res = await fetcher(next, { signal, maxBytes: 5_000_000 });
      fetched += 1;
      if (!res.ok) continue;
      const { urls, sitemaps } = parseSitemap(res.body);
      collected.push(...urls);
      queue.push(...sitemaps);
    } catch (err) {
      if (isUnsafeUrlError(err)) continue;
      // A missing or malformed sitemap is not an error; the crawl fallback
      // covers it.
      continue;
    }
  }

  return collected.slice(0, MAX_SITEMAP_URLS);
}

/**
 * Breadth-first walk from the homepage. Bounded on three axes at once (depth,
 * pages fetched, same-origin) so a site with generated URLs cannot turn one
 * job into an unbounded crawl.
 */
async function crawl(
  origin: string,
  robots: Robot | null,
  fetcher: typeof boundedFetch,
  opts: { maxPages: number; maxDepth: number; signal?: AbortSignal },
  signals: StructuredSignals,
  seedHtml: string | null,
): Promise<{ urls: string[]; pagesCrawled: number }> {
  const discovered = new Set<string>([`${origin}/`]);
  const visited = new Set<string>();
  let pagesCrawled = 0;

  const queue: Array<{ url: string; depth: number }> = [];

  if (seedHtml !== null) {
    // The homepage was already fetched for signals; reuse it rather than
    // paying for the same page twice.
    visited.add(`${origin}/`);
    pagesCrawled = 1;
    for (const link of extractLinks(seedHtml, `${origin}/`)) {
      if (!isSameOrigin(link, origin)) continue;
      discovered.add(link);
      queue.push({ url: link, depth: 1 });
    }
  } else {
    queue.push({ url: `${origin}/`, depth: 0 });
  }

  while (queue.length > 0 && pagesCrawled < opts.maxPages) {
    if (opts.signal?.aborted) break;
    const current = queue.shift();
    if (!current) break;
    if (visited.has(current.url)) continue;
    if (current.depth > opts.maxDepth) continue;
    if (robots && robots.isAllowed(current.url, USER_AGENT) === false) continue;

    visited.add(current.url);

    let html: string;
    try {
      const res = await fetcher(current.url, { signal: opts.signal });
      pagesCrawled += 1;
      if (!res.ok) continue;
      if (!(res.contentType ?? '').includes('html')) continue;
      html = res.body;
    } catch {
      // One unreachable page never fails discovery.
      continue;
    }

    mergeSignals(signals, extractSignals(html));
    mergeLinkHarvest(signals, harvestLinks(html, current.url));

    if (current.depth >= opts.maxDepth) continue;
    for (const link of extractLinks(html, current.url)) {
      if (!isSameOrigin(link, origin)) continue;
      if (discovered.has(link)) continue;
      discovered.add(link);
      queue.push({ url: link, depth: current.depth + 1 });
    }
  }

  return { urls: [...discovered], pagesCrawled };
}

/**
 * Decide whether the sitemap alone is a good enough index. It is only trusted
 * when it surfaces a real company page beyond the homepage — a sitemap listing
 * nothing but blog posts tells us little about the company itself, so we still
 * crawl in that case.
 */
export function sitemapIsSufficient(urls: string[], origin: string): boolean {
  return urls.some((url) => {
    if (!isSameOrigin(url, origin)) return false;
    try {
      const path = new URL(url).pathname.toLowerCase().replace(/\/+$/, '');
      if (!path) return false;
      return /^\/(about|team|company|pricing|product|products|platform|features|contact|customers|who-we-are|leadership)/
        .test(path);
    } catch {
      return false;
    }
  });
}

/**
 * Entry point: returns candidate URLs plus harvested signals. Never throws for
 * an unreachable site — an unusable result comes back as `status: 'blocked'`
 * so the caller can still build a partial profile.
 */
export async function discover(
  origin: string,
  opts: DiscoveryOptions = {},
): Promise<DiscoveryResult> {
  const fetcher = opts.fetchImpl ?? boundedFetch;
  const maxPages = opts.maxPages ?? MAX_CRAWL_PAGES;
  const maxDepth = opts.maxDepth ?? MAX_CRAWL_DEPTH;
  const signals = emptySignals();

  const robots = await fetchRobots(origin, fetcher, opts.signal);

  // The homepage is fetched first no matter which path we take: it is the one
  // page that reliably carries the company's own description and JSON-LD.
  let homepageHtml: string | null = null;
  let blocked = false;
  try {
    const res = await fetcher(`${origin}/`, { signal: opts.signal });
    if (looksBlocked(res.status, res.body)) {
      blocked = true;
    } else if (res.ok) {
      homepageHtml = res.body;
      mergeSignals(signals, extractSignals(res.body));
      mergeLinkHarvest(signals, harvestLinks(res.body, `${origin}/`));
    }
  } catch {
    blocked = true;
  }

  const sitemapUrls = await collectSitemapUrls(origin, robots, fetcher, opts.signal);
  const allowed = (url: string) => !robots || robots.isAllowed(url, USER_AGENT) !== false;
  const usableSitemapUrls = sitemapUrls.filter((url) => isSameOrigin(url, origin) && allowed(url));

  if (usableSitemapUrls.length > 0 && sitemapIsSufficient(usableSitemapUrls, origin)) {
    return {
      urls: [`${origin}/`, ...usableSitemapUrls],
      signals,
      status: blocked && !homepageHtml ? 'blocked' : 'complete',
      pagesCrawled: homepageHtml ? 1 : 0,
      usedSitemap: true,
    };
  }

  if (blocked && !homepageHtml) {
    return {
      urls: usableSitemapUrls,
      signals,
      status: 'blocked',
      pagesCrawled: 0,
      usedSitemap: usableSitemapUrls.length > 0,
    };
  }

  const { urls, pagesCrawled } = await crawl(
    origin,
    robots,
    fetcher,
    { maxPages, maxDepth, signal: opts.signal },
    signals,
    homepageHtml,
  );

  return {
    urls: [...new Set([...urls, ...usableSitemapUrls])],
    signals,
    status: 'complete',
    pagesCrawled,
    usedSitemap: false,
  };
}
