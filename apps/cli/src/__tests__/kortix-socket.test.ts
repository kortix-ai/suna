import { afterEach, describe, expect, test } from 'bun:test';
import { Glob } from 'bun';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openKortixWebSocket } from '../api/kortix-socket.ts';

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

    const websocket = openKortixWebSocket(
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

test('every CLI WebSocket opens through openKortixWebSocket', () => {
  const src = join(import.meta.dir, '..');
  const raw: string[] = [];
  for (const file of new Glob('**/*.ts').scanSync(src)) {
    if (file.includes('__tests__') || file.endsWith('.test.ts')) continue;
    readFileSync(join(src, file), 'utf8').split('\n').forEach((line, i) => {
      if (/\bnew WebSocket\(/.test(line) && !/^\s*(\/\/|\*)/.test(line)) raw.push(`${file}:${i + 1}`);
    });
  }
  expect(raw).toEqual([]);
});
