/**
 * The only way this module reaches the public internet.
 *
 * `safeEgressFetch` already does the security-critical work: it resolves DNS
 * before connecting, rejects any hostname whose records include a private,
 * loopback, link-local, CGNAT or otherwise reserved address, and re-validates
 * every redirect hop so a public URL cannot bounce us to 169.254.169.254.
 * What it deliberately does not do is bound the transfer — it has no timeout
 * and no response size limit, because its other callers fetch small known
 * payloads.
 *
 * Enrichment fetches attacker-chosen URLs in bulk inside a pod with a hard
 * 2 GiB ceiling, so an unbounded read is a liveness problem: one slow-loris
 * host or one multi-gigabyte response would stall or OOM a worker that is
 * also serving HTTP. This wrapper adds the two missing bounds and nothing
 * else — the guard stays the single source of truth for *where* we may go.
 *
 * Note on IP pinning: Bun's fetch does not expose a connect-time IP, so the
 * check is at resolution time rather than pinned to the socket. A rebind in
 * the window between resolve and connect is not closed by this design; every
 * resolved record being public is the strongest guarantee this runtime allows.
 */
import { assertSafeEgressUrl, safeEgressFetch, UnsafeEgressError } from '../../shared/ssrf-guard';

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BYTES = 2_000_000;

export interface BoundedFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  /** Defaults to GET. Firecrawl's scrape endpoint needs POST with a JSON body. */
  method?: string;
  body?: string;
  /** The job-level signal; aborting it cancels the transfer mid-body. */
  signal?: AbortSignal;
}

export interface BoundedResponse {
  url: string;
  status: number;
  ok: boolean;
  contentType: string | null;
  body: string;
  /** True when the response was cut off at `maxBytes`. */
  truncated: boolean;
}

export class FetchTimeoutError extends Error {
  constructor(readonly url: string, readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms: ${url}`);
    this.name = 'FetchTimeoutError';
  }
}

/**
 * Validate a URL against the egress guard without fetching it. Every URL the
 * pipeline discovers — sitemap entries, page links, Jina targets — passes
 * through here or through {@link boundedFetch} before it is used.
 */
export async function assertSafeUrl(rawUrl: string): Promise<URL> {
  return assertSafeEgressUrl(rawUrl);
}

export function isUnsafeUrlError(err: unknown): err is UnsafeEgressError {
  return err instanceof UnsafeEgressError;
}

/**
 * Read at most `maxBytes` of the body, then stop. Reading incrementally (rather
 * than trusting Content-Length) is what actually protects us: a hostile or
 * misconfigured server can under-report or omit that header entirely.
 */
async function readBounded(
  res: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  if (!res.body) return { body: await res.text(), truncated: false };

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let truncated = false;
  let body = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const remaining = maxBytes - received;
      if (value.byteLength >= remaining) {
        body += decoder.decode(value.subarray(0, remaining), { stream: false });
        truncated = true;
        break;
      }
      received += value.byteLength;
      body += decoder.decode(value, { stream: true });
    }
    if (!truncated) body += decoder.decode();
  } finally {
    // Releases the connection whether we finished or bailed at the cap.
    await reader.cancel().catch(() => {});
  }

  return { body, truncated };
}

/**
 * SSRF-guarded fetch with a wall-clock timeout and a response size cap.
 *
 * Any HTTP status is returned to the caller (a 403 is how we detect a
 * challenge page, not an exception); only transport failures, timeouts and
 * guard rejections throw.
 */
export async function boundedFetch(
  rawUrl: string,
  opts: BoundedFetchOptions = {},
): Promise<BoundedResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const onOuterAbort = () => timeoutController.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });

  try {
    const res = await safeEgressFetch(rawUrl, {
      method: opts.method,
      body: opts.body,
      headers: opts.headers,
      signal: timeoutController.signal,
      redirect: 'manual',
    });
    const { body, truncated } = await readBounded(res, maxBytes);
    return {
      url: rawUrl,
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      contentType: res.headers.get('content-type'),
      body,
      truncated,
    };
  } catch (err) {
    // Classify by our own signal rather than the error's name: a torn-down
    // transfer surfaces as AbortError, TimeoutError or a plain stream error
    // depending on where it was interrupted, but the signal tells us
    // unambiguously that the deadline (not the peer) ended this request.
    if (timeoutController.signal.aborted) {
      if (opts.signal?.aborted) throw err; // the caller cancelled, not the clock
      throw new FetchTimeoutError(rawUrl, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}
