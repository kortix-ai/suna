import { describe, expect, test } from 'bun:test';
import fixture from './runtime-rest-client.fixture.json';
import { RUNTIME_REST_ROUTES, createRuntimeRestClient } from './runtime-rest-client';

/**
 * `runtime-rest-client.fixture.json` holds, per route, the parameters sent and
 * the request the generated `@opencode-ai/sdk` 1.18.23 client made for them
 * (recorded before this package dropped that dependency). The client must send
 * the same method, URL (path encoding and query order), content type and body.
 */
type Recorded = { method: string; url: string; contentType: string | null; body: string | null };
const BASE = 'http://runtime.test/p/sbx 1/8000';

function recordingClient(response: () => Response = () => Response.json({})) {
  const requests: Recorded[] = [];
  const client = createRuntimeRestClient({
    baseUrl: BASE,
    fetch: (async (request: Request) => {
      requests.push({
        method: request.method,
        url: request.url,
        contentType: request.headers.get('content-type'),
        body: request.body ? await request.text() : null,
      });
      return response();
    }) as typeof fetch,
  });
  return { client, requests };
}

function method(client: unknown, name: string): (...args: unknown[]) => Promise<unknown> {
  const keys = name.split('.');
  const owner = keys.slice(0, -1).reduce((o, k) => (o as Record<string, unknown>)[k], client) as Record<string, unknown>;
  return (...args) => (owner[keys.at(-1)!] as (...a: unknown[]) => Promise<unknown>)(...args);
}

describe('runtime REST client requests', () => {
  const entries = Object.entries(fixture as Record<string, { params: Record<string, unknown> | null; request: Recorded }>);

  test('the fixture covers every route', () => {
    expect(entries.map(([name]) => name).sort()).toEqual(Object.keys(RUNTIME_REST_ROUTES).sort());
  });

  test.each(entries)('%s sends the recorded request', async (name, { params, request }) => {
    const { client, requests } = recordingClient();
    await (params === null ? method(client, name)() : method(client, name)(params));
    expect(requests).toHaveLength(1);
    const sent = requests[0]!;
    expect({ method: sent.method, url: sent.url, contentType: sent.contentType }).toEqual({
      method: request.method,
      url: request.url,
      contentType: request.contentType,
    });
    expect(sent.body === null ? null : JSON.parse(sent.body)).toEqual(
      request.body === null ? null : JSON.parse(request.body),
    );
  });

  test('an undefined body field still sends a JSON body; an absent one sends none', async () => {
    const { client, requests } = recordingClient();
    await client.session.revert({ sessionID: 's', messageID: undefined });
    await client.session.revert({ sessionID: 's' });
    expect(requests.map((r) => [r.contentType, r.body])).toEqual([
      ['application/json', '{}'],
      [null, null],
    ]);
  });

  test('passes the abort signal through', async () => {
    let seen: AbortSignal | undefined;
    const controller = new AbortController();
    const client = createRuntimeRestClient({
      baseUrl: BASE,
      fetch: (async (request: Request) => {
        seen = request.signal;
        return Response.json([]);
      }) as typeof fetch,
    });
    await client.session.messages({ sessionID: 's', limit: 1 }, { signal: controller.signal });
    controller.abort();
    expect(seen?.aborted).toBe(true);
  });
});

describe('runtime REST client results', () => {
  test('a 2xx JSON body is data', async () => {
    const { client } = recordingClient(() => Response.json([{ id: 's1' }]));
    const result = await client.session.list();
    expect(result.data as unknown).toEqual([{ id: 's1' }]);
    expect(result.error).toBeUndefined();
    expect(result.response.status).toBe(200);
  });

  test('an empty JSON answer is an empty object; one with no content type is null', async () => {
    const json = recordingClient(() => new Response(null, { status: 204, headers: { 'content-type': 'application/json' } }));
    expect((await json.client.session.promptAsync({ sessionID: 's', parts: [] })).data).toEqual({});
    const bare = recordingClient(() => new Response(null, { status: 204 }));
    expect((await bare.client.session.promptAsync({ sessionID: 's', parts: [] })).data).toBeNull();
  });

  test('a non-2xx answer resolves with the parsed error body', async () => {
    const { client } = recordingClient(() => Response.json({ name: 'NotFoundError', data: { message: 'gone' } }, { status: 404 }));
    const result = await client.session.get({ sessionID: 's' });
    expect(result.data).toBeUndefined();
    expect(result.error).toEqual({ name: 'NotFoundError', data: { message: 'gone' } });
    expect(result.response.status).toBe(404);
  });

  test('a non-JSON error body is the error text; an empty one is {}', async () => {
    const text = recordingClient(() => new Response('upstream down', { status: 503 }));
    expect((await text.client.session.status()).error).toBe('upstream down');
    const empty = recordingClient(() => new Response('', { status: 502 }));
    expect((await empty.client.session.status()).error).toEqual({});
  });

  test('a request that gets no answer resolves with the thrown error', async () => {
    const failure = new TypeError('network down');
    const client = createRuntimeRestClient({
      baseUrl: BASE,
      fetch: (async () => {
        throw failure;
      }) as unknown as typeof fetch,
    });
    const result = await client.permission.list();
    expect(result.error).toBe(failure);
    expect(result.response).toBeUndefined();
  });

  test('an HTML answer rejects: the runtime has no such route', async () => {
    const { client } = recordingClient(() => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }));
    await expect(client.global.dispose()).rejects.toThrow('text/html');
  });
});

describe('runtime event stream', () => {
  function sse(body: string, status = 200): Response {
    return new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });
  }

  test('yields each event, JSON-parsed when it is JSON', async () => {
    const requests: Request[] = [];
    const client = createRuntimeRestClient({
      baseUrl: BASE,
      fetch: (async (request: Request) => {
        requests.push(request);
        return sse('id: 1:1\ndata: {"type":"session.idle","properties":{"sessionID":"s"}}\n\n: comment\n\ndata: plain\r\n\r\nretry: 10\n\n');
      }) as typeof fetch,
    });
    const { stream } = await client.global.event({ sseMaxRetryAttempts: 1 });
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([{ type: 'session.idle', properties: { sessionID: 's' } }, 'plain']);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('http://runtime.test/p/sbx%201/8000/global/event');
  });

  test('with one attempt, a failed connect ends the stream and reports the error', async () => {
    const errors: unknown[] = [];
    const client = createRuntimeRestClient({ baseUrl: BASE, fetch: (async () => sse('', 503)) as unknown as typeof fetch });
    const { stream } = await client.global.event({ sseMaxRetryAttempts: 1, onSseError: (e) => errors.push(e) });
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([]);
    expect(String(errors[0])).toContain('SSE failed: 503');
  });

  test('a dropped stream reconnects with the last event id', async () => {
    const lastIds: Array<string | null> = [];
    const client = createRuntimeRestClient({
      baseUrl: BASE,
      fetch: (async (request: Request) => {
        lastIds.push(request.headers.get('last-event-id'));
        if (lastIds.length > 1) return sse('', 500);
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (pulls++ === 0) controller.enqueue(new TextEncoder().encode('id: 7\ndata: {"n":1}\n\n'));
            else controller.error(new Error('connection reset'));
          },
        });
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      }) as typeof fetch,
    });
    const { stream } = await client.global.event({ sseMaxRetryAttempts: 2, sseDefaultRetryDelay: 1 });
    const events: unknown[] = [];
    for await (const event of stream) events.push(event);
    expect(events).toEqual([{ n: 1 }]);
    expect(lastIds).toEqual([null, '7']);
  });
});
