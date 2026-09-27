import { describe, expect, test } from 'bun:test';
import { relayStream } from './streaming';

const encoder = new TextEncoder();

describe('relayStream', () => {
  test('separates consecutive complete JSON data lines into distinct SSE events', async () => {
    const first = 'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n';
    const second = 'data: {"choices":[{"delta":{"content":"answer"}}]}\n';
    const usage = 'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n';
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(first));
        controller.enqueue(encoder.encode(second.slice(0, 12)));
        controller.enqueue(encoder.encode(second.slice(12) + usage + 'data: [DONE]\n\n'));
        controller.close();
      },
    });
    let settledUsage: unknown;
    const warnings: Array<{ event?: string; requestId?: string; provider?: string; model?: string }> = [];
    const output = await new Response(relayStream({
      upstreamBody: upstream,
      requestId: 'req_framing',
      upstreamProvider: 'provider-a',
      upstreamModel: 'model-a',
      logger: { warn: (_message, detail) => warnings.push(detail as typeof warnings[number]), error() {} },
      settle: async (value) => { settledUsage = value; },
    })).text();

    expect(output).toBe(first + '\n' + second + '\n' + usage + '\n' + 'data: [DONE]\n\n');
    const events = output.trim().split(/\r?\n\r?\n/);
    expect(events).toHaveLength(4);
    expect(events.slice(0, -1).map((event) => JSON.parse(event.slice(6)))).toHaveLength(3);
    expect(settledUsage).toMatchObject({ promptTokens: 11, completionTokens: 7 });
    expect(warnings).toEqual([{ event: 'gateway.sse_framing_repaired', requestId: 'req_framing', provider: 'provider-a', model: 'model-a' }]);
  });

  test('keeps a standard multiline SSE event and CRLF framed events unchanged', async () => {
    const text =
      'data: {"choices":\n' +
      'data: [{"delta":{"content":"answer"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"next"}}]}\r\n\r\n' +
      'data: [DONE]\r\n\r\n';
    const warnings: unknown[] = [];
    const output = await new Response(relayStream({
      upstreamBody: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } }),
      requestId: 'req_valid',
      logger: { warn: (...args) => warnings.push(args), error() {} },
      settle: async () => {},
    })).text();
    expect(output).toBe(text);
    expect(warnings).toEqual([]);
  });

  test('repairs consecutive JSON events across an SSE comment', async () => {
    // The final event carries a finish_reason (a genuinely complete
    // conversation) so the relay's own completion check does not treat this
    // otherwise-terminated stream as an incomplete cut — see
    // "IncrementalSseScanner terminal detection" in sse-scanner.test.ts.
    const text = 'data: {"choices":[{"delta":{"content":"a"}}]}\n: keep-alive\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n';
    const output = await new Response(relayStream({
      upstreamBody: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } }),
      requestId: 'req_comment',
      logger: { warn() {}, error() {} },
      settle: async () => {},
    })).text();
    expect(output).toBe(text.replace('\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}', '\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}'));
  });

  test('terminates a complete final event when the provider closes without a newline', async () => {
    // finish_reason inside the one unterminated line keeps this test's exact
    // shape (a single complete JSON line with no trailing newline) while
    // still reading as a genuinely complete conversation.
    const text = 'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}';
    const warnings: unknown[] = [];
    const output = await new Response(relayStream({
      upstreamBody: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } }),
      requestId: 'req_eof',
      logger: { warn: (...args) => warnings.push(args), error() {} },
      settle: async () => {},
    })).text();
    expect(output).toBe(text + '\n\n');
    expect(warnings).toHaveLength(1);
  });

  test('terminates a complete final line that has one newline but no blank line', async () => {
    const text = 'data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\r\n';
    const output = await new Response(relayStream({
      upstreamBody: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } }),
      requestId: 'req_final_line',
      logger: { warn() {}, error() {} },
      settle: async () => {},
    })).text();
    expect(output).toBe(text + '\r\n');
  });

  test('bounds an upstream line that never terminates', async () => {
    let settledError: unknown;
    const stream = relayStream({
      upstreamBody: new ReadableStream({
        start(controller) { controller.enqueue(encoder.encode('data: ' + 'x'.repeat(8 * 1024 * 1024))); controller.close(); },
      }),
      requestId: 'req_unterminated',
      logger: { warn() {}, error() {} },
      settle: async (_usage, error) => { settledError = error; },
    });
    await expect(new Response(stream).text()).rejects.toThrow('provider SSE line exceeded');
    expect(settledError).toMatchObject({ code: 'upstream_stream_error' });
  });

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

  test('a client stop before the usage frame settles once with what was streamed', async () => {
    const chunk = encoder.encode('data: {"choices":[{"delta":{"content":"' + 'x'.repeat(400) + '"}}]}\n\n');
    const settlements: Array<{ usage: unknown; error: unknown; observed: unknown }> = [];
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
      },
    });
    const reader = relayStream({
      upstreamBody: upstream,
      requestId: 'req_3',
      logger: console,
      settle: async (usage, error, observed) => {
        settlements.push({ usage, error, observed });
      },
    }).getReader();
    await reader.read();
    await reader.cancel();
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toMatchObject({
      usage: null,
      error: { code: 'client_aborted' },
      observed: { outputChars: 400, clientStopped: true },
    });
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
