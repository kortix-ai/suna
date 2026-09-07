import { afterEach, expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { fauxAssistantMessage } from '@earendil-works/pi-ai';
import { startWorker } from './worker.ts';

const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const stores: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    worker.server.closeAllConnections();
    await worker.close();
  }
  for (const store of stores.splice(0)) {
    store.closeAllConnections();
    await new Promise<void>((resolve) => store.close(() => resolve()));
  }
});

test('HTTP transcript preserves message and part identities across repeated worker restarts', async () => {
  const items: unknown[] = [];
  const store = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(items));
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    items.push(JSON.parse(body));
    res.writeHead(204).end();
  });
  stores.push(store);
  await new Promise<void>((resolve) => store.listen(0, '127.0.0.1', resolve));
  const config = {
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    systemPrompt: 'Answer exactly.',
    modelMode: 'faux' as const,
    sessionId: 'durable-wire-identity',
    kortixToken: 'test-runtime-token',
    storeUrl: `http://127.0.0.1:${(store.address() as { port: number }).port}`,
  };
  const start = async () => {
    const worker = await startWorker(config);
    workers.push(worker);
    return worker;
  };
  const request = (worker: (typeof workers)[number], path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${worker.port}${path}`, {
      ...init,
      headers: { authorization: 'Bearer test-runtime-token', 'content-type': 'application/json' },
    });
  const first = await start();
  const sessions = await (await request(first, '/session')).json();
  const sessionId = sessions[0].id;
  const messages = async (worker: (typeof workers)[number]) => {
    const response = await request(worker, `/session/${sessionId}/message?limit=100`);
    expect(response.status).toBe(200);
    return response.json();
  };
  for (let turn = 0; turn < 2; turn++) {
    first.faux!.setResponses([fauxAssistantMessage('repeated answer')]);
    const response = await request(first, `/session/${sessionId}/prompt_async`, {
      method: 'POST',
      body: JSON.stringify({ parts: [{ type: 'text', text: 'repeated question' }] }),
    });
    expect(response.status).toBe(204);
    const deadline = Date.now() + 3_000;
    while (true) {
      const transcript = await messages(first);
      if (
        transcript.length === (turn + 1) * 2 &&
        transcript.at(-1).info.time.completed &&
        !first.agent.state.isStreaming
      ) break;
      if (Date.now() > deadline) throw new Error('turn did not persist and complete');
      await Bun.sleep(5);
    }
  }
  const before = await messages(first);
  const identity = (transcript: any[]) => transcript.map((message) => ({
    id: message.info.id,
    role: message.info.role,
    parentID: message.info.parentID,
    parts: message.parts.map((part: any) => ({
      id: part.id,
      messageID: part.messageID,
      type: part.type,
      text: part.text,
    })),
  }));
  expect(before).toHaveLength(4);
  expect(new Set(before.map((message: any) => message.info.id)).size).toBe(4);
  first.server.closeAllConnections();
  await first.close();
  workers.splice(workers.indexOf(first), 1);

  for (let restart = 0; restart < 2; restart++) {
    const resumed = await start();
    const after = await messages(resumed);
    expect(identity(after)).toEqual(identity(before));
    expect(new Set([...before, ...after].map((message: any) => message.info.id)).size).toBe(4);
    resumed.server.closeAllConnections();
    await resumed.close();
    workers.splice(workers.indexOf(resumed), 1);
  }
}, 15_000);
