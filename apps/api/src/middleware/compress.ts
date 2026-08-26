/**
 * Response compression for the API.
 *
 * ─── Why (measured, 2026-08-26) ─────────────────────────────────────────────
 * The API shipped every response as raw bytes: a request carrying
 * `accept-encoding: gzip` got back exactly as many bytes as one carrying none.
 * These payloads are JSON and compress extremely well —
 *
 *   GET /v1/projects/:id/sessions   98 466 B ->  6 296 B   (15.6×, 60 sessions)
 *   GET /v1/p/<ext>/8000/agent     139 KB    ->  ~8.6 KB   (16.1×, WS-V)
 *
 * — and the browser fetches the inventory several times per session open.
 * Transfer, not database work, is what the client waits on there: the same list
 * costs ~7 ms of server time and ~100 KB on the wire.
 *
 * ─── Why this is NOT the usual "compress if content-length > N" ─────────────
 * Under Bun, `Response.headers.get('content-length')` is `null` inside
 * middleware even for a fixed string body — Bun computes the length when it
 * serializes, after every middleware has run. A length-gated implementation
 * therefore compresses nothing at all, silently. (Verified in situ: the session
 * list reached this middleware with `content-length: null` and a 98 KB body.)
 *
 * So the size test is done by PEEKING the body instead, and the peek is capped
 * at `COMPRESSION_MIN_BYTES`:
 *
 *   - The body ends inside the first kilobyte -> it is small. Emit the bytes we
 *     already hold, uncompressed, WITH an accurate `content-length`. Nothing was
 *     buffered beyond 1 KB and nothing was compressed that was not worth it.
 *   - The body is still going after a kilobyte -> it is worth compressing. Emit
 *     the peeked prefix followed by the rest of the original stream, the whole
 *     thing piped through `CompressionStream`.
 *
 * Memory is bounded at one kilobyte per in-flight response either way. A large
 * body is never accumulated — that would re-create the gateway OOM shape, where
 * multi-megabyte transcript bodies were held whole in memory.
 *
 * ─── The safety rule: only a content type we NAME gets compressed ───────────
 * Compressing a live stream breaks it: `CompressionStream` emits nothing until
 * a deflate block fills, so events stop arriving on time and a "live" surface
 * silently dies. The type allowlist below is what keeps this middleware away
 * from every streaming surface — `text/event-stream` (the turn stream, the
 * sandbox `/event` SSE), `application/x-ndjson`, the git pack types, the LLM
 * gateway's completions — and away from bytes that are already compressed
 * (images, tarballs, snapshots), where a second pass costs CPU and adds size.
 *
 * It is an allowlist, not a denylist, deliberately: an unknown type is far more
 * likely to be one of those than a text format we forgot. A new streaming route
 * is therefore excluded by default rather than by remembering to exclude it.
 *
 * Plus the ordinary HTTP guards: a client that did not ask for an encoding, a
 * body that is already encoded, a bodiless status (204/304), a 101 upgrade, and
 * a partial 206 all pass through untouched.
 */

import type { Context, Next } from 'hono';
import { Readable } from 'node:stream';
import { createDeflate, createGzip } from 'node:zlib';

/**
 * The smallest body worth compressing, and the exact number of bytes this
 * middleware will ever hold for one response.
 *
 * Below roughly this size the gzip header and trailer, and the switch from a
 * declared length to chunked transfer, are a bigger deal than the saving — and
 * most API responses (`{"ok":true}`, a status poll, a 402) are far below it.
 */
export const COMPRESSION_MIN_BYTES = 1024;

/**
 * Whether THIS runtime can compress at all. `CompressionStream` is a Web API
 * that Bun 1.2 (the API image's pinned major, `apps/api/Dockerfile`
 * `BUN_VERSION`) does not implement, while Bun 1.3 — every laptop and CI lane
 * — does. Checked per call, not once at import, so a test can remove the
 * global and prove the fail-open path; the cost is one property read.
 *
 * Fail OPEN: without the API the middleware must not touch the body. The
 * first deploy of this file threw `ReferenceError: CompressionStream is not
 * defined` AFTER peeking the body, so on dev every response of 1 KiB or more
 * answered 500 while `/health` stayed green (2026-08-26 22:41 → 2026-08-27).
 */
export function compressionAvailable(): boolean {
  return typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === 'function';
}

/**
 * Content types worth compressing.
 *
 * `text/event-stream` and `application/x-ndjson` are deliberately absent: they
 * are the two types where the failure is silent (events simply stop arriving on
 * time) rather than loud.
 */
const COMPRESSIBLE_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/problem+json',
  'application/javascript',
  'application/xml',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/plain',
  'text/html',
  'text/css',
  'text/csv',
  'text/markdown',
  'text/xml',
  'text/yaml',
  'application/yaml',
]);

/** Statuses that carry no body, so there is nothing to compress. */
const BODILESS_STATUSES = new Set([101, 204, 205, 304]);

/** Strip parameters and case: `application/json; charset=utf-8` -> `application/json`. */
function baseContentType(value: string | null): string | null {
  if (!value) return null;
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

/**
 * Which encoding the client asked for, or null.
 *
 * Only `gzip` and `deflate` are offered: they are what `CompressionStream`
 * implements, and every client in front of this API (browsers, Cloudflare, the
 * ALB, the Kortix CLI, the sandbox daemon) speaks gzip. `q=0` is honoured — a
 * client can explicitly refuse an encoding it also advertised.
 */
export function negotiateEncoding(
  acceptEncoding: string | null | undefined,
): 'gzip' | 'deflate' | null {
  if (!acceptEncoding) return null;
  const offered = new Map<string, number>();
  for (const part of acceptEncoding.split(',')) {
    const [name, ...params] = part.split(';').map((piece) => piece.trim());
    if (!name) continue;
    const q = params
      .map((param) => /^q=([\d.]+)$/i.exec(param))
      .find((match): match is RegExpExecArray => match !== null);
    offered.set(name.toLowerCase(), q ? Number(q[1]) : 1);
  }
  const usable = (name: string) => (offered.get(name) ?? 0) > 0;
  if (usable('gzip')) return 'gzip';
  if (usable('deflate')) return 'deflate';
  // `*` = "anything you like" — take gzip, unless gzip was refused by name.
  if (usable('*') && (offered.get('gzip') ?? 1) > 0) return 'gzip';
  return null;
}

/**
 * Everything decidable from the request and the response HEADERS, as a pure
 * predicate so it is testable without a server. Returns the encoding this
 * response is ELIGIBLE for; the size test happens afterwards, on the body.
 */
export function compressionCandidate(input: {
  method: string;
  acceptEncoding: string | null | undefined;
  status: number;
  contentType: string | null;
  contentEncoding: string | null;
  hasBody: boolean;
  isWebSocket?: boolean;
}): 'gzip' | 'deflate' | null {
  if (input.method === 'HEAD') return null;
  if (input.isWebSocket) return null;
  if (!input.hasBody) return null;
  if (BODILESS_STATUSES.has(input.status)) return null;
  // A 206 carries a byte range the client reassembles by offset.
  if (input.status === 206) return null;
  // Already encoded — by an upstream we proxy, or by a handler that did its own.
  if (input.contentEncoding) return null;

  const type = baseContentType(input.contentType);
  if (!type || !COMPRESSIBLE_TYPES.has(type)) return null;

  return negotiateEncoding(input.acceptEncoding);
}

interface Peek {
  /** The bytes read so far, at most `limit` plus the tail of one chunk. */
  chunks: Uint8Array[];
  total: number;
  /** True when the body ended inside the peek — `chunks` is then the WHOLE body. */
  complete: boolean;
}

/** Read at most `limit` bytes off the front of `reader`, no more. */
async function peekBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  limit: number,
): Promise<Peek> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { value, done } = await reader.read();
    if (done) return { chunks, total, complete: true };
    if (!value || value.byteLength === 0) continue;
    chunks.push(value);
    total += value.byteLength;
  }
  return { chunks, total, complete: false };
}

/** One buffer from the peeked chunks. Only ever called on a completed peek. */
function joinChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** The peeked prefix, then everything still to come from the original body. */
function restream(
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    // The client went away (navigation, abort). Let the upstream body know so
    // a proxied response does not keep pulling bytes nobody will read.
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}


/**
 * Bun < 1.3 — the `oven/bun:1.2-slim` runtime image — does not define
 * `CompressionStream`. Calling it there turned every compressible response into
 * a 500 (`ReferenceError: CompressionStream is not defined`; Essentia,
 * 2026-08-26), while local Bun 1.3.14 has it, so every local test passed.
 * Feature-detect once and fall back to `node:zlib`, which streams on every Bun
 * this repo runs.
 */
const HAS_NATIVE_COMPRESSION_STREAM = typeof CompressionStream !== 'undefined';

/** `body` piped through the requested encoding, on native or zlib plumbing. */
export function compressedStream(
  encoding: 'gzip' | 'deflate',
  body: ReadableStream<Uint8Array>,
  useNative: boolean = HAS_NATIVE_COMPRESSION_STREAM,
): ReadableStream<Uint8Array> {
  if (useNative) {
    return body.pipeThrough(
      new CompressionStream(encoding) as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    );
  }
  const zlib = encoding === 'gzip' ? createGzip() : createDeflate();
  return Readable.toWeb(
    Readable.fromWeb(body as unknown as Parameters<typeof Readable.fromWeb>[0]).pipe(zlib),
  ) as unknown as ReadableStream<Uint8Array>;
}

/**
 * Compress eligible responses. Mount once, globally, at the OUTSIDE of the
 * middleware chain so it sees the final response of every route.
 */
export async function compressResponse(c: Context, next: Next): Promise<void> {
  await next();

  const res = c.res;
  if (!res) return;

  const encoding = compressionCandidate({
    method: c.req.method,
    acceptEncoding: c.req.header('accept-encoding'),
    status: res.status,
    contentType: res.headers.get('content-type'),
    contentEncoding: res.headers.get('content-encoding'),
    hasBody: res.body !== null,
    isWebSocket: Boolean((res as { webSocket?: unknown }).webSocket),
  });

  // Advertise that the answer varies by encoding whether or not THIS one was
  // compressed, so a shared cache never hands a compressed body to a client
  // that cannot read it.
  //
  // Set on the ORIGINAL response, not on the replacement built below: Hono's
  // `c.res` setter copies every header of the outgoing response onto the one
  // you assign, so a `vary` written only on the replacement is overwritten by
  // the old value on the way out. (Observed: the compressed response shipped
  // `Vary: Origin`, dropping the `Accept-Encoding` this middleware had added.)
  appendVaryAcceptEncoding(res.headers);
  if (!encoding) return;
  if (!compressionAvailable()) return;

  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let peek: Peek;
  try {
    peek = await peekBody(reader, COMPRESSION_MIN_BYTES);
  } catch (err) {
    reader.releaseLock();
    throw err;
  }

  const headers = new Headers(res.headers);

  // Small enough that compressing costs more than it saves. Emit what we hold,
  // and declare its exact length while we are at it.
  if (peek.complete && peek.total < COMPRESSION_MIN_BYTES) {
    const body = joinChunks(peek.chunks, peek.total);
    headers.set('content-length', String(peek.total));
    c.res = new Response(peek.total === 0 ? null : (body as unknown as BodyInit), {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
    return;
  }

  // The body has been partially consumed by the peek, so from here on the
  // ONLY correct outcomes are "compressed" or "the same bytes, re-streamed".
  // A throw would surface as a 500 for a response that was perfectly fine.
  let transform: ReadableWritablePair<Uint8Array, Uint8Array> | null = null;
  try {
    transform = new CompressionStream(encoding) as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >;
  } catch (err) {
    console.warn('[compress] CompressionStream unavailable — sending uncompressed', {
      encoding,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const passthrough = restream(peek.chunks, reader);
  if (!transform) {
    // Uncompressed re-stream: the original length (when declared) still holds.
    c.res = new Response(passthrough, { status: res.status, statusText: res.statusText, headers });
    return;
  }

  headers.set('content-encoding', encoding);
  // The compressed length is unknown until the stream ends, so any declared
  // length must go: keeping it would describe the wrong number of bytes and the
  // client would truncate or hang. Bun frames the response as chunked instead.
  headers.delete('content-length');

<<<<<<< HEAD
  c.res = new Response(compressedStream(encoding, restream(peek.chunks, reader)), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
||||||| f208d37244
  c.res = new Response(
    restream(peek.chunks, reader).pipeThrough(
      new CompressionStream(encoding) as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    ),
    { status: res.status, statusText: res.statusText, headers },
  );
=======
  c.res = new Response(passthrough.pipeThrough(transform), {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
>>>>>>> origin/main
}

/** Add `Accept-Encoding` to `Vary` without dropping what is already there. */
function appendVaryAcceptEncoding(headers: Headers): void {
  const existing = headers.get('vary');
  if (!existing) {
    headers.set('vary', 'Accept-Encoding');
    return;
  }
  const parts = existing.split(',').map((part) => part.trim().toLowerCase());
  if (parts.includes('accept-encoding') || parts.includes('*')) return;
  headers.set('vary', `${existing}, Accept-Encoding`);
}
