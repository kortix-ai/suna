import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { startWorker } from './worker.ts';

/**
 * The HTTP surface of the worker, booted in-process on an ephemeral port.
 * Faux mode keeps the whole harness offline: a scripted provider, no
 * environment RPCs, no durable store.
 */
describe('worker HTTP surface', () => {
  let worker: Awaited<ReturnType<typeof startWorker>>;

  beforeAll(async () => {
    worker = await startWorker({
      port: 0,
      envUrl: 'http://127.0.0.1:9',
      envUrlExplicit: true,
      envCwd: '/tmp',
      systemPrompt: 'test',
      modelMode: 'faux',
    });
  });

  afterAll(async () => {
    await worker?.close();
  });

  const url = (path: string) => `http://127.0.0.1:${worker.port}${path}`;

  test('a malformed /turn body answers 400 and the worker survives', async () => {
    const res = await fetch(url('/turn'), { method: 'POST', body: '{"text": oops}' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: expect.any(String) });

    // `null` parses fine but cannot be destructured — the same guard must
    // hold it, not only JSON.parse failures.
    const nulled = await fetch(url('/turn'), { method: 'POST', body: 'null' });
    expect(nulled.status).toBe(400);

    // The pre-fix ordering wrote 200 SSE headers before parsing; the thrown
    // parse error killed the whole worker process and left the client on a
    // stream that never ends. Survival is the contract: the same server must
    // still answer /health.
    const health = await fetch(url('/health'));
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok?: boolean }).ok).toBe(true);
  });

  test('a valid /turn body still streams events and ends with done', async () => {
    const res = await fetch(url('/turn'), {
      method: 'POST',
      body: JSON.stringify({ text: 'say hi', script: [{ text: 'hi there' }] }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Resolves only when the server ends the stream: a turn that hangs the
    // response fails here by timeout.
    const stream = await res.text();
    expect(stream).toContain('event: done');
  });
});
