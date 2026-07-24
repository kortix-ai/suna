import { afterEach, describe, expect, test } from 'bun:test';
import { openKortixPtyWebSocket } from '../api/sandbox-proxy';

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

describe('Kortix PTY WebSocket', () => {
  test('sends the CLI User-Agent during the WebSocket upgrade', async () => {
    let userAgent: string | null = null;

    server = Bun.serve({
      port: 0,
      fetch(request, bunServer) {
        userAgent = request.headers.get('user-agent');
        if (bunServer.upgrade(request, { data: undefined })) return;
        return new Response('upgrade failed', { status: 500 });
      },
      websocket: {
        open(websocket) {
          websocket.close(1000, 'test complete');
        },
        message() {},
      },
    });

    const websocket = openKortixPtyWebSocket(
      `ws://127.0.0.1:${server.port}/kortix/pty/test/connect`,
    );
    await new Promise<void>((resolve, reject) => {
      websocket.addEventListener('open', () => resolve(), { once: true });
      websocket.addEventListener('error', () => reject(new Error('WebSocket upgrade failed')), {
        once: true,
      });
    });

    expect(userAgent).toStartWith('kortix-cli/');
  });
});
