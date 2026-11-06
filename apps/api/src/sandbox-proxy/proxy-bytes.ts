import { logger } from '../lib/logger';

/**
 * Bytes this replica's box proxy sends to clients, per route class.
 *
 * Box responses that pass through the API cross the NAT twice over: in from
 * Platinum, out to the client. Prod NAT took 130 GB/day from Platinum ingress
 * (VPC flow logs, 2026-11-02), and no log said which routes carried it. This
 * counter answers that before anyone moves a route off the proxy: one log line
 * per replica per minute, `[proxy-bytes]`, with bytes and responses per class.
 *
 * Counted on the client response, so a body the proxy re-serializes (a
 * transcript list with its attachments stripped) counts its new size, and a
 * gzip passthrough counts its compressed size, which is what the wire carried.
 */

export type ProxyByteClass = 'events' | 'runtime' | 'file' | 'daemon' | 'preview';

const FLUSH_INTERVAL_MS = 60_000;

// replica-local: per-replica counters, flushed to the log once a minute.
const counters = new Map<ProxyByteClass, { bytes: number; responses: number }>();
let windowStartedAt = Date.now();

/** The route class of a proxied request: what a direct path would have to carry. */
export function proxyByteClass(port: number, remainingPath: string): ProxyByteClass {
  if (port !== 8000) return 'preview';
  if (/^\/(?:global\/event|kortix\/runtime\/events)(?:$|[/?#])/.test(remainingPath)) return 'events';
  if (/^\/kortix\/runtime(?:$|[/?#])/.test(remainingPath)) return 'runtime';
  if (/^\/(?:file|kortix\/part)(?:$|[/?#])/.test(remainingPath)) return 'file';
  return 'daemon';
}

function add(cls: ProxyByteClass, bytes: number, responses: number, now = Date.now()): void {
  const counter = counters.get(cls) ?? { bytes: 0, responses: 0 };
  counter.bytes += bytes;
  counter.responses += responses;
  counters.set(cls, counter);
  if (now - windowStartedAt < FLUSH_INTERVAL_MS) return;
  const byClass = Object.fromEntries(counters);
  const windowSeconds = Math.round((now - windowStartedAt) / 1000);
  counters.clear();
  windowStartedAt = now;
  logger.info('[proxy-bytes]', { window_s: windowSeconds, by_class: byClass });
}

/**
 * Count a proxied response's body bytes under `cls`. A body with a
 * `content-length` is counted from the header and returned untouched; any
 * other body (chunked, streams) is counted chunk by chunk as it flows, so an
 * event stream adds to the minute it is in, not to the minute it ends.
 */
export function countProxyResponseBytes(response: Response, cls: ProxyByteClass): Response {
  if (!response.body) {
    add(cls, 0, 1);
    return response;
  }
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length >= 0 && response.headers.has('content-length')) {
    add(cls, length, 1);
    return response;
  }
  add(cls, 0, 1);
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        add(cls, chunk.byteLength, 0);
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** Test seam: the current window's counters, then reset them. */
export function __drainProxyBytesForTest(): Record<string, { bytes: number; responses: number }> {
  const out = Object.fromEntries(counters);
  counters.clear();
  windowStartedAt = Date.now();
  return out;
}
