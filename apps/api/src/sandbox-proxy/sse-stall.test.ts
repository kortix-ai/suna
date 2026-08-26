import { describe, expect, test } from 'bun:test';

import {
  SSE_SILENT_MARK_MAX_AGE_MS,
  recordSseStreamEnd,
  resetSseStallRegistryForTests,
  shouldBypassIngressCache,
  trackSseBytes,
} from './sse-stall';

/**
 * The 200-then-silence loop this module breaks (prod, 2026-08-26).
 *
 * The proxy's ingress cache (5-minute TTL) is invalidated only on an upstream
 * 502/503 or a lifecycle event. A cached ingress URL that still ACCEPTS the
 * connection after the box moved answers `200 text/event-stream` and never
 * writes a byte — no error status is ever observed, so nothing invalidates
 * the cache, and every client heartbeat reconnect (60s cadence) lands on the
 * same dead address for the rest of the TTL. The SDK's transcript froze for
 * minutes at a time, and the api's own logging suppresses these requests as
 * healthy noise.
 *
 * A zero-byte SSE stream is that failure's exact signature: opencode writes
 * its `server.connected` event immediately on a real connection, so a stream
 * that closed without EVER writing did not reach opencode. Record it, and let
 * the NEXT connect for that sandbox re-resolve ingress instead of trusting
 * the cache.
 */
describe('trackSseBytes', () => {
  async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let out = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) out += decoder.decode(value);
    }
    return out;
  }

  function upstreamOf() {
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });
    const encoder = new TextEncoder();
    return {
      stream,
      push: (chunk: string) => ctrl.enqueue(encoder.encode(chunk)),
      close: () => ctrl.close(),
    };
  }

  test('forwards bytes unchanged and reports the delivered total on close', async () => {
    const up = upstreamOf();
    let reported = -1;
    const wrapped = trackSseBytes(up.stream, (bytes) => {
      reported = bytes;
    });

    up.push('data: {"type":"server.connected"}\n\n');
    up.close();
    const seen = await readAll(wrapped);

    expect(seen).toBe('data: {"type":"server.connected"}\n\n');
    expect(reported).toBe(seen.length);
  });

  test('reports zero for a stream that closes without a byte', async () => {
    const up = upstreamOf();
    let reported = -1;
    const wrapped = trackSseBytes(up.stream, (bytes) => {
      reported = bytes;
    });
    up.close();
    await readAll(wrapped);
    expect(reported).toBe(0);
  });

  test('reports exactly once on downstream cancel (browser gone)', async () => {
    let upstreamCancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      cancel() {
        upstreamCancelled = true;
      },
    });
    const reports: number[] = [];
    const wrapped = trackSseBytes(upstream, (bytes) => {
      reports.push(bytes);
    });
    await wrapped.cancel('client gone');
    expect(upstreamCancelled).toBe(true);
    expect(reports).toEqual([0]);
  });
});

describe('preview proxy wiring', () => {
  test('the proxy counts /global/event bytes and consumes the mark before ingress resolution', async () => {
    // Source pins, matching the repo's guard-pinning convention — the forward
    // path has no unit seam (it needs a live provider + sandbox). Semantics
    // are unit-tested above; these assert the proxy actually participates.
    const source = await Bun.file(
      new URL('./routes/preview.ts', import.meta.url).pathname,
    ).text();
    expect(source).toContain("remainingPath.endsWith('/global/event')");
    expect(source).toContain('trackSseBytes(upstream.body');
    expect(source).toContain('recordSseStreamEnd(sseStallKey, bytes)');
    // The bypass consumes BEFORE resolveSandboxIngress, so the re-resolve is
    // what this very connect uses.
    const bypass = source.indexOf('shouldBypassIngressCache(sseStallKey)');
    const resolve = source.indexOf('await resolveSandboxIngress(record, ingressRequest)');
    expect(bypass).toBeGreaterThan(-1);
    expect(resolve).toBeGreaterThan(bypass);
  });
});

describe('silent-stream registry', () => {
  test('a zero-byte stream marks its sandbox; the next connect consumes the mark once', () => {
    resetSseStallRegistryForTests();
    const nowMs = 1_000_000;
    recordSseStreamEnd('sb-1:4096', 0, nowMs);

    expect(shouldBypassIngressCache('sb-1:4096', nowMs + 1_000)).toBe(true);
    // Consume-once: the retry it caused already re-resolved ingress. A second
    // bypass would turn every reconnect into a provider call.
    expect(shouldBypassIngressCache('sb-1:4096', nowMs + 2_000)).toBe(false);
  });

  test('a stream that delivered bytes clears any prior mark — the path is proven', () => {
    resetSseStallRegistryForTests();
    const nowMs = 1_000_000;
    recordSseStreamEnd('sb-2:4096', 0, nowMs);
    recordSseStreamEnd('sb-2:4096', 512, nowMs + 500);
    expect(shouldBypassIngressCache('sb-2:4096', nowMs + 1_000)).toBe(false);
  });

  test('an unmarked sandbox never bypasses', () => {
    resetSseStallRegistryForTests();
    expect(shouldBypassIngressCache('sb-3:4096', 1_000_000)).toBe(false);
  });

  test('a mark expires — stale evidence must not trigger provider calls later', () => {
    resetSseStallRegistryForTests();
    const nowMs = 1_000_000;
    recordSseStreamEnd('sb-4:4096', 0, nowMs);
    expect(
      shouldBypassIngressCache('sb-4:4096', nowMs + SSE_SILENT_MARK_MAX_AGE_MS + 1),
    ).toBe(false);
  });
});
