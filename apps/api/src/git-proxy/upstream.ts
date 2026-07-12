/**
 * Upstream fetch helpers for the git proxy — isolated from `index.ts` (which
 * boots the OpenAPI app on import) so they stay trivially unit-testable with no
 * DB/network/app deps.
 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bun fetch errors thrown when an upstream socket drops mid-request or
 * mid-stream. These are transient (upstream/network), so for idempotent
 * requests we retry instead of surfacing them as 5xx / unhandled errors.
 */
const TRANSIENT_UPSTREAM_RE =
  /socket connection was closed|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|other side closed|connection reset|UND_ERR_SOCKET/i;

/** Is `err` a transient upstream socket/network error worth retrying? */
export function isTransientUpstreamError(err: unknown): boolean {
  return TRANSIENT_UPSTREAM_RE.test(err instanceof Error ? err.message : String(err));
}

/**
 * Fetch the git upstream, BUFFERING the (small) response body inside a bounded
 * retry loop. Used ONLY for idempotent ref discovery (`GET /info/refs`), whose
 * body is a tiny pkt-line ref list — buffering it lets a transient mid-stream
 * upstream socket-close be caught + retried HERE, instead of escaping Bun's
 * fetch streamer (when `res.body` is later piped to the client) to the global
 * uncaught-exception handler. That escape was Better Stack pattern `df7a31d4…`
 * ("The socket connection was closed unexpectedly. For more information, pass
 * `verbose: true` in the second argument to fetch()"), a prod one-off with no
 * source frame because it threw outside any route try/catch.
 *
 * On exhaustion the last error is rethrown; the caller's try/catch surfaces a
 * clean 502. Pack-stream endpoints (`/git-upload-pack`, `/git-receive-pack`)
 * are NOT buffered or retried — their bodies can be large / non-idempotent —
 * and stay on the streamed single-fetch path in `forward()`.
 */
export async function fetchUpstreamBuffered(
  target: string,
  init: RequestInit,
  opts: {
    retries?: number;
    fetchImpl?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const doFetch = opts.fetchImpl ?? fetch;
  const doSleep = opts.sleepFn ?? sleep;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await doFetch(target, init);
      // Buffer the small ref-discovery body so a mid-stream socket close is
      // thrown here (retriable) rather than when Bun streams res.body later.
      const buf = new Uint8Array(await res.arrayBuffer());
      return new Response(buf, { status: res.status, headers: res.headers });
    } catch (err) {
      lastErr = err;
      if (!isTransientUpstreamError(err) || attempt === retries) break;
      // bounded backoff: 250ms, 500ms, …
      await doSleep(250 * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
