import { afterEach, describe, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { WorkerEventBus } from './runtime-surface.ts';
import { serveGlobalEventStream } from './global-event-stream.ts';
import { startWorker } from './worker.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('global event stream liveness', () => {
  test('disconnects an over-limit client without interrupting another subscriber', async () => {
    const bus = new WorkerEventBus();
    const server = createServer((req, res) => {
      serveGlobalEventStream(res, bus, '/workspace', {
        heartbeatMs: 15_000,
        maxBufferedBytes: req.url === '/limited' ? 256 : 8192,
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const port = (server.address() as { port: number }).port;
    const limited = await fetch(`http://127.0.0.1:${port}/limited`);
    const healthy = await fetch(`http://127.0.0.1:${port}/healthy`);
    const limitedReader = limited.body!.getReader();
    expect(new TextDecoder().decode((await limitedReader.read()).value)).toContain(
      'server.connected',
    );
    const limitedRead = limitedReader.read().catch(() => ({ done: true }));
    const healthyReader = healthy.body!.getReader();
    expect(new TextDecoder().decode((await healthyReader.read()).value)).toContain(
      'server.connected',
    );
    bus.publish('message.part.delta', { delta: 'x'.repeat(512) });
    expect((await limitedRead).done).toBe(true);
    expect(new TextDecoder().decode((await healthyReader.read()).value)).toContain('x'.repeat(512));
    await healthyReader.cancel();
  });

  test('keeps an idle stream alive and sends the next event in the client envelope', async () => {
    const bus = new WorkerEventBus();
    const server = createServer((_req, res) => {
      serveGlobalEventStream(res, bus, '/workspace', { heartbeatMs: 10 });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const controller = new AbortController();
    cleanups.push(async () => controller.abort());
    const port = (server.address() as { port: number }).port;
    const response = await fetch(`http://127.0.0.1:${port}/global/event`, {
      signal: controller.signal,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const connected = await reader.read();
    expect(new TextDecoder().decode(connected.value)).toContain('"type":"server.connected"');
    const heartbeat = await reader.read();
    expect(
      JSON.parse(new TextDecoder().decode(heartbeat.value).split('data: ')[1]!.trim()),
    ).toEqual({
      directory: '/workspace',
      payload: { type: 'server.heartbeat', properties: {} },
    });
    bus.publish('session.status', { sessionID: 'session-1', status: { type: 'idle' } });
    let chunk = '';
    while (!chunk.includes('data: ')) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      chunk += new TextDecoder().decode(next.value);
    }
    const data = JSON.parse(chunk.split('data: ')[1]!.split('\n')[0]!);
    expect(data).toEqual({
      directory: '/workspace',
      payload: {
        id: `evt_${bus.epoch}_1`,
        type: 'session.status',
        properties: { sessionID: 'session-1', status: { type: 'idle' } },
      },
    });
    await reader.cancel();
  });

  test('the real worker route authenticates and streams the prompt message', async () => {
    const worker = await startWorker({
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      systemPrompt: 'Answer.',
      modelMode: 'faux',
      kortixToken: 'test-token',
      sessionId: 'global-route-proof',
    });
    cleanups.push(async () => {
      worker.server.closeAllConnections();
      await worker.close();
    });
    const base = `http://127.0.0.1:${worker.port}`;
    expect((await fetch(`${base}/global/event`)).status).toBe(401);
    const headers = { authorization: 'Bearer test-token', 'content-type': 'application/json' };
    const controller = new AbortController();
    cleanups.push(async () => controller.abort());
    const stream = await fetch(`${base}/global/event`, { headers, signal: controller.signal });
    expect(stream.status).toBe(200);
    const sessions = (await (await fetch(`${base}/session`, { headers })).json()) as Array<{
      id: string;
    }>;
    worker.faux!.setResponses([fauxAssistantMessage('Stream proof.')]);
    const reader = stream.body!.getReader();
    const first = reader.read();
    const accepted = await fetch(`${base}/session/${sessions[0]!.id}/prompt_async`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ parts: [{ type: 'text', text: 'GLOBAL_STREAM_PROOF' }] }),
    });
    expect(accepted.status).toBe(204);
    let chunk = new TextDecoder().decode((await first).value);
    while (!chunk.includes('GLOBAL_STREAM_PROOF')) {
      const next = await reader.read();
      expect(next.done).toBe(false);
      chunk += new TextDecoder().decode(next.value);
    }
    expect(chunk).toContain('GLOBAL_STREAM_PROOF');
    expect(chunk).toContain('"directory":"/workspace"');
    await reader.cancel();
  });
});
