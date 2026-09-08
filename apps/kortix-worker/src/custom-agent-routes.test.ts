import { afterEach, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { startWorker } from './worker.ts';
import type { PiAgentFactory } from '../../../packages/sdk/src/core/pi/agent.ts';
const globals = globalThis as any;
const previous = {
  compiled: globals.__KORTIX_COMPILED__,
  factory: globals.__KORTIX_PI_AGENT__,
  agent: process.env.KORTIX_AGENT,
};
const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(async () => {
  globals.__KORTIX_COMPILED__ = previous.compiled;
  globals.__KORTIX_PI_AGENT__ = previous.factory;
  if (previous.agent === undefined) delete process.env.KORTIX_AGENT;
  else process.env.KORTIX_AGENT = previous.agent;
  for (const worker of workers.splice(0)) {
    worker.agent.abort();
    worker.server.closeAllConnections();
    await worker.close();
  }
  for (const server of servers.splice(0)) server.stop(true);
});
async function setup(
  name: string,
  remote: boolean,
  permission: 'allow' | 'deny' = 'allow',
  failShutdown = false,
) {
  const requests: any[] = [];
  const effects: any[] = [];
  const lifecycle: string[] = [];
  const provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path.startsWith('/rpc')) {
        if (request.method !== 'POST') return new Response(null, { status: 404 });
        const body = (await request.json()) as any;
        effects.push(body);
        return Response.json({
          ok: true,
          value: { stdout: 'REMOTE_' + name, stderr: '', exitCode: 0 },
        });
      }
      const body = (await request.json()) as any;
      requests.push(body);
      const lastUser = body.messages.findLastIndex((m: any) => m.role === 'user');
      const results = body.messages.slice(lastUser + 1).filter((m: any) => m.role === 'tool');
      const call = results.length === 0;
      const delta = call
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'custom-call-' + requests.length,
                type: 'function',
                function: { name: 'custom_' + name, arguments: '{"value":"proof"}' },
              },
            ],
          }
        : { role: 'assistant', content: String(results.at(-1).content) };
      const frames = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }] },
      ];
      return new Response(
        frames
          .map(
            (frame) =>
              'data: ' +
              JSON.stringify({ id: 'custom-response', model: body.model, ...frame }) +
              '\n\n',
          )
          .join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  servers.push(provider);
  process.env.KORTIX_AGENT = name;
  globals.__KORTIX_COMPILED__ = {
    manifest: { default_agent: name },
    agentConfig: { agent: { [name]: { permission, temperature: 0.2, steps: 3 } } },
  };
  const factory: PiAgentFactory = (ctx) => ({
    initialize: () => {
      lifecycle.push('initialize:' + ctx.agentName);
    },
    onEvent: (event) => {
      if (['agent_start', 'turn_end', 'agent_end'].includes(event.type)) lifecycle.push(event.type);
    },
    beforeToolCall: async () => {
      lifecycle.push('beforeToolCall');
      return undefined;
    },
    afterToolCall: async ({ result }) => ({
      content: [...result.content, { type: 'text', text: 'HOOK_' + name }],
    }),
    shutdown: () => {
      lifecycle.push('shutdown:' + ctx.agentName);
      if (failShutdown) throw new Error('custom shutdown failed');
    },
    tools: [
      {
        name: 'custom_' + name,
        label: 'Custom ' + name,
        description: 'Verify ' + name,
        parameters: Type.Object({ value: Type.String() }),
        execute: async (_id, params) => {
          const { value } = params as { value: string };
          if (remote) {
            const result = await ctx.env.exec('CUSTOM_' + value);
            if (!result.ok) throw result.error;
            return {
              content: [{ type: 'text', text: result.value.stdout }],
              details: { remote: true },
            };
          }
          return {
            content: [{ type: 'text', text: 'LOCAL_' + name + '_' + value }],
            details: { remote: false },
          };
        },
      },
    ],
  });
  globals.__KORTIX_PI_AGENT__ = factory;
  const worker = await startWorker({
    port: 0,
    envUrl: provider.url.toString().replace(/\/$/, '') + '/rpc',
    envUrlExplicit: true,
    envTransport: 'fetch',
    envCwd: '/workspace',
    systemPrompt: 'Use the requested custom tool.',
    modelMode: 'real',
    providerId: 'openrouter',
    modelId: 'openai/gpt-4.1',
    gatewayUrl: provider.url.toString().replace(/\/$/, '') + '/v1',
    apiKey: 'fixture-token',
    sessionId: 'custom-' + name,
    kortixToken: 'runtime-token',
  });
  workers.push(worker);
  const headers = { authorization: 'Bearer runtime-token', 'content-type': 'application/json' };
  const base = 'http://127.0.0.1:' + worker.port;
  const session = ((await (await fetch(base + '/session', { headers })).json()) as any[])[0].id;
  const call = (path: string, body?: unknown) =>
    fetch(base + path, {
      headers,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  return { worker, call, session, requests, effects, lifecycle };
}

test('two agents expose distinct custom tools through real worker routes and native hooks', async () => {
  for (const [name, remote] of [
    ['reviewer', false],
    ['operator', true],
  ] as const) {
    const f = await setup(name, remote);
    for (let turn = 0; turn < 2; turn++) {
      const response = await f.call(`/session/${f.session}/message`, {
        parts: [{ type: 'text', text: 'Use the custom tool.' }],
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(result.info.error).toBeUndefined();
      expect(result.parts.some((part: any) => part.text?.includes('HOOK_' + name))).toBe(true);
    }
    expect(f.requests[0].tools.some((tool: any) => tool.function.name === 'custom_' + name)).toBe(
      true,
    );
    expect(f.requests.every((body) => body.temperature === 0.2)).toBe(true);
    expect(f.effects.map((effect) => effect.args.command)).toEqual(
      remote ? ['CUSTOM_proof', 'CUSTOM_proof'] : [],
    );
    expect(f.lifecycle.filter((event) => event.startsWith('initialize'))).toEqual([
      'initialize:' + name,
    ]);
    expect(f.lifecycle.filter((event) => event === 'beforeToolCall')).toHaveLength(2);
    f.worker.server.closeAllConnections();
    await f.worker.close();
    expect(f.lifecycle.at(-1)).toBe('shutdown:' + name);
  }
});

test('compiled permissions deny a custom tool before its environment operation', async () => {
  const f = await setup('blocked', true, 'deny');
  const response = await f.call(`/session/${f.session}/message`, {
    parts: [{ type: 'text', text: 'Try the custom operation.' }],
  });
  expect(response.status).toBe(200);
  await response.json();
  expect(f.effects).toEqual([]);
  expect(
    (f.requests[0].tools ?? []).some((tool: any) => tool.function.name === 'custom_blocked'),
  ).toBe(false);
});

test('a failed custom shutdown still closes the worker HTTP server', async () => {
  const f = await setup('shutdown', false, 'allow', true);
  workers.splice(workers.indexOf(f.worker), 1);
  try {
    await expect(f.worker.close()).rejects.toThrow('custom shutdown failed');
    expect(f.worker.server.listening).toBe(false);
  } finally {
    f.worker.server.closeAllConnections();
    f.worker.server.close();
  }
});
