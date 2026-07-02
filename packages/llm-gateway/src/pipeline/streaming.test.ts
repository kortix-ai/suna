import { describe, expect, test } from 'bun:test';
import { probeStream, relayStream } from './streaming';

const enc = new TextEncoder();
const dec = new TextDecoder();

function controllableUpstream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return {
    stream,
    push: (s: string) => controller.enqueue(enc.encode(s)),
    close: () => controller.close(),
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
