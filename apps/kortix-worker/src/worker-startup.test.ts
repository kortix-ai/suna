import { expect, test } from 'bun:test';
import { startWorker, type WorkerConfig } from './worker';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function availablePort() {
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  reservation.stop(true);
  return port;
}

async function bootHealth(port: number) {
  const deadline = Date.now() + 1_000;
  do {
    try {
      return await fetch(`http://127.0.0.1:${port}/kortix/health`, { signal: AbortSignal.timeout(100) });
    } catch {
      await Bun.sleep(10);
    }
  } while (Date.now() < deadline);
  throw new Error('worker does not expose readiness during durable recovery');
}

const config = (port: number): WorkerConfig => ({
  port,
  envUrl: 'http://127.0.0.1:1',
  envCwd: '/workspace',
  systemPrompt: 'Startup probe',
  modelMode: 'faux',
});

test('worker exposes boot readiness before durable recovery and promotes the same listener', async () => {
  const release = deferred();
  const entered = deferred();
  const store = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === 'GET') {
        entered.resolve();
        await release.promise;
        return Response.json([]);
      }
      return Response.json({ ok: true });
    },
  });
  const port = availablePort();
  const starting = startWorker({ ...config(port), storeUrl: store.url.href, sessionId: 'boot-readiness' });
  try {
    await entered.promise;
    const response = await bootHealth(port);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ daemon: 'ok', engine: 'pi', runtimeReady: false, boot_phase: 'worker-restoring' });
    const blocked = await fetch(`http://127.0.0.1:${port}/session`, { method: 'POST', body: '{}' });
    expect(blocked.status).toBe(503);
    expect(blocked.headers.get('x-kortix-boot-phase')).toBe('worker-restoring');
    expect(await blocked.json()).toEqual({ error: 'runtime_not_ready' });
    release.resolve();
    const worker = await starting;
    expect(worker.port).toBe(port);
    const ready = await bootHealth(port);
    expect(await ready.json()).toMatchObject({ engine: 'pi', runtimeReady: true });
  } finally {
    release.resolve();
    const worker = await starting;
    worker.server.closeAllConnections();
    await worker.close();
    store.stop(true);
  }
});

test('a second worker cannot read or claim the durable turn while the first worker restores', async () => {
  const release = deferred();
  const entered = deferred();
  let reads = 0;
  const store = Bun.serve({
    port: 0,
    async fetch(request) {
      if (request.method === 'GET') {
        reads++;
        entered.resolve();
        await release.promise;
        return Response.json([]);
      }
      return Response.json({ ok: true });
    },
  });
  const port = availablePort();
  const cfg = { ...config(port), storeUrl: store.url.href, sessionId: 'boot-owner' };
  const first = startWorker(cfg);
  try {
    await entered.promise;
    await expect(startWorker(cfg)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    expect(reads).toBe(1);
    expect((await (await bootHealth(port)).json()).runtimeReady).toBe(false);
  } finally {
    release.resolve();
    const worker = await first;
    worker.server.closeAllConnections();
    await worker.close();
    store.stop(true);
  }
});

test('a failed harness initialization releases the listening port for a corrected startup', async () => {
  const port = availablePort();
  await expect(startWorker({ ...config(port), modelMode: 'real' })).rejects.toThrow('real model mode requires');
  const worker = await startWorker(config(port));
  try {
    expect((await (await bootHealth(port)).json()).runtimeReady).toBe(true);
  } finally {
    worker.server.closeAllConnections();
    await worker.close();
  }
});
