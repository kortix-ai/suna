/**
 * The model-catalog response, on the wire.
 *
 * WHY THIS EXISTS
 * `/models` is the biggest response this gateway serves — ~3.3MB of JSON for a
 * project's full catalog — and its most latency-sensitive consumer is a sandbox
 * in another region fetching it at boot. Uncompressed, that fetch needs a budget
 * so large it stops being a background task; compressed it is ~300KB, which
 * lands comfortably inside a background prefetch. The sandbox's model reconcile
 * depends on that fetch landing, and the reconcile is what keeps OpenCode's
 * provider map from answering `ModelNotFound` (prod incident 2026-08-19).
 *
 * JSON of this shape (thousands of near-identical model records) compresses
 * roughly 10:1, so this is the single cheapest change available on that path.
 *
 * Bun's `fetch` sends `Accept-Encoding` by default and decompresses the response
 * transparently, so every existing client gets the smaller body with no change.
 * A client that asks for `identity` still gets plain JSON.
 */

/** Below this, the gzip header + trailer cost more than the saving. */
const MIN_COMPRESS_BYTES = 1024;

function acceptsGzip(acceptEncoding: string | undefined | null): boolean {
  if (!acceptEncoding) return false;
  // `gzip;q=0` is an explicit refusal, not an offer.
  return /(^|,)\s*gzip\s*(;\s*q=\s*(?!0(\.0+)?\s*(,|$))[^,]*)?\s*(,|$)/i.test(acceptEncoding);
}

/** FNV-1a over the body. Cheap (one pass, no allocation) and only ever used to
 *  tell two catalog revisions apart — never as a security primitive. */
function weakHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export interface CatalogResponseOptions {
  /** The request's `Accept-Encoding`. Absent/identity ⇒ plain JSON. */
  acceptEncoding?: string | null;
  /** The request's `If-None-Match`. A match returns 304 with no body. */
  ifNoneMatch?: string | null;
  /** Extra response headers (content-type is set here). */
  headers?: Record<string, string>;
}

/**
 * Serialize + conditionally gzip a catalog payload.
 *
 * Always sets `ETag` and `Cache-Control: private, max-age=60`. `private` is
 * mandatory: the catalog is per-principal (managed vs BYOK vs free tier), so a
 * shared cache must never serve one account's catalog to another. `Vary:
 * Accept-Encoding` is set on every response, compressed or not, so a cache
 * cannot hand a gzip body to a client that asked for identity.
 */
export function catalogJsonResponse(payload: unknown, opts: CatalogResponseOptions = {}): Response {
  const body = JSON.stringify(payload);
  const etag = `W/"${weakHash(body)}-${body.length.toString(36)}"`;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'cache-control': 'private, max-age=60',
    vary: 'accept-encoding',
    etag,
    ...(opts.headers ?? {}),
  };

  if (opts.ifNoneMatch && etagMatches(opts.ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers });
  }

  if (body.length < MIN_COMPRESS_BYTES || !acceptsGzip(opts.acceptEncoding)) {
    return new Response(body, { status: 200, headers });
  }

  // Streamed rather than buffered: the compressor never holds a second full
  // copy of a multi-megabyte catalog in memory.
  const gzipped = new Response(body).body!.pipeThrough(new CompressionStream('gzip'));
  return new Response(gzipped, {
    status: 200,
    headers: { ...headers, 'content-encoding': 'gzip' },
  });
}

/** `If-None-Match` is a comma-separated list, and `W/` is not significant here. */
function etagMatches(ifNoneMatch: string, etag: string): boolean {
  const normalize = (value: string) => value.trim().replace(/^W\//, '');
  const wanted = normalize(etag);
  return ifNoneMatch.split(',').some((candidate) => normalize(candidate) === wanted);
}

/**
 * Gzip a body a reverse proxy is about to relay, when the client asked for it.
 *
 * Needed because a proxy built on `fetch` receives an ALREADY-DECOMPRESSED body:
 * the runtime transparently inflates the upstream response but copies the
 * upstream's `Content-Encoding: gzip` header verbatim, which relabels plain
 * bytes as gzip and makes the next client fail with a zlib error. The fix is to
 * drop that stale header (see `sanitizeRelayedHeaders`) and, for a catalog-sized
 * JSON body, compress it again here for the hop that actually matters — the
 * cross-region one to the sandbox.
 */
export function gzipRelayedBody(
  body: ArrayBuffer,
  acceptEncoding: string | undefined | null,
): { body: ArrayBuffer | ReadableStream<Uint8Array>; contentEncoding: string | null } {
  if (body.byteLength < MIN_COMPRESS_BYTES || !acceptsGzip(acceptEncoding)) {
    return { body, contentEncoding: null };
  }
  const stream = new Response(body).body!.pipeThrough(new CompressionStream('gzip'));
  return { body: stream, contentEncoding: 'gzip' };
}

/**
 * Strip the response headers that describe bytes a `fetch`-based relay no longer
 * holds. `content-encoding` is the dangerous one — see `gzipRelayedBody`.
 */
export function sanitizeRelayedHeaders(upstream: Headers): Headers {
  const headers = new Headers(upstream);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  return headers;
}
