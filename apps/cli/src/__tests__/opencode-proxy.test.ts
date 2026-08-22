import { afterEach, describe, expect, test } from 'bun:test';

import { type RunningOpenCodeProxy, startOpenCodeProxy } from '../api/sdk.ts';

type UpstreamCapture = {
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  body: string;
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function track(proxy: RunningOpenCodeProxy): RunningOpenCodeProxy {
  cleanups.push(() => proxy.close());
  return proxy;
}

describe('startOpenCodeProxy HTTP', () => {
  test('injects the bearer token and forwards method, path, query, and body', async () => {
    const captures: UpstreamCapture[] = [];
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        captures.push({
          method: req.method,
          path: url.pathname,
          search: url.search,
          authorization: req.headers.get('authorization'),
          body: await req.text(),
        });
        return Response.json({ ok: true });
      },
    });
    cleanups.push(() => upstream.stop(true));

    const proxy = track(
      startOpenCodeProxy({ runtimeUrl: `http://127.0.0.1:${upstream.port}`, token: 'tok-123' }),
    );

    const get = await fetch(`${proxy.url}/session/abc?limit=2`);
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ ok: true });

    const post = await fetch(`${proxy.url}/session/abc/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hi' }),
    });
    expect(post.status).toBe(200);

    expect(captures).toHaveLength(2);
    expect(captures[0]).toMatchObject({
      method: 'GET',
      path: '/session/abc',
      search: '?limit=2',
      authorization: 'Bearer tok-123',
    });
    expect(captures[1]).toMatchObject({
      method: 'POST',
      path: '/session/abc/message',
      authorization: 'Bearer tok-123',
      body: '{"text":"hi"}',
    });
  });

  test('streams SSE bodies through without buffering the full response', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"first"}\n\n'));
            await gate;
            controller.enqueue(new TextEncoder().encode('data: {"type":"second"}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    cleanups.push(() => upstream.stop(true));

    const proxy = track(
      startOpenCodeProxy({ runtimeUrl: `http://127.0.0.1:${upstream.port}`, token: 'tok-123' }),
    );

    const response = await fetch(`${proxy.url}/global/event`);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('"first"');

    release?.();
    const second = await reader.read();
    expect(decoder.decode(second.value)).toContain('"second"');
    await reader.cancel();
  });

  test('keeps an idle SSE stream open past the 10s Bun.serve default idleTimeout', async () => {
    let push: ((data: string) => void) | undefined;
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 0,
      fetch: () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected"}\n\n'));
            push = (data) => {
              controller.enqueue(new TextEncoder().encode(data));
              controller.close();
            };
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    cleanups.push(() => upstream.stop(true));

    const proxy = track(
      startOpenCodeProxy({ runtimeUrl: `http://127.0.0.1:${upstream.port}`, token: 'tok-123' }),
    );

    const response = await fetch(`${proxy.url}/global/event`);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = await reader.read();
    expect(decoder.decode(first.value)).toContain('server.connected');

    await new Promise((resolve) => setTimeout(resolve, 11_000));
    push?.('data: {"type":"after-idle"}\n\n');
    const second = await reader.read();
    expect(second.done).toBe(false);
    expect(decoder.decode(second.value)).toContain('after-idle');
  }, 20_000);

  test('returns 502 when the upstream is unreachable', async () => {
    const dead = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
    const deadUrl = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);

    const proxy = track(startOpenCodeProxy({ runtimeUrl: deadUrl, token: 'tok-123' }));

    const response = await fetch(`${proxy.url}/session/abc`);
    expect(response.status).toBe(502);
  });
});

describe('startOpenCodeProxy WebSocket', () => {
  test('mirrors messages and appends the token as a query param upstream', async () => {
    const seen: { token: string | null } = { token: null };
    const upstream = Bun.serve<{ token: string | null }>({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (req, server) => {
        const url = new URL(req.url);
        seen.token = url.searchParams.get('token');
        if (server.upgrade(req, { data: { token: seen.token } })) return undefined;
        return new Response('no upgrade', { status: 400 });
      },
      websocket: {
        message(ws, message) {
          ws.send(`echo:${message}`);
        },
      },
    });
    cleanups.push(() => upstream.stop(true));

    const proxy = track(
      startOpenCodeProxy({ runtimeUrl: `http://127.0.0.1:${upstream.port}`, token: 'tok-123' }),
    );

    const ws = new WebSocket(`${proxy.url.replace('http:', 'ws:')}/pty/main`);
    const echoed = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws echo timeout')), 5000);
      ws.onmessage = (event) => {
        clearTimeout(timer);
        resolve(String(event.data));
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('ws error'));
      };
      ws.onopen = () => ws.send('ping');
    });
    ws.close();

    expect(echoed).toBe('echo:ping');
    expect(seen.token).toBe('tok-123');
  });
});

describe('startOpenCodeProxy lifecycle', () => {
  test('close() tears the loopback listener down', async () => {
    const upstream = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    cleanups.push(() => upstream.stop(true));

    const proxy = startOpenCodeProxy({
      runtimeUrl: `http://127.0.0.1:${upstream.port}`,
      token: 'tok-123',
    });
    const before = await fetch(`${proxy.url}/session/abc`);
    expect(before.status).toBe(200);

    proxy.close();
    await expect(fetch(`${proxy.url}/session/abc`)).rejects.toThrow();
  });
});
