import { describe, expect, test } from 'bun:test';

import { AcpRpcError, AcpTransportError, createAcpClient } from './client';

function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}

describe('ACP HTTP/SSE client', () => {
  test('correlates JSON-RPC responses and preserves RPC errors', async () => {
    const methods: string[] = [];
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const client = createAcpClient({
      endpoint: 'https://runtime.test/kortix/acp/session',
      fetch: (async (_input, init) => {
        if (!init?.method) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
                controller.enqueue(
                  encoder.encode(
                    'id: 0\ndata: {"jsonrpc":"2.0","method":"kortix/cursor"}\n\n',
                  ),
                );
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        const body = JSON.parse(String(init?.body)) as {
          id: string;
          method: string;
        };
        methods.push(body.method);
        const envelope =
          body.method === 'session/load'
            ? {
                jsonrpc: '2.0',
                id: body.id,
                result: { sessionId: 'ses_1' },
              }
            : {
                jsonrpc: '2.0',
                id: body.id,
                error: { code: -32000, message: 'session missing' },
              };
        queueMicrotask(() =>
          streamController?.enqueue(
            encoder.encode(`id: ${methods.length}\ndata: ${JSON.stringify(envelope)}\n\n`),
          ),
        );
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    });
    const stream = client.connect({ onEvent() {} });
    await stream.ready;

    await expect(client.loadSession({ sessionId: 'ses_1', cwd: '/workspace' })).resolves.toEqual({
      sessionId: 'ses_1',
    });
    await expect(client.request('session/missing', {})).rejects.toEqual(
      new AcpRpcError('session missing', -32000),
    );
    stream.close();
    expect(methods).toEqual(['session/load', 'session/missing']);
  });

  test('sends cancellation as an ACP notification', async () => {
    const bodies: unknown[] = [];
    const client = createAcpClient({
      endpoint: 'https://runtime.test/kortix/acp/session',
      fetch: (async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    });

    await client.cancel('ses_1');
    expect(bodies).toEqual([
      {
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: 'ses_1' },
      },
    ]);
  });

  test('does not apply the generic RPC timeout to a long-running session prompt', async () => {
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
    let promptRequestId: string | null = null;
    const client = createAcpClient({
      endpoint: 'https://runtime.test/kortix/acp/session',
      requestTimeoutMs: 10,
      fetch: (async (_input, init) => {
        if (!init?.method) {
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                streamController = controller;
                controller.enqueue(
                  encoder.encode(
                    'id: 0\ndata: {"jsonrpc":"2.0","method":"kortix/cursor"}\n\n',
                  ),
                );
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          );
        }
        const body = JSON.parse(String(init.body)) as {
          id?: string;
          method?: string;
        };
        if (body.method === 'session/prompt') promptRequestId = body.id ?? null;
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    });
    const stream = client.connect({ onEvent() {} });
    await stream.ready;

    const prompt = client.prompt('ses_1', [{ type: 'text', text: 'long task' }]);
    const earlyOutcome = await Promise.race([
      prompt.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 30)),
    ]);

    expect(earlyOutcome).toBe('pending');
    expect(promptRequestId).not.toBeNull();
    const controller =
      streamController as ReadableStreamDefaultController<Uint8Array> | null;
    controller?.enqueue(
      encoder.encode(
        `id: 1\ndata: ${JSON.stringify({
          jsonrpc: '2.0',
          id: promptRequestId,
          result: { stopReason: 'end_turn' },
        })}\n\n`,
      ),
    );
    await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });
    stream.close();
  });

  test('removes a slash-heavy endpoint suffix before the request', async () => {
    const urls: string[] = [];
    const client = createAcpClient({
      endpoint: `https://runtime.test/kortix/acp/session${'/'.repeat(100_000)}`,
      fetch: (async (input) => {
        urls.push(String(input));
        return new Response(null, { status: 202 });
      }) as typeof fetch,
    });

    await client.cancel('ses_1');

    expect(urls).toEqual(['https://runtime.test/kortix/acp/session']);
  });

  test('streams ordered events and resumes with Last-Event-ID', async () => {
    const headers: Array<Record<string, string>> = [];
    let calls = 0;
    const client = createAcpClient({
      endpoint: 'https://runtime.test/kortix/acp/session',
      fetch: (async (_input, init) => {
        calls += 1;
        headers.push((init?.headers ?? {}) as Record<string, string>);
        if (calls === 1) {
          return sseResponse([
            'id: 1\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"index":1}}\n\n',
            'id: 2\ndata: {"jsonrpc":"2.0","method":"session/update","params":{"index":2}}\n\n',
          ]);
        }
        return sseResponse([]);
      }) as typeof fetch,
    });
    const received: number[] = [];
    const stream = client.connect({
      onEvent(event) {
        received.push(event.id);
      },
    });
    await stream.ready;
    const deadline = Date.now() + 2_000;
    while (calls < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    stream.close();

    expect(received).toEqual([1, 2]);
    expect(headers[0]?.['Last-Event-ID']).toBeUndefined();
    expect(headers[1]?.['Last-Event-ID']).toBe('2');
  });

  test('waits for the bridge cursor before reporting ready', async () => {
    const encoder = new TextEncoder();
    let resolveController:
      | ((controller: ReadableStreamDefaultController<Uint8Array>) => void)
      | null = null;
    const controllerReady = new Promise<ReadableStreamDefaultController<Uint8Array>>((resolve) => {
      resolveController = resolve;
    });
    const client = createAcpClient({
      endpoint: 'https://runtime.test/kortix/acp/session',
      fetch: (async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              resolveController?.(controller);
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )) as unknown as typeof fetch,
    });
    const stream = client.connect({ onEvent() {} });
    let ready = false;
    void stream.ready.then(() => {
      ready = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ready).toBe(false);

    const streamController = await controllerReady;
    streamController.enqueue(
      encoder.encode('id: 12\ndata: {"jsonrpc":"2.0","method":"kortix/cursor"}\n\n'),
    );
    await stream.ready;

    expect(ready).toBe(true);
    expect(stream.lastEventId).toBe(12);
    stream.close();
  });

  test('classifies terminal HTTP failures', async () => {
    const client = createAcpClient({
      endpoint: 'https://runtime.test/kortix/acp/session',
      fetch: (async () => new Response('forbidden', { status: 403 })) as unknown as typeof fetch,
    });

    await expect(client.request('session/load', {})).rejects.toEqual(
      new AcpTransportError('ACP request failed with HTTP 403: forbidden', 403, true),
    );
  });
});
