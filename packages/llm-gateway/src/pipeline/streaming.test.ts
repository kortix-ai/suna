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
