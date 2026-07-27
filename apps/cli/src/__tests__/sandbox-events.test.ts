/**
 * Contract tests for the SSE transport, pinned against a real local SSE server.
 *
 * This is the file that proves the transport with the dev stack down: the frame
 * layout, both wire shapes, the reconnect loop, the gap signal, and the parked
 * terminal state are all exercised end to end over a socket. What it CANNOT
 * prove is the exact bytes a live sandbox daemon emits — hence the parser
 * accepting both the `{payload}` wrapper and a bare event body.
 */

import { afterEach, describe, expect, test } from 'bun:test';

import {
  openSessionEventStream,
  parseSseFrame,
  sandboxEventUrl,
  splitSseFrames,
  type EventStreamTimers,
  type SandboxEvent,
} from '../api/sandbox-events.ts';

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(() => {
  server?.stop(true);
  server = null;
});

const SSE_HEADERS = { 'Content-Type': 'text/event-stream' } as const;

/** Real timers, compressed, with a virtual clock the test can jump forward.
 *  Keeps reconnect/backoff assertions in milliseconds instead of minutes. */
function fastClock(): { timers: EventStreamTimers; advance: (ms: number) => void } {
  let offset = 0;
  return {
    timers: {
      now: () => Date.now() + offset,
      setTimeout: (handler, ms) => setTimeout(handler, Math.min(ms ?? 0, 5)),
      clearTimeout: (handle) => clearTimeout(handle),
    },
    advance: (ms) => {
      offset += ms;
    },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error('timed out waiting for condition');
}

function auth() {
  return { api_base: `http://127.0.0.1:${server!.port}`, token: 'kortix_pat_test' };
}

describe('SSE frame parsing', () => {
  test('splits on the blank-line separator and keeps the unterminated remainder', () => {
    const split = splitSseFrames('data: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"ty');

    expect(split.frames).toEqual(['data: {"type":"a"}', 'data: {"type":"b"}']);
    expect(split.rest).toBe('data: {"ty');
  });

  test('tolerates CRLF, which any proxy hop may introduce', () => {
    const split = splitSseFrames('data: {"type":"a"}\r\n\r\n');

    expect(split.frames).toEqual(['data: {"type":"a"}']);
  });

  test('joins multi-line data fields — a big JSON payload is legally split', () => {
    const event = parseSseFrame('data: {"type":\ndata: "message.updated"}');

    expect(event?.type).toBe('message.updated');
  });

  test('unwraps the GlobalEvent envelope and accepts a bare event body', () => {
    const wrapped = parseSseFrame('data: {"directory":"/x","payload":{"type":"session.idle"}}');
    const bare = parseSseFrame('data: {"type":"session.idle"}');

    expect(wrapped?.type).toBe('session.idle');
    expect(bare?.type).toBe('session.idle');
  });

  test('ignores comments, event/id fields, and unparseable frames', () => {
    expect(parseSseFrame(': keepalive')).toBeNull();
    expect(parseSseFrame('event: ping\nid: 4')).toBeNull();
    expect(parseSseFrame('data: not json')).toBeNull();
    expect(parseSseFrame('data: {"noType":true}')).toBeNull();
  });

  test('builds the same proxy URL shape every other sandbox call uses', () => {
    expect(sandboxEventUrl('https://api.kortix.com/', 'sbx-1', 8000)).toBe(
      'https://api.kortix.com/v1/p/sbx-1/8000/global/event',
    );
  });
});

describe('openSessionEventStream', () => {
  test('sends bearer auth + the Accept header the API keys its SSE exemption on', async () => {
    let seen: Record<string, string> = {};
    server = Bun.serve({
      port: 0,
      fetch(req) {
        seen = {
          authorization: req.headers.get('authorization') ?? '',
          accept: req.headers.get('accept') ?? '',
          path: new URL(req.url).pathname,
        };
        return new Response('data: {"type":"session.idle"}\n\n', { headers: SSE_HEADERS });
      },
    });
    const events: SandboxEvent[] = [];
    const clock = fastClock();
    const stream = openSessionEventStream({
      auth: auth(),
      proxyId: 'sbx-1',
      port: 8000,
      onEvent: (e) => events.push(e),
      timers: clock.timers,
    });

    await waitFor(() => events.length > 0);
    stream.close();

    expect(seen.authorization).toBe('Bearer kortix_pat_test');
    expect(seen.accept).toBe('text/event-stream');
    expect(seen.path).toBe('/v1/p/sbx-1/8000/global/event');
    expect(events[0]!.type).toBe('session.idle');
  });

  test('reconnects after the server closes the stream and keeps delivering', async () => {
    let connections = 0;
    server = Bun.serve({
      port: 0,
      fetch() {
        connections += 1;
        const n = connections;
        return new Response(`data: {"type":"tick","properties":{"n":${n}}}\n\n`, {
          headers: SSE_HEADERS,
        });
      },
    });
    const events: SandboxEvent[] = [];
    const clock = fastClock();
    const stream = openSessionEventStream({
      auth: auth(),
      proxyId: 'sbx-1',
      port: 8000,
      onEvent: (e) => events.push(e),
      timers: clock.timers,
    });

    await waitFor(() => events.length >= 2);
    stream.close();

    expect(events.map((e) => (e.properties as { n: number }).n)).toEqual([1, 2]);
    expect(connections).toBeGreaterThanOrEqual(2);
  });

  test('a reconnect after a >5s gap asks the host to rehydrate', async () => {
    const clock = fastClock();
    let live: ReadableStreamDefaultController<Uint8Array> | null = null;
    let connections = 0;
    server = Bun.serve({
      port: 0,
      fetch() {
        connections += 1;
        if (connections > 1) return new Response('', { headers: SSE_HEADERS });
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              // A comment frame flushes the headers without counting as an
              // event, so the attempt stays "quiet but healthy".
              controller.enqueue(new TextEncoder().encode(': keepalive\n\n'));
              live = controller;
            },
          }),
          { headers: SSE_HEADERS },
        );
      },
    });
    const gaps: number[] = [];
    let connected = 0;
    const stream = openSessionEventStream({
      auth: auth(),
      proxyId: 'sbx-1',
      port: 8000,
      onEvent: () => {},
      onConnected: () => {
        connected += 1;
      },
      onGapRehydrate: (gapMs) => gaps.push(gapMs),
      timers: clock.timers,
    });

    await waitFor(() => connected >= 1 && live !== null);
    // The stream was healthy for six seconds and then dropped: everything the
    // server emitted in that window is gone unless the host re-reads history.
    clock.advance(6_000);
    live!.close();
    await waitFor(() => gaps.length >= 1);
    stream.close();

    expect(gaps[0]).toBeGreaterThan(5_000);
  });

  test('parks after consecutive hard failures instead of 503-looping forever', async () => {
    let requests = 0;
    server = Bun.serve({
      port: 0,
      fetch() {
        requests += 1;
        return new Response('gone', { status: 503 });
      },
    });
    const clock = fastClock();
    let parked: { consecutiveFailures: number } | null = null;
    const stream = openSessionEventStream({
      auth: auth(),
      proxyId: 'sbx-1',
      port: 8000,
      onEvent: () => {},
      onParked: (info) => {
        parked = info;
      },
      maxConsecutiveHardFailures: 3,
      timers: clock.timers,
    });

    await waitFor(() => parked !== null);
    const requestsAtPark = requests;
    await Bun.sleep(30);
    stream.close();

    expect(parked!.consecutiveFailures).toBe(3);
    // Terminal: no further connect attempts once parked.
    expect(requests).toBe(requestsAtPark);
  });

  test('an established but silent stream is torn down by the heartbeat watchdog', async () => {
    let connections = 0;
    server = Bun.serve({
      port: 0,
      fetch() {
        connections += 1;
        return new Response(
          new ReadableStream({
            pull() {
              // Never resolves — a healthy-looking socket that says nothing.
              return new Promise<void>(() => {});
            },
          }),
          { headers: SSE_HEADERS },
        );
      },
    });
    const clock = fastClock();
    const stream = openSessionEventStream({
      auth: auth(),
      proxyId: 'sbx-1',
      port: 8000,
      onEvent: () => {},
      heartbeatTimeoutMs: 20,
      timers: clock.timers,
    });

    await waitFor(() => connections >= 2);
    stream.close();

    expect(connections).toBeGreaterThanOrEqual(2);
  });

  test('close() stops the loop for good', async () => {
    let connections = 0;
    server = Bun.serve({
      port: 0,
      fetch() {
        connections += 1;
        return new Response('data: {"type":"tick"}\n\n', { headers: SSE_HEADERS });
      },
    });
    const clock = fastClock();
    let events = 0;
    const stream = openSessionEventStream({
      auth: auth(),
      proxyId: 'sbx-1',
      port: 8000,
      onEvent: () => {
        events += 1;
      },
      timers: clock.timers,
    });

    await waitFor(() => events >= 1);
    stream.close();
    const after = connections;
    await Bun.sleep(40);

    expect(connections).toBe(after);
  });
});
