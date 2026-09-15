import { afterEach, expect, test } from 'bun:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { createOpencodeClient } from '@opencode-ai/sdk/v2';
import { Type } from 'typebox';
import { startWorker } from './worker';

const globals = globalThis as any;
const previous = { factory: globals.__KORTIX_PI_AGENT__, compiled: globals.__KORTIX_COMPILED__ };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  globals.__KORTIX_PI_AGENT__ = previous.factory;
  globals.__KORTIX_COMPILED__ = previous.compiled;
  for (const close of cleanup.splice(0)) await close();
});

async function fixture() {
  const log: any[] = [];
  const store = Bun.serve({ port: 0, async fetch(req) {
    if (req.method === 'GET') return Response.json(log);
    const item = await req.json() as any;
    if (!log.some(row => row._kortixAppendId === item._kortixAppendId)) log.push(item);
    return new Response(null, { status: 204 });
  } });
  let release!: () => void;
  let update: ((value: any) => void) | undefined;
  let executions = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  globals.__KORTIX_COMPILED__ = { manifest: { default_agent: 'build' }, agentConfig: { agent: { build: { permission: 'allow' } } } };
  globals.__KORTIX_PI_AGENT__ = () => ({ tools: [{ name: 'progress', label: 'Progress', description: 'A controlled job', parameters: Type.Object({}),
    execute: async (_id: string, _params: unknown, _signal: AbortSignal, onUpdate?: (value: any) => void) => {
      executions++;
      update = onUpdate;
      onUpdate?.({ content: [{ type: 'text', text: 'EARLY' }], details: { percent: 10 } });
      await gate;
      return { content: [{ type: 'text', text: 'FINAL' }], details: { percent: 100 } };
    },
  }] });
  const cfg = { port: 0, envUrl: 'http://127.0.0.1:1', envUrlExplicit: true, envCwd: '/workspace', systemPrompt: 'Use progress.', modelMode: 'faux' as const, sessionId: 'progress-session', kortixToken: 'fixture-token', storeUrl: store.url.toString().replace(/\/$/, '') };
  let worker = await startWorker(cfg);
  const controller = new AbortController();
  cleanup.push(async () => { controller.abort(); release(); worker.server.closeAllConnections(); await worker.close(); store.stop(true); });
  const request = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${worker.port}${path}`, { headers: { authorization: 'Bearer fixture-token', 'content-type': 'application/json' }, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const id = (await (await request('/session')).json())[0].id;
  const client = createOpencodeClient({ baseUrl: `http://127.0.0.1:${worker.port}`, headers: { authorization: 'Bearer fixture-token' } });
  const { stream } = await client.global.event({ signal: controller.signal, sseMaxRetryAttempts: 1 });
  const events = stream[Symbol.asyncIterator]();
  await events.next();
  return {
    request, id, release,
    update: (text: string) => update?.({ content: [{ type: 'text', text }], details: { percent: 50 } }),
    async nextOutput(output: string) {
      while (true) {
        const event = await events.next();
        if (event.done) throw new Error('progress stream ended');
        const payload = event.value.payload as any;
        if (payload.type === 'message.part.updated' && payload.properties.part.state?.metadata?.output === output) return payload.properties.part;
      }
    },
    async send() {
      worker.faux!.setResponses([fauxAssistantMessage([fauxToolCall('progress', {}, { id: 'call_progress' })], { stopReason: 'toolUse' }), fauxAssistantMessage('Done.')]);
      return request(`/session/${id}/message`, { parts: [{ type: 'text', text: 'Start the job.' }] });
    },
    history: async () => (await request(`/session/${id}/message`)).json(),
    async restart() {
      controller.abort(); worker.server.closeAllConnections(); await worker.close();
      worker = await startWorker(cfg);
    },
    get executions() { return executions; },
  };
}

test('custom progress reaches authenticated SSE and HTTP before completion and final history survives restart', async () => {
  const f = await fixture();
  const response = f.send();
  const early = await f.nextOutput('EARLY');
  expect(early.state).toMatchObject({ status: 'running', metadata: { output: 'EARLY', percent: 10 } });
  const pending = await f.history();
  expect(pending.flatMap((message: any) => message.parts).find((part: any) => part.id === early.id).state.metadata.output).toBe('EARLY');
  f.update('EARLY\nSECOND');
  expect((await f.nextOutput('EARLY\nSECOND')).id).toBe(early.id);
  f.release();
  expect((await response).status).toBe(200);
  const history = await f.history();
  expect(history.flatMap((message: any) => message.parts).find((part: any) => part.id === early.id).state).toMatchObject({ status: 'completed', output: 'FINAL', metadata: { percent: 100 } });
  f.update('LATE');
  expect(await f.history()).toEqual(history);
  await f.restart();
  expect(await f.history()).toEqual(history);
  expect(f.executions).toBe(1);
});

test('Stop ends a streaming custom tool and late progress cannot revive the stopped result', async () => {
  const f = await fixture();
  const response = f.send();
  const early = await f.nextOutput('EARLY');
  expect((await f.request(`/session/${f.id}/abort`, {})).status).toBe(200);
  expect((await response).status).toBe(200);
  const history = await f.history();
  expect(history.flatMap((message: any) => message.parts).find((part: any) => part.id === early.id).state.status).toBe('error');
  f.update('LATE'); f.release();
  expect(await f.history()).toEqual(history);
  await f.restart();
  expect(await f.history()).toEqual(history);
  expect(f.executions).toBe(1);
});
