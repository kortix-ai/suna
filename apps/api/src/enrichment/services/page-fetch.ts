/**
 * Page fetching via a tiered fallback chain.
 *
 * A single vendor with no fallback is a single point of failure: when Jina
 * Reader's account runs dry (HTTP 402), every page fetch fails identically and
 * a profile built from zero pages is empty rather than degraded. Three tiers —
 * Jina Reader, then Firecrawl, then a direct fetch converted to markdown in
 * this process — mean a vendor outage costs quality, not the whole page.
 * `direct` never needs a key and is never skipped, so it is the floor: at
 * worst every fetch lands there and profiles keep flowing off site HTML alone.
 * The tier that actually served a page is returned with it, so a run leaning
 * on `direct` is visible in the data rather than mysterious.
 *
 * Three bounds apply at once, unchanged by the extra tiers. Per-job
 * concurrency keeps one enrichment from monopolising the connection pool. A
 * shared token bucket caps total outbound requests per minute across every job
 * in the process — and because the worker only runs on the leader replica,
 * process-wide is effectively deployment-wide. A per-URL timeout stops one
 * unresponsive page from consuming the job's whole wall-clock budget.
 *
 * Failure here is never fatal. A page whose every tier times out, errors or
 * comes back empty is skipped; a profile built from nine of ten pages is worth
 * far more than a failed job.
 */
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import { assertSafeUrl, boundedFetch, isUnsafeUrlError } from './safe-fetch';

const JINA_READER_BASE = 'https://r.jina.ai/';
const FIRECRAWL_SCRAPE_PATH = '/v1/scrape';
const DEFAULT_FIRECRAWL_API_URL = 'https://api.firecrawl.dev';

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_PAGE_TIMEOUT_MS = 15_000;
export const DEFAULT_RPM = 60;
const MAX_PAGE_BYTES = 1_000_000;

// Chrome that is never company content: turndown would otherwise render nav
// links, inline scripts/styles and decorative svg as noise in the markdown.
const STRIP_SELECTOR = 'script, style, nav, footer, svg, noscript';

export type PageFetchTier = 'jina' | 'firecrawl' | 'direct' | 'cache';

export interface FetchedPage {
  url: string;
  markdown: string;
  /** Which tier actually served this page, or 'cache' for a cache hit. */
  tier: PageFetchTier;
  fromCache: boolean;
}

export interface PageCachePort {
  get(urls: string[]): Promise<Map<string, string>>;
  put(url: string, markdown: string): Promise<void>;
}

export interface FetchPagesOptions {
  jinaApiKey?: string;
  firecrawlApiKey?: string;
  firecrawlApiUrl?: string;
  concurrency?: number;
  timeoutMs?: number;
  rpm?: number;
  signal?: AbortSignal;
  cache?: PageCachePort;
  fetchImpl?: typeof boundedFetch;
  /** The final egress check before a URL leaves the process. */
  assertUrl?: typeof assertSafeUrl;
  /** Injected in tests to keep rate-limit behaviour deterministic. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FetchPagesResult {
  pages: FetchedPage[];
  failures: Array<{ url: string; reason: string }>;
}

/**
 * Refill-style token bucket shared by every job in the process. `acquire`
 * waits rather than rejecting: the queue is small and bounded by the page cap,
 * and a job that waits a moment is better than one that drops pages.
 */
export class RateLimiter {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly perMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.tokens = Math.max(1, perMinute);
    this.lastRefill = now();
  }

  private refill(): void {
    const elapsed = this.now() - this.lastRefill;
    if (elapsed <= 0) return;
    const refilled = (elapsed / 60_000) * this.perMinute;
    if (refilled >= 1) {
      this.tokens = Math.min(this.perMinute, this.tokens + Math.floor(refilled));
      this.lastRefill = this.now();
    }
  }

  async acquire(): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      // Time until one token is worth waiting for.
      await this.sleep(Math.ceil(60_000 / this.perMinute));
    }
  }
}

let sharedLimiter: RateLimiter | null = null;
let sharedLimiterRpm = 0;

function limiterFor(rpm: number, now?: () => number, sleep?: (ms: number) => Promise<void>) {
  // Tests pass their own clock; production shares one bucket per process.
  if (now || sleep) return new RateLimiter(rpm, now, sleep);
  if (!sharedLimiter || sharedLimiterRpm !== rpm) {
    sharedLimiter = new RateLimiter(rpm);
    sharedLimiterRpm = rpm;
  }
  return sharedLimiter;
}

export function readerUrl(target: string): string {
  return `${JINA_READER_BASE}${target}`;
}

/**
 * Strip non-content chrome, prefer `main`/`article` when the page marks one,
 * and hand what remains to turndown. Run against the whole document (rather
 * than bailing when there is no `main`) so ordinary sites without semantic
 * landmarks still convert.
 */
export function htmlToMarkdown(html: string): string {
  const $ = cheerio.load(html);
  $(STRIP_SELECTOR).remove();
  const main = $('main').first();
  const article = $('article').first();
  const root = main.length ? main : article.length ? article : $('body');
  const turndown = new TurndownService({ headingStyle: 'atx' });
  return turndown.turndown(root.html() ?? '').trim();
}

interface TierContext {
  opts: FetchPagesOptions;
  fetcher: typeof boundedFetch;
  limiter: RateLimiter;
  assertUrl: typeof assertSafeUrl;
  timeoutMs: number;
}

async function viaJina(url: string, ctx: TierContext): Promise<string> {
  // The guard runs immediately before the request leaves the process: DNS can
  // change between discovery and now, and again between one tier and the next.
  await ctx.assertUrl(url);
  await ctx.limiter.acquire();
  const res = await ctx.fetcher(readerUrl(url), {
    headers: { accept: 'text/plain', authorization: `Bearer ${ctx.opts.jinaApiKey}` },
    timeoutMs: ctx.timeoutMs,
    maxBytes: MAX_PAGE_BYTES,
    signal: ctx.opts.signal,
  });
  if (!res.ok) throw new Error(`jina reader returned ${res.status}`);
  const markdown = res.body.trim();
  if (!markdown) throw new Error('jina reader returned an empty document');
  return markdown;
}

async function viaFirecrawl(url: string, ctx: TierContext): Promise<string> {
  await ctx.assertUrl(url);
  await ctx.limiter.acquire();
  const base = ctx.opts.firecrawlApiUrl ?? DEFAULT_FIRECRAWL_API_URL;
  const res = await ctx.fetcher(`${base}${FIRECRAWL_SCRAPE_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.opts.firecrawlApiKey}`,
    },
    body: JSON.stringify({ url, formats: ['markdown'] }),
    timeoutMs: ctx.timeoutMs,
    maxBytes: MAX_PAGE_BYTES,
    signal: ctx.opts.signal,
  });
  if (!res.ok) throw new Error(`firecrawl returned ${res.status}`);
  let markdown = '';
  try {
    const parsed = JSON.parse(res.body) as { data?: { markdown?: string | null } };
    markdown = (parsed.data?.markdown ?? '').trim();
  } catch {
    // A body that is not JSON (an HTML error page from a proxy in front of
    // Firecrawl, say) is exactly as unusable as an empty document below.
  }
  if (!markdown) throw new Error('firecrawl returned an empty document');
  return markdown;
}

async function viaDirect(url: string, ctx: TierContext): Promise<string> {
  await ctx.assertUrl(url);
  await ctx.limiter.acquire();
  const res = await ctx.fetcher(url, {
    headers: { accept: 'text/html' },
    timeoutMs: ctx.timeoutMs,
    maxBytes: MAX_PAGE_BYTES,
    signal: ctx.opts.signal,
  });
  if (!res.ok) throw new Error(`direct fetch returned ${res.status}`);
  const markdown = htmlToMarkdown(res.body);
  if (!markdown) throw new Error('direct fetch returned an empty document');
  return markdown;
}

type TierName = Exclude<PageFetchTier, 'cache'>;

const TIERS: Array<{
  name: TierName;
  enabled: (opts: FetchPagesOptions) => boolean;
  run: (url: string, ctx: TierContext) => Promise<string>;
}> = [
  { name: 'jina', enabled: (opts) => !!opts.jinaApiKey, run: viaJina },
  { name: 'firecrawl', enabled: (opts) => !!opts.firecrawlApiKey, run: viaFirecrawl },
  { name: 'direct', enabled: () => true, run: viaDirect },
];

/**
 * Try one tier with a single retry. A guard rejection is not retried — it
 * will fail identically — and neither is a job-level abort.
 */
async function attemptWithRetry(
  url: string,
  ctx: TierContext,
  run: (url: string, ctx: TierContext) => Promise<string>,
): Promise<string> {
  try {
    return await run(url, ctx);
  } catch (err) {
    if (isUnsafeUrlError(err) || ctx.opts.signal?.aborted) throw err;
    return run(url, ctx);
  }
}

async function fetchOne(
  url: string,
  opts: FetchPagesOptions,
  limiter: RateLimiter,
  fetcher: typeof boundedFetch,
): Promise<{ markdown: string; tier: TierName }> {
  const ctx: TierContext = {
    opts,
    fetcher,
    limiter,
    assertUrl: opts.assertUrl ?? assertSafeUrl,
    timeoutMs: opts.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
  };

  let lastErr: unknown;
  for (const tier of TIERS) {
    if (!tier.enabled(opts)) continue;
    try {
      const markdown = await attemptWithRetry(url, ctx, tier.run);
      return { markdown, tier: tier.name };
    } catch (err) {
      // An unsafe-url verdict is about the URL, not the vendor: every
      // remaining tier would reject it identically, so stop right away.
      if (isUnsafeUrlError(err)) throw err;
      lastErr = err;
      if (opts.signal?.aborted) throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'no tier available'));
}

/**
 * Fetch every URL, honouring the cache, and return what succeeded. Ordering of
 * the input is preserved in the output so downstream ranking survives.
 */
export async function fetchPages(
  urls: string[],
  opts: FetchPagesOptions = {},
): Promise<FetchPagesResult> {
  const unique = [...new Set(urls)];
  if (unique.length === 0) return { pages: [], failures: [] };

  const cached = opts.cache ? await opts.cache.get(unique) : new Map<string, string>();
  const fetcher = opts.fetchImpl ?? boundedFetch;
  const limiter = limiterFor(opts.rpm ?? DEFAULT_RPM, opts.now, opts.sleep);
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);

  const results = new Map<string, FetchedPage>();
  const failures: Array<{ url: string; reason: string }> = [];
  const pending = unique.filter((url) => !cached.has(url));

  for (const [url, markdown] of cached) {
    results.set(url, { url, markdown, tier: 'cache', fromCache: true });
  }

  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= pending.length) return;
      const url = pending[index];
      try {
        const { markdown, tier } = await fetchOne(url, opts, limiter, fetcher);
        results.set(url, { url, markdown, tier, fromCache: false });
        // A cache write must never take down a fetch that already succeeded.
        await opts.cache?.put(url, markdown).catch(() => {});
      } catch (err) {
        failures.push({ url, reason: err instanceof Error ? err.message : String(err) });
      }
    }
  });

  await Promise.all(workers);

  return {
    pages: unique.map((url) => results.get(url)).filter((page): page is FetchedPage => !!page),
    failures,
  };
}
