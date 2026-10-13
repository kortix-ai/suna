import { afterEach, describe, expect, test } from 'bun:test';
import { createSSEStream } from './fetch-sse';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function serve(chunks: string[]): void {
  const encoder = new TextEncoder();
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    )) as unknown as typeof fetch;
}

async function run(chunks: string[]) {
  serve(chunks);
  const events: Array<[string, string]> = [];
  let closed = false;
  const stream = createSSEStream({
    url: 'http://x/y',
    token: 't',
    onEvent: (event, data) => events.push([event, data]),
    onClose: () => {
      closed = true;
    },
  });
  await stream.connect();
  return { events, closed };
}

describe('createSSEStream framing (04#10)', () => {
  test('a CRLF stream dispatches its events', async () => {
    const { events } = await run(['event: a\r\ndata: 1\r\n\r\nevent: b\r\ndata: 2\r\n\r\n']);
    expect(events).toEqual([['a', '1'], ['b', '2']]);
  });

  test('an event with no data does not leak its name into the next data-only event', async () => {
    const { events } = await run(['event: ping\n\ndata: hello\n\n']);
    expect(events).toEqual([['message', 'hello']]);
  });

  test('a frame split across chunks, mid-line and mid-CRLF, is dispatched once', async () => {
    const { events } = await run(['event: a\r', '\ndata: 1', '\r\n\r', '\n']);
    expect(events).toEqual([['a', '1']]);
  });

  test('a clean end of stream calls onClose, so "ended" is distinguishable from "idle"', async () => {
    const { closed } = await run(['data: 1\n\n']);
    expect(closed).toBe(true);
  });

  test('works on a runtime without AbortSignal.any', async () => {
    const original = AbortSignal.any;
    // @ts-expect-error simulate React Native / older Safari
    AbortSignal.any = undefined;
    try {
      serve(['data: 1\n\n']);
      const events: string[] = [];
      const errors: Error[] = [];
      const stream = createSSEStream({
        url: 'http://x/y',
        token: 't',
        signal: new AbortController().signal,
        onEvent: (_e, d) => events.push(d),
        onError: (e) => errors.push(e),
      });
      await stream.connect();
      expect(errors).toEqual([]);
      expect(events).toEqual(['1']);
    } finally {
      AbortSignal.any = original;
    }
  });
});
