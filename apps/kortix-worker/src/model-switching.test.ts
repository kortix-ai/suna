import { afterEach, expect, test } from 'bun:test';
import { startWorker } from './worker';
import { mintWireMessageId } from './wire-message-id';
import { Type } from 'typebox';
import type { PiAgentFactory } from '../../../packages/sdk/src/core/pi/agent';
import type { SessionLogItem } from './session-store';

const cleanups: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  let selected: string | null = 'model-a';
  let unavailable = false;
  let blockNext: ReturnType<typeof deferred> | undefined;
  const arrived = deferred();
  const requests: any[] = [];
  const log: SessionLogItem[] = [];
  const keys = new Map<string, string>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/model') {
        expect(request.headers.get('authorization')).toBe('Bearer model-fixture');
        if (unavailable) return new Response('unavailable', { status: 503 });
        if (selected === null) return Response.json({ opencode_model: null, limits: null });
        return Response.json({ opencode_model: `kortix/${selected}`, limits: {
          model: selected, context: 32768, output: 2048, reasoning: false, images: false,
        } });
      }
      if (path.endsWith('/log') || path.endsWith('/agent-state')) {
        if (request.method === 'GET') return Response.json(log);
        const body = await request.text();
        const key = request.headers.get('idempotency-key')!;
        if (keys.has(key)) return new Response(null, { status: keys.get(key) === body ? 204 : 409 });
        keys.set(key, body);
        log.push(JSON.parse(body));
        return new Response(null, { status: 204 });
      }
      if (path === '/v1/chat/completions') {
        const body = await request.json() as any;
        requests.push(body);
        const gate = blockNext;
        blockNext = undefined;
        arrived.resolve();
        if (gate) await gate.promise;
        const custom = body.messages.some((message: any) => JSON.stringify(message.content).includes('CUSTOM')) && body.messages.at(-1)?.role !== 'tool';
        const delta = custom ? { role: 'assistant', tool_calls: [{ index: 0, id: `custom-${requests.length}`, type: 'function', function: { name: 'custom_counter', arguments: '{}' } }] }
          : { role: 'assistant', content: `ANSWER_${body.model}` };
        return new Response(`data: ${JSON.stringify({
          id: 'switch-fixture', object: 'chat.completion.chunk', created: 1,
          model: body.model, choices: [{ index: 0, delta, finish_reason: custom ? 'tool_calls' : 'stop' }],
        })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('unexpected request', { status: 404 });
    },
  });
  cleanups.push(() => server.stop(true));
  const headers = { authorization: 'Bearer model-fixture', 'content-type': 'application/json' };
  async function boot() {
    const worker = await startWorker({
      port: 0, envUrl: 'http://127.0.0.1:1', envCwd: '/workspace',
      systemPrompt: 'Follow the user.', modelMode: 'real', providerId: 'openrouter',
      modelId: 'model-a', apiKey: 'model-fixture', kortixToken: 'model-fixture',
      gatewayUrl: `${server.url}v1`, storeUrl: server.url.toString(),
      storeHeaders: headers, sessionId: 'model-switch-fixture',
      modelConfigUrl: `${server.url}model`,
    });
    cleanups.push(() => worker.close());
    const base = `http://127.0.0.1:${worker.port}`;
    const sessions = await (await fetch(`${base}/session`, { headers })).json() as any[];
    const root = `/session/${sessions[0].id}`;
    return {
      worker,
      root,
      get: (path: string) => fetch(`${base}${path}`, { headers }),
      call: (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }),
      send: (text: string, async = false, extra = {}) => fetch(`${base}${root}/${async ? 'prompt_async' : 'message'}`, {
        method: 'POST', headers, body: JSON.stringify({ parts: [{ type: 'text', text }], ...extra }),
      }),
      messages: async () => (await fetch(`${base}${root}/message`, { headers })).json() as Promise<any[]>,
    };
  }
  return {
    boot, requests, log, arrived,
    select: (model: string | null) => { selected = model; },
    unavailable: () => { unavailable = true; },
    block: () => { blockNext = deferred(); return blockNext; },
  };
}

test('new prompts use the persisted model and preserve earlier message models across restart', async () => {
  const f = await fixture();
  const first = await f.boot();
  const a = await first.send('First prompt.');
  expect(a.status).toBe(200);
  expect((await a.json() as any).info.modelID).toBe('model-a');
  f.select('model-b');
  const b = await first.send('Second prompt.');
  expect(b.status).toBe(200);
  expect((await b.json() as any).info.modelID).toBe('model-b');
  expect(f.requests.map(request => request.model)).toEqual(['model-a', 'model-b']);
  const before = await first.messages();
  expect(before.filter(message => message.info.role === 'assistant').map(message => message.info.modelID))
    .toEqual(['model-a', 'model-b']);
  await first.worker.close();
  const second = await f.boot();
  expect(await second.messages()).toEqual(before);
  expect((await second.send('Third prompt.')).status).toBe(200);
  expect(f.requests.map(request => request.model)).toEqual(['model-a', 'model-b', 'model-b']);
});

test('queued prompts retain their admitted model while the active request finishes', async () => {
  const f = await fixture();
  const x = await f.boot();
  const gate = f.block();
  try {
    expect((await x.send('First.', true)).status).toBe(204);
    await f.arrived.promise;
    f.select('model-b');
    expect((await x.send('Second.', true)).status).toBe(204);
    f.select('model-c');
    const last = x.send('Third.');
    gate.resolve();
    expect((await last).status).toBe(200);
    expect(f.requests.map(request => request.model)).toEqual(['model-a', 'model-b', 'model-c']);
  } finally { gate.resolve(); }
});

test('an unavailable model configuration cannot acknowledge or execute a new prompt', async () => {
  const f = await fixture();
  const x = await f.boot();
  f.unavailable();
  const response = await x.send('Must not execute.', true);
  expect(response.status).toBe(503);
  expect(f.requests).toHaveLength(0);
  expect(await x.messages()).toEqual([]);
});

test('duplicate concurrent and completed deliveries retain their original model', async () => {
  const f = await fixture();
  const x = await f.boot();
  const input = { messageID: mintWireMessageId({ nowMs: Date.now() }).id };
  const responses = await Promise.all([x.send('Once.', true, input), x.send('Once.', true, input)]);
  expect(responses.map(response => response.status)).toEqual([204, 204]);
  await f.arrived.promise;
  f.select('model-b');
  expect((await x.send('Once.', false, input)).status).toBe(200);
  expect(f.requests.map(request => request.model)).toEqual(['model-a']);
  expect((await x.send('Changed.', true, input)).status).toBe(409);
  expect((await x.send('Once.', true, { ...input, model: { providerID: 'kortix', modelID: 'model-b' } })).status).toBe(400);
});

test('configuration reads show the saved model without changing an active turn', async () => {
  const f = await fixture();
  const x = await f.boot();
  const gate = f.block();
  try {
    expect((await x.send('Active.', true)).status).toBe(204);
    await f.arrived.promise;
    f.select('model-b');
    const config = await (await x.get('/config')).json() as any;
    expect(config.model).toBe('kortix/model-b');
    const health = await (await x.get('/kortix/health')).json() as any;
    expect(health.session_model_selection).toBe('next-prompt-v1');
    expect(f.requests.map(request => request.model)).toEqual(['model-a']);
  } finally { gate.resolve(); }
});

test('a conflicting explicit model is rejected before admission', async () => {
  const f = await fixture();
  const x = await f.boot();
  expect((await x.send('Wrong model.', true, { model: { providerID: 'kortix', modelID: 'model-b' } })).status).toBe(400);
  expect(f.requests).toHaveLength(0);
  expect(await x.messages()).toEqual([]);
});

test('model switches preserve custom tools, lifecycle hooks, agent state and generation settings', async () => {
  const global = globalThis as any;
  const previous = { factory: global.__KORTIX_PI_AGENT__, compiled: global.__KORTIX_COMPILED__ };
  cleanups.push(() => { global.__KORTIX_PI_AGENT__ = previous.factory; global.__KORTIX_COMPILED__ = previous.compiled; });
  let initialized = 0;
  const hooks: string[] = [];
  const counts: number[] = [];
  global.__KORTIX_COMPILED__ = { agentConfig: { agent: { build: { temperature: 0.2, permission: 'allow' } } } };
  const factory: PiAgentFactory = (ctx) => ({
    initialize: () => { initialized++; },
    beforeToolCall: async () => { hooks.push('before'); return undefined; },
    afterToolCall: async () => { hooks.push('after'); return undefined; },
    tools: [{ name: 'custom_counter', label: 'Counter', description: 'Increment the custom counter', parameters: Type.Object({}), execute: async () => {
      const state = await ctx.state.open('count', { schemaVersion: 1, initialValue: 0 });
      const { value: count } = await state.update(value => value + 1);
      counts.push(count);
      return { content: [{ type: 'text', text: String(count) }], details: {} };
    } }],
  });
  global.__KORTIX_PI_AGENT__ = factory;
  const f = await fixture();
  const x = await f.boot();
  expect((await x.send('CUSTOM counter.')).status).toBe(200);
  f.select('model-b');
  expect((await x.send('CUSTOM counter again.')).status).toBe(200);
  expect(initialized).toBe(1);
  expect({ counts, toolResults: f.requests.flatMap(request => request.messages.filter((message: any) => message.role === 'tool').map((message: any) => message.content)) }).toMatchObject({ counts: [1, 2] });
  expect(hooks).toEqual(['before', 'after', 'before', 'after']);
  expect(f.requests.map(request => request.model)).toEqual(['model-a', 'model-a', 'model-b', 'model-b']);
  expect(f.requests.every(request => request.temperature === 0.2)).toBe(true);
});

test('manual compaction uses the saved model and preserves its historical identity after restart', async () => {
  const f = await fixture();
  const x = await f.boot();
  expect((await x.send('First context.')).status).toBe(200);
  f.select('model-b');
  const response = await x.call(`${x.root}/summarize`, { providerID: 'kortix', modelID: 'model-b' });
  expect(response.status).toBe(200);
  expect(f.requests.at(-1).model).toBe('model-b');
  const before = await x.messages();
  expect(before.find(message => message.info.summary)?.info.modelID).toBe('model-b');
  await x.worker.close();
  const restarted = await f.boot();
  expect(await restarted.messages()).toEqual(before);
});


test('commands follow the saved selection and reject conflicting model or reasoning overrides', async () => {
  const global = globalThis as any;
  const previous = global.__KORTIX_COMPILED__;
  cleanups.push(() => { global.__KORTIX_COMPILED__ = previous; });
  global.__KORTIX_COMPILED__ = { commands: [
    { name: 'review', template: 'Review $ARGUMENTS', source: 'command', hints: [] },
    { name: 'pinned', template: 'Review', source: 'command', hints: [], model: 'kortix/model-a' },
  ] };
  const f = await fixture();
  const x = await f.boot();
  f.select('model-b');
  expect((await x.call(`${x.root}/command`, { command: 'review', arguments: 'changes' })).status).toBe(200);
  expect(f.requests.map(request => request.model)).toEqual(['model-b']);
  expect((await x.call(`${x.root}/command`, { command: 'pinned' })).status).toBe(400);
  expect((await x.send('Unsupported reasoning.', true, { variant: 'high' })).status).toBe(400);
  expect(f.requests).toHaveLength(1);
});

test('an unpinned session still validates prompt overrides against its configured model', async () => {
  const f = await fixture();
  f.select(null);
  const x = await f.boot();
  expect((await x.send('Wrong model.', true, { model: { providerID: 'kortix', modelID: 'model-b' } })).status).toBe(400);
  expect((await x.send('Wrong reasoning.', true, { variant: 'high' })).status).toBe(400);
  expect((await x.send('Configured model.')).status).toBe(200);
  expect(f.requests.map(request => request.model)).toEqual(['model-a']);
});
