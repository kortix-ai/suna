import { describe, expect, test } from 'bun:test';
import { probeStream, relayStream, resolveStreamProbeTimeoutMs } from './streaming';

const enc = new TextEncoder();
const dec = new TextDecoder();

function controllableUpstream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) { controller = c; },
    cancel() { cancelled = true; },
  });
  return {
    stream,
    push: (s: string) => controller.enqueue(enc.encode(s)),
    close: () => controller.close(),
    get cancelled() { return cancelled; },
  };
}

async function drain(rs: ReadableStream<Uint8Array>): Promise<string> {
  const reader = rs.getReader();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += dec.decode(value, { stream: true });
  }
  return out;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const noop = { warn: () => {} };

describe('relayStream', () => {
  test('forwards upstream chunks verbatim and settles usage', async () => {
    const up = controllableUpstream();
    const out = relayStream({
      upstreamBody: up.stream,
      captureBodies: false,
      requestId: 'r1',
      logger: noop,
      settle: async () => {},
      heartbeatMs: 10_000,
    });
    up.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    up.push('data: [DONE]\n\n');
    up.close();
    const text = await drain(out);
    expect(text).toBe('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    expect(text).not.toContain('keep-alive');
  });

  test('emits a keep-alive when upstream goes silent past the interval', async () => {
    const up = controllableUpstream();
    const out = relayStream({
      upstreamBody: up.stream,
      captureBodies: false,
      requestId: 'r2',
      logger: noop,
      settle: async () => {},
      heartbeatMs: 20,
    });
    const collected = drain(out);
    up.push('data: a\n\n');
    await delay(70); // > heartbeatMs with no upstream data → keep-alive(s)
    up.push('data: b\n\n');
    up.close();
    const text = await collected;
    expect(text).toContain(': keep-alive\n\n');
    // data frames survive intact and in order around the heartbeat(s)
    expect(text.indexOf('data: a')).toBeLessThan(text.indexOf('data: b'));
  });

  test('a throwing settle is caught and logged, never an unhandled rejection', async () => {
    const up = controllableUpstream();
    const warnings: unknown[][] = [];
    const out = relayStream({
      upstreamBody: up.stream,
      captureBodies: false,
      requestId: 'r4',
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
      settle: async () => {
        throw new Error('settle boom');
      },
      heartbeatMs: 10_000,
    });
    up.push('data: hi\n\n');
    up.close();
    const text = await drain(out);
    await delay(10); // let the detached finally run settle()
    expect(text).toBe('data: hi\n\n');
    expect(warnings.some((w) => String(w[0]).includes('stream settle failed'))).toBe(true);
  });

  test('never splits a partial event — no heartbeat injected mid-frame', async () => {
    const up = controllableUpstream();
    const out = relayStream({
      upstreamBody: up.stream,
      captureBodies: false,
      requestId: 'r3',
      logger: noop,
      settle: async () => {},
      heartbeatMs: 20,
    });
    const collected = drain(out);
    up.push('data: par'); // partial event — buffer does NOT end in \n\n
    await delay(70); // heartbeat fires internally, but must be suppressed here
    up.push('tial\n\n');
    up.close();
    const text = await collected;
    expect(text).toContain('data: partial\n\n');
    // the partial frame is contiguous: nothing inserted between "par" and "tial"
    expect(text).not.toMatch(/par[^]*keep-alive[^]*tial/);
  });
});

describe('probeStream', () => {
  test('reports hasContent once a content delta arrives, without losing any bytes', async () => {
    const up = controllableUpstream();
    up.push('data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n');
    up.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    const result = await probeStream(up.stream);
    expect(result.hasContent).toBe(true);
    expect(result.chunks.length).toBeGreaterThan(0);
    // every byte read by the probe is preserved for replay — none dropped
    const replayed = result.chunks.map((c) => dec.decode(c)).join('');
    expect(replayed).toContain('"content":"hi"');
  });

  test('reports hasContent=false when the stream closes having produced nothing', async () => {
    const up = controllableUpstream();
    up.push('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
    up.push('data: [DONE]\n\n');
    up.close();
    const result = await probeStream(up.stream);
    expect(result.hasContent).toBe(false);
  });

  test('gives up and assumes content after the probe budget, never blocking a legitimately slow stream', async () => {
    const up = controllableUpstream();
    // Push far more empty-delta frames than the probe will buffer, without closing —
    // the probe must bail out (assume ok) rather than hang or read forever.
    for (let i = 0; i < 200; i++) up.push('data: {"choices":[{"delta":{}}]}\n\n');
    const result = await probeStream(up.stream);
    expect(result.hasContent).toBe(true);
    expect(result.chunks.length).toBeLessThan(200); // bailed out before draining everything pushed
  });

  test('a read error mid-probe resolves on whatever content was seen so far', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{}}]}\n\n'));
      },
      pull() {
        throw new Error('upstream socket reset');
      },
    });
    const result = await probeStream(stream);
    expect(result.hasContent).toBe(false);
  });

  test('leaves a slow stream OPEN on timeout so the caller can commit it', async () => {
    const up = controllableUpstream();
    const result = await probeStream(up.stream, { inactivityTimeoutMs: 20 });

    expect(result.hasContent).toBe(false);
    expect(result.readError).toEqual({
      message: 'upstream stream probe timeout exceeded (20ms with no bytes)',
      code: 'stream_probe_timeout',
    });
    // The whole point of the commit path: a still-prefilling upstream must not
    // be cancelled. Cancelling here is what killed healthy large-context turns.
    expect(up.cancelled).toBe(false);
    expect(result.pendingRead).toBeDefined();
  });

  test('hands the in-flight read to the caller so no post-timeout chunk is lost', async () => {
    const up = controllableUpstream();
    const result = await probeStream(up.stream, { inactivityTimeoutMs: 20 });
    expect(result.pendingRead).toBeDefined();

    // The chunk the model finally produces resolves the read that was already
    // in flight when the deadline expired. A caller that issued a fresh
    // reader.read() instead would queue behind this promise and never see it.
    up.push('data: {"choices":[{"delta":{"content":"late but real"}}]}\n\n');
    const first = await result.pendingRead!;
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('late but real');
  });

  test('holds and classifies the production soft rate-limit completion before relaying bytes', async () => {
    const up = controllableUpstream();
    up.push(
      'data: {"choices":[{"delta":{"content":"Request rate increased too quickly."}}]}\n\n',
    );
    up.push(
      'data: {"choices":[{"delta":{"content":" To ensure system stability, please adjust your client logic to scale requests more smoothly over time."}}]}\n\n',
    );
    up.push(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\n',
    );
    up.push('data: [DONE]\n\n');
    up.close();

    const result = await probeStream(up.stream);

    expect(result.hasContent).toBe(false);
    expect(result.errorFrame).toEqual({
      message:
        'Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time.',
      code: 429,
      detail: { type: 'soft_rate_limit' },
    });
  });

  test('relays the exact soft-failure sentence when streaming usage is non-zero', async () => {
    const up = controllableUpstream();
    up.push(
      'data: {"choices":[{"delta":{"content":"Request rate increased too quickly. To ensure system stability, please adjust your client logic to scale requests more smoothly over time."}}]}\n\n',
    );
    up.push(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":20,"total_tokens":32}}\n\n',
    );
    up.push('data: [DONE]\n\n');
    up.close();

    const result = await probeStream(up.stream);

    expect(result.hasContent).toBe(true);
    expect(result.errorFrame).toBeUndefined();
  });

  test('does not release a soft-failure prefix at the normal chunk budget', async () => {
    const up = controllableUpstream();
    up.push(
      'data: {"choices":[{"delta":{"content":"Request rate increased too quickly."}}]}\n\n',
    );
    for (let index = 0; index < 70; index += 1) up.push(': provider-heartbeat\n\n');
    up.push(
      'data: {"choices":[{"delta":{"content":" To ensure system stability, please adjust your client logic to scale requests more smoothly over time."}}]}\n\n',
    );
    up.push(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}\n\n',
    );
    up.close();

    const result = await probeStream(up.stream);

    expect(result.hasContent).toBe(false);
    expect(result.errorFrame?.code).toBe(429);
  });
});

describe('resolveStreamProbeTimeoutMs', () => {
  test('keeps the 30-second default for an ordinary small prompt', () => {
    expect(
      resolveStreamProbeTimeoutMs({ requestBytes: 64_000, provider: 'openrouter', model: 'x' }),
    ).toBe(30_000);
  });

  test('does not scale with request size — a 2MiB prompt gets the same deadline', () => {
    expect(
      resolveStreamProbeTimeoutMs({
        requestBytes: 2_023_225,
        provider: 'aster',
        model: 'glm-5.2',
      }),
    ).toBe(30_000);
  });

  test('does not special-case a provider or model', () => {
    expect(
      resolveStreamProbeTimeoutMs({
        requestBytes: 64_000,
        provider: 'aster',
        model: 'glm-5.2',
      }),
    ).toBe(30_000);
  });

  // Regression lock. The retired ladder was
  // `30_000 + ceil((bytes - 64KiB) / 1MiB) * 15_000`, capped at 120_000, so
  // every request body between 3,211,776 and 4,259,840 bytes resolved to
  // exactly 90_000 — the deadline that deterministically killed healthy
  // large-context Fable turns. No request size may ever produce it again.
  test('no request size can resolve to the 90-second cliff again', () => {
    for (let bytes = 0; bytes <= 16 * 1024 * 1024; bytes += 64 * 1024) {
      const resolved = resolveStreamProbeTimeoutMs({
        requestBytes: bytes,
        provider: 'anthropic',
        model: 'claude-fable-5',
      });
      expect(resolved).toBe(30_000);
    }
  });

  test('an explicit operator timeout remains an exact override', () => {
    expect(
      resolveStreamProbeTimeoutMs({
        requestBytes: 2_023_225,
        provider: 'aster',
        model: 'glm-5.2',
        configuredTimeoutMs: 12_345,
      }),
    ).toBe(12_345);
  });

  test('zero keeps the default deadline', () => {
    expect(
      resolveStreamProbeTimeoutMs({
        requestBytes: 64_000,
        provider: 'aster',
        model: 'glm-5.2',
        configuredTimeoutMs: 0,
      }),
    ).toBe(30_000);
  });

  test('an extreme request is not given a longer deadline', () => {
    expect(
      resolveStreamProbeTimeoutMs({
        requestBytes: 50 * 1024 * 1024,
        provider: 'openrouter',
        model: 'x',
      }),
    ).toBe(30_000);
  });
});

describe('relayStream with a primed reader', () => {
  test('replays the probe-buffered prefix before continuing the live stream — no drops, no duplicates', async () => {
    const up = controllableUpstream();
    up.push('data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n');
    up.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    const probe = await probeStream(up.stream);
    expect(probe.hasContent).toBe(true);

    let settledBuffer: unknown;
    const out = relayStream({
      primed: { reader: probe.reader, chunks: probe.chunks },
      captureBodies: true,
      requestId: 'primed-1',
      logger: noop,
      settle: async (_usage, response) => {
        settledBuffer = response;
      },
      heartbeatMs: 10_000,
    });
    const collected = drain(out);
    up.push('data: {"choices":[{"delta":{"content":" there"}}]}\n\n');
    up.push('data: [DONE]\n\n');
    up.close();
    const text = await collected;

    expect(text).toBe(
      'data: {"choices":[{"delta":{},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":" there"}}]}\n\n' +
        'data: [DONE]\n\n',
    );
    await delay(10);
    expect(settledBuffer).toBe(text);
  });
});

describe('relayStream upstream error frames', () => {
  test('passes the in-stream error frame to settle and warns', async () => {
    const up = controllableUpstream();
    const warnings: unknown[][] = [];
    let settledError: unknown = 'unset';
    const out = relayStream({
      upstreamBody: up.stream,
      captureBodies: false,
      requestId: 'r-err',
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
      settle: async (_usage, _response, streamError) => {
        settledError = streamError;
      },
      heartbeatMs: 10_000,
    });
    up.push('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    up.push('data: {"error":{"message":"Upstream idle timeout exceeded","code":502}}\n\n');
    up.close();
    const text = await drain(out);
    // The frame is still relayed verbatim — the caller must see the failure too.
    expect(text).toContain('Upstream idle timeout exceeded');
    await delay(10); // let the detached finally run settle()
    expect(settledError).toEqual({ message: 'Upstream idle timeout exceeded', code: 502 });
    expect(warnings.some((w) => String(w[0]).includes('upstream error frame'))).toBe(true);
  });

  test('settles with a null error frame on a clean stream', async () => {
    const up = controllableUpstream();
    let settledError: unknown = 'unset';
    const out = relayStream({
      upstreamBody: up.stream,
      captureBodies: false,
      requestId: 'r-clean',
      logger: noop,
      settle: async (_usage, _response, streamError) => {
        settledError = streamError;
      },
      heartbeatMs: 10_000,
    });
    up.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n');
    up.close();
    await drain(out);
    await delay(10);
    expect(settledError).toBeNull();
  });
});

describe('probeStream error frames', () => {
  test('an error-frame-only stream probes as no-content (so the handler retries it)', async () => {
    const up = controllableUpstream();
    up.push('data: {"error":{"message":"Upstream idle timeout exceeded","code":502}}\n\n');
    up.close();
    const probe = await probeStream(up.stream);
    expect(probe.hasContent).toBe(false);
  });
});

// Regression coverage for the client-disconnect finding: the gateway must stop
// reading (and paying for) upstream tokens the instant the caller is gone,
// instead of draining an upstream that never closes on its own.
describe('relayStream client abort propagation', () => {
  function cancellableUpstream() {
    let cancelled = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        cancelled = true;
      },
    });
    return {
      stream,
      push: (s: string) => controller.enqueue(enc.encode(s)),
      isCancelled: () => cancelled,
    };
  }

  test('an inbound abort cancels the upstream reader and ends the relay even though upstream never closes', async () => {
    const up = cancellableUpstream();
    const ac = new AbortController();
    let settleCalls = 0;
    const out = relayStream({
      upstreamBody: up.stream,
      captureBodies: false,
      requestId: 'r-abort-1',
      logger: noop,
      settle: async () => {
        settleCalls += 1;
      },
      heartbeatMs: 10_000,
      signal: ac.signal,
    });
    const collected = drain(out);
    up.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    await delay(10);
    ac.abort();
    // The mock upstream never calls close() — if the abort weren't honored this
    // would hang forever (bounded only by the 15-minute default inactivity
    // deadline). Resolving here proves the relay stopped on its own.
    await collected;
    expect(up.isCancelled()).toBe(true);
    await delay(10);
    expect(settleCalls).toBe(1);
  });

  test('a signal already aborted before the relay starts never issues a read, just cancels and settles', async () => {
    const up = cancellableUpstream();
    const ac = new AbortController();
    ac.abort();
    let settledResponse: unknown = 'unset';
    const out = relayStream({
      upstreamBody: up.stream,
      captureBodies: false,
      requestId: 'r-abort-2',
      logger: noop,
      settle: async (_usage, response) => {
        settledResponse = response;
      },
      heartbeatMs: 10_000,
      signal: ac.signal,
    });
    await drain(out);
    expect(up.isCancelled()).toBe(true);
    await delay(10);
    expect(settledResponse).toBeNull();
  });
});

// Regression coverage for the unbounded-buffer finding: usage/error
// extraction stays O(1) per chunk (the incremental scanner) regardless of
// total stream size. The trace preview retained alongside it is a separate
// concern and is captured in FULL, uncapped — a log must show exactly what
// was relayed to the client, never a truncated stand-in for it.
describe('relayStream response buffer', () => {
  test('retains the full response preview for the trace, matching everything relayed to the client', async () => {
    const up = controllableUpstream();
    let settledPreview: unknown = 'unset';
    const out = relayStream({
      upstreamBody: up.stream,
      captureBodies: true,
      requestId: 'r-full-1',
      logger: noop,
      settle: async (_usage, response) => {
        settledPreview = response;
      },
      heartbeatMs: 10_000,
    });
    const collected = drain(out);
    const big = 'x'.repeat(5_000);
    up.push(`data: {"choices":[{"delta":{"content":"${big}"}}]}\n\n`);
    up.push('data: [DONE]\n\n');
    up.close();
    const text = await collected;
    await delay(10); // let the detached finally run settle()
    // The retained trace preview is byte-for-byte what reached the client —
    // no truncation, no gap between the two.
    expect(typeof settledPreview).toBe('string');
    expect((settledPreview as string).length).toBe(text.length);
    expect(settledPreview).toBe(text);
  });

  test('extracts usage correctly from a long stream while retaining the full preview alongside it', async () => {
    const up = controllableUpstream();
    let settledUsage: unknown = 'unset';
    let settledPreview: unknown = 'unset';
    const out = relayStream({
      upstreamBody: up.stream,
      captureBodies: true,
      requestId: 'r-full-2',
      logger: noop,
      settle: async (usage, response) => {
        settledUsage = usage;
        settledPreview = response;
      },
      heartbeatMs: 10_000,
    });
    const collected = drain(out);
    const big = 'y'.repeat(10_000);
    up.push(`data: {"choices":[{"delta":{"content":"${big}"}}]}\n\n`);
    up.push(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":11,"completion_tokens":22}}\n\n',
    );
    up.push('data: [DONE]\n\n');
    up.close();
    const text = await collected;
    await delay(10);
    expect(settledUsage).toMatchObject({ promptTokens: 11, completionTokens: 22 });
    expect(settledPreview).toBe(text);
  });
});

// Regression coverage for the no-total-deadline finding: a stalled upstream
// that accepts the connection, sends some bytes, then goes completely silent
// forever (never closes) must eventually be treated as dead, not propped up
// by heartbeats indefinitely.
describe('relayStream inactivity deadline', () => {
  test('aborts a stalled-but-never-closed upstream after the inactivity budget and surfaces a timeout error', async () => {
    let cancelled = false;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        cancelled = true;
      },
    });
    let settledError: unknown = 'unset';
    const out = relayStream({
      upstreamBody: stream,
      captureBodies: false,
      requestId: 'r-inactive',
      logger: noop,
      settle: async (_usage, _response, streamError) => {
        settledError = streamError;
      },
      heartbeatMs: 10,
      inactivityTimeoutMs: 30,
    });
    const collected = drain(out);
    controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
    // Upstream goes silent forever after this single chunk — never closes.
    const text = await collected;
    expect(text).toContain('stream_inactivity_timeout');
    expect(cancelled).toBe(true);
    await delay(10);
    expect(settledError).toMatchObject({ code: 'stream_inactivity_timeout' });
  });

  test('a slow-thinking model that keeps trickling bytes never trips the inactivity deadline', async () => {
    const up = controllableUpstream();
    let settledError: unknown = 'unset';
    const out = relayStream({
      upstreamBody: up.stream,
      captureBodies: false,
      requestId: 'r-slow-thinker',
      logger: noop,
      settle: async (_usage, _response, streamError) => {
        settledError = streamError;
      },
      heartbeatMs: 10,
      inactivityTimeoutMs: 30,
    });
    const collected = drain(out);
    // Each chunk arrives just under the inactivity budget, resetting the clock.
    up.push('data: {"choices":[{"delta":{"content":"a"}}]}\n\n');
    await delay(20);
    up.push('data: {"choices":[{"delta":{"content":"b"}}]}\n\n');
    await delay(20);
    up.push('data: [DONE]\n\n');
    up.close();
    const text = await collected;
    expect(text).not.toContain('stream_inactivity_timeout');
    await delay(10); // let the detached finally run settle()
    expect(settledError).toBeNull();
  });
});
