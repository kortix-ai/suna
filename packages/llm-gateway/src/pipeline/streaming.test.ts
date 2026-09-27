import { describe, expect, test } from 'bun:test';
import { relayStream } from './streaming';

const encoder = new TextEncoder();

describe('relayStream', () => {
  test('relays provider bytes unchanged and settles usage once', async () => {
    const text =
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n\n' +
      'data: [DONE]\n\n';
    let settlements = 0;
    let usage: unknown;
    const stream = relayStream({
      upstreamBody: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      }),
      requestId: 'req_1',
      logger: console,
      settle: async (value) => {
        settlements += 1;
        usage = value;
      },
    });

    expect(await new Response(stream).text()).toBe(text);
    expect(settlements).toBe(1);
    expect(usage).toMatchObject({ promptTokens: 11, completionTokens: 7 });
  });

  test('cancels the provider when the client cancels', async () => {
    let cancelled = false;
    const upstream = new ReadableStream<Uint8Array>({
      pull() {},
      cancel() {
        cancelled = true;
      },
    });
    const reader = relayStream({
      upstreamBody: upstream,
      requestId: 'req_2',
      logger: console,
      settle: async () => {},
    }).getReader();
    await reader.cancel();
    expect(cancelled).toBe(true);
  });

  function upstreamOf(bytes: Uint8Array | null): ReadableStream<Uint8Array> {
    return new ReadableStream({
      start(controller) {
        if (bytes) controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  const noSleep = async () => undefined;

  test('closes before the first byte: retries transparently and the client never sees the cut', async () => {
    const good =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
      'data: [DONE]\n\n';
    let redispatches = 0;
    let settlements = 0;
    let settledError: unknown;
    const stream = relayStream({
      // First attempt: upstream closes the connection with ZERO bytes.
      upstreamBody: upstreamOf(null),
      requestId: 'req_retry_before_first_byte',
      logger: { warn() {}, error() {} },
      settle: async (_usage, streamError) => {
        settlements += 1;
        settledError = streamError;
      },
      redispatch: async () => {
        redispatches += 1;
        return upstreamOf(encoder.encode(good));
      },
      sleep: noSleep,
    });

    const body = await new Response(stream).text();
    expect(body).toBe(good);
    expect(redispatches).toBe(1);
    expect(settlements).toBe(1);
    expect(settledError).toBeNull();
  });

  test('cut after the first byte: no partial line is ever forwarded, and a well-formed terminal error frame closes the stream', async () => {
    // The upstream writes one complete event, then dies mid-way through the
    // NEXT data line (no trailing newline) before closing.
    const firstEvent = 'data: {"choices":[{"delta":{"content":"partial answer"}}]}\n\n';
    const cutMidLine = 'data: {"choices":[{"delta":{"content":"more but this line never c';
    let redispatchCalled = false;
    let settledError: { code?: unknown; message?: string; detail?: Record<string, unknown> } | null =
      null;
    const stream = relayStream({
      upstreamBody: upstreamOf(encoder.encode(firstEvent + cutMidLine)),
      requestId: 'req_cut_after_first_byte',
      logger: { warn() {}, error() {} },
      settle: async (_usage, streamError) => {
        settledError = streamError as typeof settledError;
      },
      // Must NOT be consulted: bytes were already forwarded, so this is not a
      // "nothing sent yet" retry candidate.
      redispatch: async () => {
        redispatchCalled = true;
        return null;
      },
      sleep: noSleep,
    });

    const body = await new Response(stream).text();

    expect(redispatchCalled).toBe(false);
    expect(body.startsWith(firstEvent)).toBe(true);
    // The partial trailing line must never appear anywhere in the forwarded body.
    expect(body).not.toContain('this line never c');
    expect(body).not.toContain('more but');
    // A well-formed terminal error event, parseable as OpenAI-compat SSE.
    const tail = body.slice(firstEvent.length);
    const dataLines = tail
      .split('\n\n')
      .map((l) => l.trim())
      .filter(Boolean);
    expect(dataLines.length).toBeGreaterThanOrEqual(2);
    const errorLine = dataLines[0].replace(/^data:\s*/, '');
    const parsed = JSON.parse(errorLine) as { error: { message: string; code: string } };
    expect(parsed.error.code).toBe('upstream_incomplete_stream');
    expect(typeof parsed.error.message).toBe('string');
    expect(dataLines[dataLines.length - 1]).toBe('data: [DONE]');

    expect(settledError).toMatchObject({ code: 'upstream_incomplete_stream' });
    const detail = (settledError as { detail?: Record<string, unknown> } | null)?.detail;
    expect(detail).toMatchObject({ bytesForwarded: firstEvent.length });
  });

  test('mid-JSON-line cut with nothing forwarded yet still drops the partial line and does not hang', async () => {
    // Upstream sends a few bytes that never complete a single line, then
    // closes. No retry is offered, so it must terminate explicitly rather
    // than silently closing.
    const partial = 'data: {"choices":[{"delta":{"content":"i never finish';
    let settled = 0;
    let settledError: { code?: unknown } | null = null;
    const stream = relayStream({
      upstreamBody: upstreamOf(encoder.encode(partial)),
      requestId: 'req_mid_json_no_retry',
      logger: { warn() {}, error() {} },
      settle: async (_usage, streamError) => {
        settled += 1;
        settledError = streamError as typeof settledError;
      },
      sleep: noSleep,
    });

    const body = await new Response(stream).text();
    expect(body).not.toContain('i never finish');
    expect(body).toContain('upstream_incomplete_stream');
    expect(body.trim().endsWith('data: [DONE]')).toBe(true);
    expect(settled).toBe(1);
    expect(settledError).toMatchObject({ code: 'upstream_incomplete_stream' });
  });

  test('redispatch is bounded: gives up after the configured number of attempts and still terminates cleanly', async () => {
    let attempts = 0;
    const stream = relayStream({
      upstreamBody: upstreamOf(null),
      requestId: 'req_bounded_retry',
      logger: { warn() {}, error() {} },
      settle: async () => {},
      redispatch: async () => {
        attempts += 1;
        return upstreamOf(null); // every retry also closes with nothing
      },
      maxRedispatchAttempts: 2,
      sleep: noSleep,
    });

    const body = await new Response(stream).text();
    expect(attempts).toBe(2);
    expect(body).toContain('upstream_incomplete_stream');
  });

  test('an in-band upstream error frame with no trailing [DONE] still gets a [DONE] appended', async () => {
    const text = 'data: {"error":{"message":"provider overloaded","code":"overloaded_error"}}\n\n';
    const stream = relayStream({
      upstreamBody: upstreamOf(encoder.encode(text)),
      requestId: 'req_error_no_done',
      logger: { warn() {}, error() {} },
      settle: async () => {},
      sleep: noSleep,
    });

    const body = await new Response(stream).text();
    expect(body.startsWith(text)).toBe(true);
    expect(body.trim().endsWith('data: [DONE]')).toBe(true);
  });
});
