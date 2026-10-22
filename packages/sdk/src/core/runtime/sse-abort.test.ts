import { afterEach, expect, test } from 'bun:test';
import { fetchEventTransport } from './runtime-rest-client';

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

// Bun 1.4 rejects `reader.cancel()` with an AbortError when the request signal
// aborted first. The transport used `void reader.cancel()`, so closing a live
// stream surfaced as an unhandled rejection and failed the running test.
test('closing a live SSE stream leaves no unhandled rejection', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"n":1}\n\n'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  servers.push(server);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const controller = new AbortController();
    const messages: string[] = [];
    try {
      for await (const message of fetchEventTransport()({
        url: server.url.href,
        headers: new Headers(),
        signal: controller.signal,
      })) {
        messages.push(message.data ?? '');
        setTimeout(() => controller.abort(), 50);
      }
    } catch {
      // the abort may end the iteration with an error
    }
    await Bun.sleep(200);
    expect(messages).toEqual(['{"n":1}']);
    expect(unhandled).toEqual([]);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});
