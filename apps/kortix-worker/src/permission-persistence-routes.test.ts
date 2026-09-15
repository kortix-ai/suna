import { afterEach, expect, test } from 'bun:test';
import { createServer, type Server } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { startWorker } from './worker.ts';
import type { SessionLogItem } from './session-store.ts';

const globals = globalThis as Record<string, unknown>;
const original = globals.__KORTIX_COMPILED__;
const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const servers: Server[] = [];

afterEach(async () => {
  globals.__KORTIX_COMPILED__ = original;
  for (const worker of workers.splice(0)) {
    worker.agent.abort();
    worker.server.closeAllConnections();
    await worker.close();
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function until(read: () => Promise<any[]>, match: (value: any[]) => boolean): Promise<any[]> {
  for (let n = 0; n < 200; n++) {
    const value = await read();
    if (match(value)) return value;
    await Bun.sleep(10);
  }
  throw new Error('permission lifecycle did not settle');
}

test('an always reply persists through the real log protocol and worker replacement', async () => {
  const items: SessionLogItem[] = [];
  const keys = new Map<string, SessionLogItem>();
  let rejectApprovals = true;
  let storeReads = 0;
  const store = createServer(async (req, res) => {
    if (req.method === 'GET') {
      storeReads++;
      return void res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(items));
    }
    const key = String(req.headers['idempotency-key']);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))
      return void res.writeHead(400).end();
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const item = JSON.parse(raw) as SessionLogItem;
    if (
      rejectApprovals &&
      item.kind === 'journal' &&
      item.stream === 'kortix.pi.permission-approvals.v1'
    )
      return void res.writeHead(503).end();
    const previous = keys.get(key);
    if (previous && !isDeepStrictEqual(previous, item)) return void res.writeHead(409).end();
    if (!previous) {
      keys.set(key, item);
      items.push(item);
    }
    res.writeHead(204).end();
  });
  servers.push(store);
  await new Promise<void>((resolve) => store.listen(0, '127.0.0.1', resolve));
  const address = store.address();
  if (!address || typeof address === 'string') throw new Error('log did not listen');
  globals.__KORTIX_COMPILED__ = {
    manifest: { default_agent: 'build' },
    agentConfig: { agent: { build: { permission: { question: 'ask' } } } },
  };
  const config = {
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    systemPrompt: 'Answer.',
    modelMode: 'faux' as const,
    kortixToken: 'test',
    sessionId: 'permission-persist',
    storeUrl: `http://127.0.0.1:${address.port}`,
  };
  for (const round of [0, 1]) {
    const readsBefore = storeReads;
    const worker = await startWorker(config);
    workers.push(worker);
    expect(storeReads - readsBefore).toBe(1);
    worker.faux!.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall('question', {
            questions: [
              {
                question: 'Choose.',
                header: 'Choice',
                options: [{ label: 'Yes', description: 'Continue.' }],
              },
            ],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(`COMPLETE_${round}`),
    ]);
    const base = `http://127.0.0.1:${worker.port}`;
    const call = (path: string, body?: unknown) =>
      fetch(base + path, {
        headers: {
          authorization: 'Bearer test',
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      });
    const read = async (path: string) => (await (await call(path)).json()) as any[];
    const [session] = await read('/session');
    expect(
      (
        await call(`/session/${session.id}/prompt_async`, {
          parts: [{ type: 'text', text: 'Ask.' }],
        })
      ).status,
    ).toBe(204);
    if (round === 0) {
      const [permission] = await until(
        () => read('/permission'),
        (value) => value.length === 1,
      );
      expect((await call(`/permission/${permission.id}/reply`, { reply: 'always' })).status).toBe(
        503,
      );
      expect(await read('/question')).toEqual([]);
      expect(await read('/permission')).toHaveLength(1);
      rejectApprovals = false;
      const reply = await call(`/permission/${permission.id}/reply`, {
        reply: 'always',
      });
      expect(reply.status).toBe(200);
      expect(
        items.some(
          (item) => item.kind === 'journal' && item.stream === 'kortix.pi.permission-approvals.v1',
        ),
      ).toBe(true);
    }
    const [question] = await until(
      () => read('/question'),
      (value) => value.length === 1,
    );
    expect(await read('/permission')).toEqual([]);
    expect((await call(`/question/${question.id}/reply`, { answers: [['Yes']] })).status).toBe(200);
    await until(
      () => read(`/session/${session.id}/message`),
      (value) => value.some((m) => m.parts.some((p: any) => p.text === `COMPLETE_${round}`)),
    );
    await until(
      async () => Object.values(await (await call('/session/status')).json()),
      (statuses) => statuses.length === 0,
    );
    await worker.close();
    workers.splice(workers.indexOf(worker), 1);
  }
  expect(
    items.filter(
      (item) => item.kind === 'journal' && item.stream === 'kortix.pi.permission-approvals.v1',
    ),
  ).toHaveLength(1);
}, 15_000);
