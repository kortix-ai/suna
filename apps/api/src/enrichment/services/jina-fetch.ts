/**
 * Page fetching via Jina Reader.
 *
 * Reader renders JavaScript and returns clean markdown, which is why the
 * pipeline has no browser tier: the API pod has no browser binaries and no
 * memory headroom for one. The cost is that every page is an outbound call to
 * a third party with its own rate limit, so this module is mostly about
 * spending that budget carefully.
 *
 * Three bounds apply at once. Per-job concurrency keeps one enrichment from
 * monopolising the connection pool. A shared token bucket caps total outbound
 * requests per minute across every job in the process — and because the worker
 * only runs on the leader replica, process-wide is effectively deployment-wide.
 * A per-URL timeout stops one unresponsive page from consuming the job's whole
 * wall-clock budget.
 *
 * Failure here is never fatal. A page that times out, errors or comes back
 * empty is skipped; a profile built from nine of ten pages is worth far more
 * than a failed job.
 */
import { assertSafeUrl, boundedFetch, isUnsafeUrlError } from './safe-fetch';

const JINA_READER_BASE = 'https://r.jina.ai/';

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_PAGE_TIMEOUT_MS = 15_000;
export const DEFAULT_RPM = 60;
const MAX_PAGE_BYTES = 1_000_000;

export interface FetchedPage {
  url: string;
  markdown: string;
  fromCache: boolean;
}

export interface PageCachePort {
  get(urls: string[]): Promise<Map<string, string>>;
  put(url: string, markdown: string): Promise<void>;
}

export interface FetchPagesOptions {
  apiKey?: string;
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

async function fetchOne(
  url: string,
  opts: FetchPagesOptions,
  limiter: RateLimiter,
  fetcher: typeof boundedFetch,
): Promise<string> {
  // The target is re-validated even though discovery already checked it: DNS
  // can change between the two, and this is the last point before the URL
  // leaves our process.
  await (opts.assertUrl ?? assertSafeUrl)(url);

  const headers: Record<string, string> = { accept: 'text/plain' };
  if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;

  const attempt = async (): Promise<string> => {
    await limiter.acquire();
    const res = await fetcher(readerUrl(url), {
      headers,
      timeoutMs: opts.timeoutMs ?? DEFAULT_PAGE_TIMEOUT_MS,
      maxBytes: MAX_PAGE_BYTES,
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`reader returned ${res.status}`);
    const markdown = res.body.trim();
    if (!markdown) throw new Error('reader returned an empty document');
    return markdown;
  };

  try {
    return await attempt();
  } catch (err) {
    // One retry: Reader is occasionally flaky on first contact with a slow
    // origin. A guard rejection is not retried — it will fail identically.
    if (isUnsafeUrlError(err) || opts.signal?.aborted) throw err;
    return attempt();
  }
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
    results.set(url, { url, markdown, fromCache: true });
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
        const markdown = await fetchOne(url, opts, limiter, fetcher);
        results.set(url, { url, markdown, fromCache: false });
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
