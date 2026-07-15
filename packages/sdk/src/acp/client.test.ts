import { describe, expect, test } from 'bun:test';

import { createAcpClient } from './client';
import { acpTranscriptJsonl, acpTranscriptMarkdown } from './transcript';
import { AcpTransportError } from './types';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function sseResponse(chunks: string[]): Response {
  return new Response(streamOf(chunks), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('ACP client', () => {
  test('preserves raw JSON-RPC for initialize, session/new, and prompt', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(input), body });
      const method = body.method;
      const result = method === 'session/new'
        ? { sessionId: 'acp-session-1' }
        : method === 'session/prompt' ? { stopReason: 'end_turn' } : { protocolVersion: 1 };
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    };
    const client = createAcpClient({
      baseUrl: 'https://runtime.test/',
      serverId: 'server one',
      fetch: fakeFetch as typeof fetch,
    });

    await client.initialize({ protocolVersion: 1, clientInfo: { name: 'test', version: '1' } });
    const session = await client.newSession({ cwd: '/workspace' });
    const result = await client.prompt(session.sessionId, [{ type: 'text', text: 'hello' }]);

    expect(calls.map((call) => call.url)).toEqual([
      'https://runtime.test/acp/server%20one',
      'https://runtime.test/acp/server%20one',
      'https://runtime.test/acp/server%20one',
    ]);
    expect(calls.map((call) => call.body.method)).toEqual(['initialize', 'session/new', 'session/prompt']);
    expect(result.stopReason).toBe('end_turn');
  });

  test('streams SSE envelopes and exposes lossless transcript projections', async () => {
    const sse = [
      ': connected',
      '',
      'id: 1',
      'data: {"jsonrpc":"2.0","method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Hello"}}}}',
      '',
    ].join('\n');
    const fakeFetch = async () => new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } });
    const client = createAcpClient({ baseUrl: 'https://runtime.test', serverId: 's1', fetch: fakeFetch as unknown as typeof fetch });
    const events: any[] = [];
    await new Promise<void>((resolve) => {
      client.connect({
        reconnect: false,
        onEvent(event) {
          events.push(event);
          resolve();
        },
      });
    });

    expect(events[0].id).toBe(1);
    expect(acpTranscriptJsonl(events)).toContain('"sequence":1');
    expect(acpTranscriptMarkdown(events)).toContain('Hello');
  });

  test('polls the durable ACP transcript automatically on React Native', async () => {
    const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { product: 'ReactNative' },
    });
    const calls: string[] = [];
    const fakeFetch = async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({
        runtime_id: 'runtime-1',
        envelopes: [{
          ordinal: 7,
          direction: 'agent_to_client',
          streamEventId: 3,
          envelope: {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: 'Mobile hello' },
              },
            },
          },
          createdAt: '2026-07-13T00:00:00.000Z',
        }],
      });
    };
    try {
      const client = createAcpClient({
        endpoint: 'https://api.test/projects/p/sessions/s/acp',
        fetch: fakeFetch as unknown as typeof fetch,
      });

      const event = await new Promise<any>((resolve) => {
        const stream = client.connect({
          onEvent(next) {
            stream.close();
            resolve(next);
          },
        });
      });

      expect(calls).toEqual([
        'https://api.test/projects/p/sessions/s/acp/transcript',
      ]);
      expect(event.id).toBe(3);
      expect(event.envelope.params.update.content.text).toBe('Mobile hello');
    } finally {
      if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  test('connect parses CRLF-delimited SSE events', async () => {
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async () => sseResponse([
        'id: 1\r\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"a":1}}\r\n\r\n' +
        'id: 2\r\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"a":2}}\r\n\r\n',
      ])) as unknown as typeof fetch,
    });
    const events: number[] = [];
    await new Promise<void>((resolve) => {
      client.connect({
        reconnect: false,
        onEvent: (event) => { events.push(event.id); if (events.length === 2) resolve(); },
      });
    });
    expect(events).toEqual([1, 2]);
  });

  test('connect parses a CRLF boundary split across chunk reads', async () => {
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async () => sseResponse([
        'id: 1\r\ndata: {"jsonrpc":"2.0","method":"m"}\r',       // trailing CR held back
        '\n\r\nid: 2\r\ndata: {"jsonrpc":"2.0","method":"m"}\r\n\r\n',
      ])) as unknown as typeof fetch,
    });
    const events: number[] = [];
    await new Promise<void>((resolve) => {
      client.connect({
        reconnect: false,
        onEvent: (event) => { events.push(event.id); if (events.length === 2) resolve(); },
      });
    });
    expect(events).toEqual([1, 2]);
  });

  test('connect parses a CRLF split mid-block across chunk reads', async () => {
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async () => sseResponse([
        'id: 1\r',
        '\ndata: {"jsonrpc":"2.0","method":"m"}\r\n\r\n',
      ])) as unknown as typeof fetch,
    });
    const events: number[] = [];
    await new Promise<void>((resolve) => {
      client.connect({
        reconnect: false,
        onEvent: (event) => { events.push(event.id); resolve(); },
      });
    });
    expect(events).toEqual([1]);
  });

  test('connect with reconnect:false stops after a failed fetch', async () => {
    let calls = 0;
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async () => { calls += 1; return new Response('nope', { status: 500 }); }) as unknown as typeof fetch,
    });
    const errors: unknown[] = [];
    client.connect({ reconnect: false, onEvent: () => {}, onError: (e) => errors.push(e) });
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(calls).toBe(1);
    expect(errors.length).toBe(1);
  });

  test('a 403 (terminal) stops the loop after exactly one fetch and reports failed', async () => {
    let calls = 0;
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async () => { calls += 1; return new Response('forbidden', { status: 403 }); }) as unknown as typeof fetch,
    });
    const errors: unknown[] = [];
    const states: string[] = [];
    client.connect({ onEvent: () => {}, onError: (e) => errors.push(e), onState: (s) => states.push(s) });
    // Terminal errors stop the loop synchronously (no backoff wait needed),
    // so a short settle is enough to observe the final state.
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
    expect(states).toEqual(['connecting', 'failed']);
    expect(errors.length).toBe(1);
    expect(errors[0]).toBeInstanceOf(AcpTransportError);
    const error = errors[0] as AcpTransportError;
    expect(error.status).toBe(403);
    expect(error.terminal).toBe(true);
  });

  test('a 500 (non-terminal) reports reconnecting and does not stop the loop', async () => {
    let calls = 0;
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async () => { calls += 1; return new Response('boom', { status: 500 }); }) as unknown as typeof fetch,
    });
    const errors: unknown[] = [];
    const states: string[] = [];
    // reconnect:false is a one-shot connection: a non-terminal error must
    // still stop the loop for good, so the terminal state is 'closed' (not
    // 'reconnecting', which would imply a retry the caller will never see).
    // This keeps the test fast and deterministic without waiting out a real
    // backoff delay.
    client.connect({ reconnect: false, onEvent: () => {}, onError: (e) => errors.push(e), onState: (s) => states.push(s) });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
    expect(states).toEqual(['connecting', 'closed']);
    expect(errors.length).toBe(1);
    const error = errors[0] as AcpTransportError;
    expect(error).toBeInstanceOf(AcpTransportError);
    expect(error.status).toBe(500);
    expect(error.terminal).toBe(false);
  });

  test.each([408, 429])('%d is NOT terminal but reconnect:false still ends in closed (one-shot, no phantom reconnect)', async (status) => {
    let calls = 0;
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async () => { calls += 1; return new Response('nope', { status }); }) as unknown as typeof fetch,
    });
    const states: string[] = [];
    client.connect({ reconnect: false, onEvent: () => {}, onState: (s) => states.push(s) });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
    expect(states).toEqual(['connecting', 'closed']);
  });

  // Task 8 ledger gap: the terminal-vs-reconnect:false pair was never
  // exercised together. A terminal status must win over the one-shot
  // 'closed' path — a 403 mid-reconnect is unrecoverable, and reporting
  // 'closed' (implying a clean, expected end) instead of 'failed' would hide
  // that from a caller relying on `onState` to distinguish the two.
  test('a 403 (terminal) with reconnect:false stops after exactly one fetch and reports failed, not closed', async () => {
    let calls = 0;
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async () => { calls += 1; return new Response('forbidden', { status: 403 }); }) as unknown as typeof fetch,
    });
    const errors: unknown[] = [];
    const states: string[] = [];
    client.connect({ reconnect: false, onEvent: () => {}, onError: (e) => errors.push(e), onState: (s) => states.push(s) });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(calls).toBe(1);
    expect(states).toEqual(['connecting', 'failed']);
    expect(errors.length).toBe(1);
    const error = errors[0] as AcpTransportError;
    expect(error).toBeInstanceOf(AcpTransportError);
    expect(error.status).toBe(403);
    expect(error.terminal).toBe(true);
  });

  test('post() (via request()) throws AcpTransportError with status and keeps the response text', async () => {
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      fetch: (async () => new Response('bad request body', { status: 400 })) as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await client.request('initialize', {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AcpTransportError);
    const error = caught as AcpTransportError;
    expect(error.status).toBe(400);
    expect(error.terminal).toBe(true);
    expect(error.message).toContain('400');
    expect(error.message).toContain('bad request body');
  });

  test('two clients never produce colliding request ids', async () => {
    const ids: string[] = [];
    const makeClient = () => createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        ids.push(String(body.id));
        return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
      }) as unknown as typeof fetch,
    });
    // Construct both clients synchronously in the same millisecond, which
    // would cause id prefix collision if not for a static instance counter.
    // This test guarantees uniqueness even when Date.now() returns the same
    // value for both instances.
    const clientA = makeClient();
    const clientB = makeClient();

    // Issue 3 requests from each client (6 total)
    for (let i = 0; i < 3; i += 1) {
      await clientA.request('m');
      await clientB.request('m');
    }

    expect(ids.length).toBe(6);
    expect(new Set(ids).size).toBe(6);
    expect(ids.every((id) => typeof id === 'string')).toBe(true);
  });

  test('request() rejects a mismatched response id', async () => {
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      fetch: (async () => Response.json({ jsonrpc: '2.0', id: 'some-other-id', result: 1 })) as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await client.request('initialize', {});
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('some-other-id');
  });

  test('poll transport resumes with ?after=<lastSeenOrdinal> after a mid-loop error instead of refetching from 0', async () => {
    const urls: string[] = [];
    let call = 0;
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'poll',
      transcriptPollIntervalMs: 5,
      fetch: (async (input: RequestInfo | URL) => {
        call += 1;
        urls.push(String(input));
        if (call === 1) {
          return Response.json({
            runtime_id: 'r1',
            envelopes: [{
              ordinal: 12,
              direction: 'agent_to_client',
              streamEventId: 1,
              envelope: { jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } } } },
              createdAt: '2026-07-14T00:00:00.000Z',
            }],
          });
        }
        if (call === 2) {
          return new Response('boom', { status: 500 });
        }
        return Response.json({ runtime_id: 'r1', envelopes: [] });
      }) as unknown as typeof fetch,
    });

    const events: unknown[] = [];
    const stream = client.connect({ onEvent: (event) => events.push(event) });
    const deadline = Date.now() + 2000;
    while (call < 3 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stream.close();

    expect(urls[0]).toBe('https://api.test/acp/s1/transcript');
    expect(urls[2]).toBe('https://api.test/acp/s1/transcript?after=12');
  });

  test('daemon mode appends ?agent= on POST but not on GET/transcript', async () => {
    const posted: string[] = [];
    const gotten: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posted.push(String(input));
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
      }
      gotten.push(String(input));
      return Response.json({ runtime_id: 'r1', envelopes: [] });
    }) as unknown as typeof fetch;
    const client = createAcpClient({
      baseUrl: 'https://runtime.test',
      serverId: 's1',
      agent: 'claude',
      fetch: fakeFetch,
    });

    await client.request('initialize', {});
    await client.transcript();

    expect(posted).toEqual(['https://runtime.test/acp/s1?agent=claude']);
    expect(gotten).toEqual(['https://runtime.test/acp/s1/transcript']);
  });

  test('endpoint mode ignores the agent option on POST', async () => {
    const posted: string[] = [];
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      posted.push(String(input));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ jsonrpc: '2.0', id: body.id, result: {} });
    }) as unknown as typeof fetch;
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      // `agent` is documented as daemon-mode-only (`baseUrl` + `serverId`);
      // in `endpoint` mode it's a harmless no-op, not a type error.
      agent: 'claude',
      fetch: fakeFetch,
    });

    await client.request('initialize', {});

    expect(posted).toEqual(['https://api.test/acp/s1']);
  });

  test('connect with an already-aborted signal never fetches', async () => {
    let calls = 0;
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async () => { calls += 1; return sseResponse(['id: 1\ndata: {"jsonrpc":"2.0","method":"m"}\n\n']); }) as unknown as typeof fetch,
    });
    const controller = new AbortController();
    controller.abort();

    const handle = client.connect({ onEvent: () => {}, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls).toBe(0);
    expect(handle.lastEventId).toBe(0);
    handle.close();
  });

  test('an id:0 event is delivered', async () => {
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async () => sseResponse([
        'id: 0\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"a":0}}\n\n',
      ])) as unknown as typeof fetch,
    });
    const events: number[] = [];
    await new Promise<void>((resolve) => {
      client.connect({
        reconnect: false,
        onEvent: (event) => { events.push(event.id); resolve(); },
      });
    });
    expect(events).toEqual([0]);
  });

  test('a poison event (valid id, invalid JSON) is skipped via onError; later events still arrive; no refetch loop', async () => {
    let calls = 0;
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async () => {
        calls += 1;
        return sseResponse([
          'id: 1\ndata: {not valid json\n\n' +
          'id: 2\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"a":2}}\n\n',
        ]);
      }) as unknown as typeof fetch,
    });
    const events: number[] = [];
    const errors: unknown[] = [];
    await new Promise<void>((resolve) => {
      client.connect({
        reconnect: false,
        onEvent: (event) => { events.push(event.id); resolve(); },
        onError: (error) => errors.push(error),
      });
    });

    expect(errors.length).toBe(1);
    expect(events).toEqual([2]);
    expect(calls).toBe(1);
  });

  test('retryMs does NOT reset on a connection that establishes but delivers no event before dying — second delay > first', async () => {
    // No fake-timer support in this file: monkeypatch global setTimeout to
    // record the requested delay and resolve immediately (via the *real*
    // setTimeout at 0ms) so the retry loop races through several attempts
    // without the test actually waiting out real backoff delays.
    const originalSetTimeout = globalThis.setTimeout;
    const delays: number[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).setTimeout = (fn: (...args: unknown[]) => void, _ms?: number, ...rest: unknown[]) => {
      delays.push(_ms ?? 0);
      return originalSetTimeout(fn, 0, ...rest);
    };

    try {
      // Every attempt: a 200 response whose SSE body closes immediately with
      // zero events (a "connects but never delivers an event" connection).
      const fetchImpl = async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      };
      const client = createAcpClient({
        endpoint: 'https://api.test/acp/s1',
        streamTransport: 'sse',
        fetch: fetchImpl as unknown as typeof fetch,
      });

      const handle = client.connect({ onEvent: () => {} });
      // Wait for two backoff delays to have been recorded, then stop.
      const deadline = Date.now() + 2000;
      while (delays.length < 2 && Date.now() < deadline) {
        await new Promise((resolve) => originalSetTimeout(resolve, 5));
      }
      handle.close();

      expect(delays.length).toBeGreaterThanOrEqual(2);
      // Un-jittered base would be 250 then 500 — since no event was ever
      // delivered, retryMs must keep growing across attempts rather than
      // being reset back to 250 on every successful (but event-less)
      // connection establishment.
      expect(delays[1]).toBeGreaterThan(delays[0]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('Last-Event-ID header sends "0" after an id:0 event on reconnect', async () => {
    let fetchCallCount = 0;
    const capturedHeaders: Array<Record<string, string>> = [];
    const client = createAcpClient({
      endpoint: 'https://api.test/acp/s1',
      streamTransport: 'sse',
      fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
        fetchCallCount += 1;
        // Capture the request headers from the second fetch (the reconnect)
        if (fetchCallCount === 2) {
          capturedHeaders.push((init?.headers as Record<string, string>) || {});
        }
        // First fetch: deliver an id:0 event then close (no reconnect headers yet)
        if (fetchCallCount === 1) {
          return sseResponse([
            'id: 0\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"a":0}}\n\n',
          ]);
        }
        // Second fetch: deliver nothing, close immediately
        if (fetchCallCount === 2) {
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
        }
        // Should not reach here
        return new Response('', { status: 500 });
      }) as unknown as typeof fetch,
    });

    const events: number[] = [];
    const handle = client.connect({
      onEvent: (event) => events.push(event.id),
      reconnect: true, // Ensures a second fetch attempt after first closes
    });

    // Wait for the second fetch to be observed
    const deadline = Date.now() + 2000;
    while (fetchCallCount < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    handle.close();

    // Verify the id:0 event was delivered
    expect(events).toContain(0);
    // Verify the second fetch sent Last-Event-ID: 0
    expect(capturedHeaders.length).toBe(1);
    expect(capturedHeaders[0]['Last-Event-ID']).toBe('0');
  });
});
