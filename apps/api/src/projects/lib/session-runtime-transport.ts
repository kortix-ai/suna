/**
 * The API's own client for the daemon's `/kortix/opencode/*` namespace.
 *
 * Two calls, both over the EXISTING sandbox transport (`resolveSandboxIngress`
 * + `buildSandboxUpstreamHeaders` — the same resolver the `/v1/p/` proxy and
 * the WebSocket upstream use, so provider routing, preview links, service keys
 * and the signed user context are resolved in exactly one place):
 *
 *   • {@link fetchRuntimeState}  — `GET /kortix/opencode/state`, gzipped on the
 *     wire, `If-None-Match` honoured.
 *   • {@link openRuntimeEventStream} — `GET /kortix/opencode/events?since=&epoch=`,
 *     an SSE body handed back UNREAD so the caller can pump it.
 *
 * ─── THE STREAM IS NEVER BUFFERED ──────────────────────────────────────────
 * WS-Z1's requirement, and the reason it is stated so plainly: a buffered
 * event stream is a broken event stream. So this module returns the raw
 * `ReadableStream` and {@link parseSseFrames} consumes it incrementally. There
 * is no `await response.text()` anywhere on this path, and `Accept-Encoding`
 * for the stream is `identity` — a gzip stream buffers until a deflate block
 * fills, which is the same defect wearing a compression hat.
 */

import {
  buildSandboxUpstreamHeaders,
  resolveSandboxIngress,
  resolveServiceKey,
} from '../../sandbox-proxy/backend';

/** The daemon's port inside every sandbox. */
export const DAEMON_PORT = 8000;

/** Budget for the one-shot `/state` read. The daemon serves it warm in 0.1 ms. */
export const RUNTIME_STATE_TIMEOUT_MS = 8_000;

/**
 * Budget for OPENING the event stream — not for the stream itself.
 *
 * An SSE body has no end, so an `AbortSignal.timeout` covering the whole
 * response would kill every healthy stream on schedule. This bounds the
 * connect, and the caller's own abort signal bounds the life.
 */
export const RUNTIME_STREAM_CONNECT_TIMEOUT_MS = 10_000;

export interface DaemonCallTarget {
  externalId: string;
  /** The user the call is made on behalf of; signs the `X-Kortix-User-Context`. */
  userId: string;
}

async function daemonEndpoint(
  target: DaemonCallTarget,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  const serviceKey = await resolveServiceKey(target.externalId);
  if (!serviceKey) return null;
  const ingress = await resolveSandboxIngress(target.externalId, {
    port: DAEMON_PORT,
    transport: 'http',
  });
  const headers = await buildSandboxUpstreamHeaders({
    sandboxId: target.externalId,
    userId: target.userId,
    serviceKey,
    providerHeaders: ingress.headers,
  });
  return { url: ingress.url.replace(/\/$/, ''), headers };
}

export type RuntimeStateFetch =
  | { ok: true; status: 200; doc: Record<string, unknown>; etag: string | null }
  | { ok: true; status: 304; etag: string | null }
  | { ok: false; reason: string; status: number | null };

/**
 * Read the daemon's runtime projection.
 *
 * `Accept-Encoding: gzip` is sent DELIBERATELY and is the whole point of the
 * read: the document is 8.7 KB raw and 0.9 KB gzipped, and the hop this
 * crosses is the ~1.4 s one. `fetch` decompresses for us, so the caller gets
 * an object either way.
 */
export async function fetchRuntimeState(
  target: DaemonCallTarget,
  options: { ifNoneMatch?: string | null; signal?: AbortSignal } = {},
): Promise<RuntimeStateFetch> {
  let endpoint: { url: string; headers: Record<string, string> } | null;
  try {
    endpoint = await daemonEndpoint(target);
  } catch (error) {
    return { ok: false, reason: reasonOf(error), status: null };
  }
  if (!endpoint) return { ok: false, reason: 'no_service_key', status: null };

  const headers: Record<string, string> = {
    ...endpoint.headers,
    Accept: 'application/json',
    'Accept-Encoding': 'gzip',
  };
  if (options.ifNoneMatch) headers['If-None-Match'] = options.ifNoneMatch;

  try {
    const response = await fetch(`${endpoint.url}/kortix/opencode/state`, {
      headers,
      signal: options.signal ?? AbortSignal.timeout(RUNTIME_STATE_TIMEOUT_MS),
    });
    const etag = response.headers.get('etag');
    if (response.status === 304) return { ok: true, status: 304, etag };
    if (!response.ok) {
      // Drain so the connection can be reused; never surface the body.
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: `daemon_${response.status}`, status: response.status };
    }
    const doc = (await response.json()) as Record<string, unknown>;
    return { ok: true, status: 200, doc, etag };
  } catch (error) {
    return { ok: false, reason: reasonOf(error), status: null };
  }
}

export type RuntimeStreamOpen =
  | { ok: true; body: ReadableStream<Uint8Array>; epoch: string | null }
  | { ok: false; reason: string; status: number | null };

/**
 * Open the daemon's sequenced event stream.
 *
 * `since`/`epoch` are passed through VERBATIM — the daemon owns replay, and the
 * API deciding for itself what a client missed is exactly how two cursors start
 * disagreeing.
 */
export async function openRuntimeEventStream(
  target: DaemonCallTarget,
  options: { since?: number | null; epoch?: string | null; signal: AbortSignal },
): Promise<RuntimeStreamOpen> {
  let endpoint: { url: string; headers: Record<string, string> } | null;
  try {
    endpoint = await daemonEndpoint(target);
  } catch (error) {
    return { ok: false, reason: reasonOf(error), status: null };
  }
  if (!endpoint) return { ok: false, reason: 'no_service_key', status: null };

  const url = new URL(`${endpoint.url}/kortix/opencode/events`);
  if (typeof options.since === 'number' && Number.isFinite(options.since)) {
    url.searchParams.set('since', String(options.since));
  }
  if (options.epoch) url.searchParams.set('epoch', options.epoch);

  // The connect is bounded; the STREAM is not. Two signals, combined, because
  // `AbortSignal.timeout` on the request would also abort the live body.
  const connectTimeout = AbortSignal.timeout(RUNTIME_STREAM_CONNECT_TIMEOUT_MS);
  const connectGuard = new AbortController();
  const onCallerAbort = () => connectGuard.abort(options.signal.reason);
  const onConnectTimeout = () => connectGuard.abort(new Error('connect timeout'));
  options.signal.addEventListener('abort', onCallerAbort, { once: true });
  connectTimeout.addEventListener('abort', onConnectTimeout, { once: true });

  try {
    const response = await fetch(url, {
      headers: {
        ...endpoint.headers,
        Accept: 'text/event-stream',
        // NEVER gzip an event stream — see the module header.
        'Accept-Encoding': 'identity',
        'Cache-Control': 'no-cache',
      },
      signal: connectGuard.signal,
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      return { ok: false, reason: `daemon_${response.status}`, status: response.status };
    }
    return {
      ok: true,
      body: response.body,
      epoch: response.headers.get('x-kortix-epoch'),
    };
  } catch (error) {
    return { ok: false, reason: reasonOf(error), status: null };
  } finally {
    options.signal.removeEventListener('abort', onCallerAbort);
    connectTimeout.removeEventListener('abort', onConnectTimeout);
  }
}

export interface SseFrame {
  /** The `event:` name, or null when the producer sent only `data:`. */
  event: string | null;
  /** The `id:` value, or null. */
  id: string | null;
  /** The joined `data:` lines. */
  data: string;
}

/**
 * Parse an SSE byte stream into frames, incrementally.
 *
 * Deliberately minimal and deliberately NOT a general SSE client: it never
 * reconnects (the caller owns that policy), never interprets `retry:`, and
 * never accumulates more than one frame. A comment line (`:`) is skipped
 * without yielding, which is the behaviour that made WS-Z1 choose a TYPED
 * heartbeat over a comment in the first place.
 */
export async function* parseSseFrames(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // Frames are separated by a blank line. Tolerate CRLF producers.
      let boundary = nextBoundary(buffer);
      while (boundary) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const frame = parseFrame(raw);
        if (frame) yield frame;
        boundary = nextBoundary(buffer);
      }
    }
  } finally {
    reader.releaseLock();
    await body.cancel().catch(() => {});
  }
}

function nextBoundary(buffer: string): { index: number; length: number } | null {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return null;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

function parseFrame(raw: string): SseFrame | null {
  let event: string | null = null;
  let id: string | null = null;
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'id') id = value;
    else if (field === 'data') data.push(value);
  }
  if (event === null && id === null && data.length === 0) return null;
  return { event, id, data: data.join('\n') };
}

function reasonOf(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  if (error instanceof Error && error.message) return error.message.slice(0, 200);
  return 'unknown';
}
