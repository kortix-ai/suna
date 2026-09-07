import { afterEach, describe, expect, test } from 'bun:test';
import type { Event, GlobalEvent } from '@opencode-ai/sdk/v2';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import { startWorker } from './worker.ts';

const workers: Array<Awaited<ReturnType<typeof startWorker>>> = [];

afterEach(async () => {
  await Promise.all(
    workers.splice(0).map((worker) => {
      worker.server.closeAllConnections();
      return worker.close();
    }),
  );
});

async function worker() {
  const instance = await startWorker({
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/remote/workspace',
    envTransport: 'fetch',
    systemPrompt: 'Answer the prompt.',
    modelMode: 'faux',
    sessionId: 'global-event-test',
    kortixToken: 'runtime-token',
  });
  workers.push(instance);
  return instance;
}

function withBearer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  request.headers.set('authorization', 'Bearer runtime-token');
  return fetch(request);
}

describe('Pi worker OpenCode global event compatibility', () => {
  test('rejects an unauthenticated global event stream', async () => {
    const instance = await worker();

    const response = await fetch(`http://127.0.0.1:${instance.port}/global/event`);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
  });

  test('streams generated GlobalEvent envelopes through the generated OpenCode client', async () => {
    const instance = await worker();
    const baseUrl = `http://127.0.0.1:${instance.port}`;
    let connected!: () => void;
    const connection = new Promise<void>((resolve) => {
      connected = resolve;
    });
    const client = createOpencodeClient({
      baseUrl,
      fetch: (async (input, init) => {
        const response = await withBearer(input, init);
        if (
          new URL(input instanceof Request ? input.url : String(input)).pathname === '/global/event'
        )
          connected();
        return response;
      }) as typeof fetch,
    });
    const controller = new AbortController();
    const { stream } = await client.global.event({
      signal: controller.signal,
      sseMaxRetryAttempts: 1,
    });
    const iterator = stream[Symbol.asyncIterator]();
    const eventPromise = iterator.next();
    await connection;

    const prompt = await withBearer(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Reply once.', script: [{ text: 'done' }] }),
    });
    expect(prompt.status).toBe(200);

    const connectedEvent = await eventPromise;
    expect(connectedEvent.value).toEqual({
      directory: '/remote/workspace',
      payload: { id: expect.any(String), type: 'server.connected', properties: {} },
    });
    const event = await iterator.next();
    const partEvent = await iterator.next();
    controller.abort();
    void iterator.return?.();

    expect(event.done).toBe(false);
    if (event.done) throw new Error('global event stream ended before one event arrived');
    const value: GlobalEvent = event.value;
    const generatedEventContract = value.payload as Extract<Event, { type: 'message.updated' }>;
    expect(value).toMatchObject({
      directory: '/remote/workspace',
      payload: {
        type: 'message.updated',
        properties: {
          sessionID: expect.stringMatching(/^ses_pi/),
          info: { role: 'user' },
        },
      },
    });
    expect(value.payload.id).toMatch(/^evt_p[a-z0-9]+_1$/);
    expect(generatedEventContract.type).toBe('message.updated');
    expect(partEvent.done).toBe(false);
    if (partEvent.done) throw new Error('global event stream ended before the user part arrived');
    const partValue: GlobalEvent = partEvent.value;
    expect(partValue.payload).toMatchObject({
      type: 'message.part.updated',
      properties: {
        sessionID: expect.stringMatching(/^ses_pi/),
        time: expect.any(Number),
        part: { type: 'text', text: 'Reply once.' },
      },
    });
  });
});
