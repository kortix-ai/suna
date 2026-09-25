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
    const text = 'data: {"choices":[{"delta":{"content":"a"}}]}\n: keep-alive\ndata: {"choices":[{"delta":{"content":"b"}}]}\n\n';
    const output = await new Response(relayStream({
      upstreamBody: new ReadableStream({ start(controller) { controller.enqueue(encoder.encode(text)); controller.close(); } }),
      requestId: 'req_comment',
      logger: { warn() {}, error() {} },
      settle: async () => {},
    })).text();
    expect(output).toBe(text.replace('\ndata: {"choices":[{"delta":{"content":"b"}}]}', '\n\ndata: {"choices":[{"delta":{"content":"b"}}]}'));
  });

  test('terminates a complete final event when the provider closes without a newline', async () => {
    const text = 'data: {"choices":[{"delta":{"content":"answer"}}]}';
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
    const text = 'data: {"choices":[{"delta":{"content":"answer"}}]}\r\n';
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
});
