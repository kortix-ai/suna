import { afterEach, expect, test } from 'bun:test';

import { startWorker } from './worker.ts';

const globals = globalThis as Record<string, unknown>;
const originalCompiled = globals.__KORTIX_COMPILED__;
const originalAgent = process.env.KORTIX_AGENT;
const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const providers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  globals.__KORTIX_COMPILED__ = originalCompiled;
  if (originalAgent === undefined) delete process.env.KORTIX_AGENT;
  else process.env.KORTIX_AGENT = originalAgent;
  for (const worker of workers.splice(0)) {
    worker.agent.abort();
    worker.server.closeAllConnections();
    await worker.close();
  }
  for (const provider of providers.splice(0)) provider.stop(true);
});

async function setup(steps?: number, ignoreLimit = false) {
  const requests: Record<string, any>[] = [];
  const provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as Record<string, any>;
      requests.push(body);
      const userIndex = body.messages.findLastIndex((message: any) => message.role === 'user');
      const calls = body.messages.slice(userIndex + 1).filter((m: any) => m.role === 'tool').length;
      const limited = !body.tools?.length;
      const callTool = calls < 3 && (!limited || ignoreLimit);
      const delta = callTool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: `call_${requests.length}`,
                type: 'function',
                function: {
                  name: 'todowrite',
                  arguments: JSON.stringify({
                    todos: [
                      { content: `Step ${calls + 1}`, status: 'pending', priority: 'medium' },
                    ],
                  }),
                },
              },
            ],
          }
        : { role: 'assistant', content: limited ? 'STEP_LIMIT_SUMMARY' : 'ALL_STEPS_COMPLETE' };
      const frames = [
        { choices: [{ index: 0, delta, finish_reason: null }] },
        { choices: [{ index: 0, delta: {}, finish_reason: callTool ? 'tool_calls' : 'stop' }] },
      ]
        .map(
          (frame) =>
            `data: ${JSON.stringify({ id: 'response-steps', model: body.model, ...frame })}\n\n`,
        )
        .join('');
      return new Response(frames + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  providers.push(provider);
  process.env.KORTIX_AGENT = 'selected';
  globals.__KORTIX_COMPILED__ = {
    agentConfig: { agent: { selected: { steps, temperature: 0 }, other: { steps: 1 } } },
  };
  const worker = await startWorker({
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    systemPrompt: 'Use tools to update the task list.',
    modelMode: 'real',
    providerId: 'openrouter',
    modelId: 'openai/gpt-4.1',
    gatewayUrl: provider.url.toString().replace(/\/$/, '') + '/v1',
    apiKey: 'fixture-provider-token',
    sessionId: 'agent-steps',
    kortixToken: 'runtime-token',
  });
  workers.push(worker);
  const base = `http://127.0.0.1:${worker.port}`;
  const headers = { authorization: 'Bearer runtime-token', 'content-type': 'application/json' };
  const call = (path: string, body?: unknown) =>
    fetch(base + path, {
      headers,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const sessions = (await (await call('/session')).json()) as { id: string }[];
  const session = sessions[0]!.id;
  const prompt = async () => {
    const response = await call(`/session/${session}/message`, {
      parts: [{ type: 'text', text: 'Update the task list three times.' }],
    });
    expect(response.status).toBe(200);
    const message = (await response.json()) as any;
    expect(message.info.error).toBeUndefined();
    return message;
  };
  const todos = async () => (await (await call(`/session/${session}/todo`)).json()) as any[];
  return { worker, requests, prompt, todos };
}

test('the selected agent reserves the final step for a summary and resets for each prompt', async () => {
  const { worker, requests, prompt, todos } = await setup(2);
  const initialTools = worker.agent.state.tools;
  const initialSystem = worker.agent.state.systemPrompt;
  for (let turn = 0; turn < 2; turn++) {
    const message = await prompt();
    expect(message.parts.some((part: any) => part.text === 'STEP_LIMIT_SUMMARY')).toBe(true);
    expect(requests).toHaveLength((turn + 1) * 2);
    const [first, last] = requests.slice(turn * 2);
    expect(first!.tools.length).toBeGreaterThan(0);
    expect(last!.tools ?? []).toEqual([]);
    expect(first!.messages[0].content).not.toContain('step limit');
    expect(last!.messages[0].content).toContain('step limit');
    expect(last!.temperature).toBe(0);
    expect(await todos()).toEqual([{ content: 'Step 1', status: 'pending', priority: 'medium' }]);
    expect(worker.agent.state.tools).toEqual(initialTools);
    expect(worker.agent.state.systemPrompt).toBe(initialSystem);
  }
});

test('steps=1 asks for text immediately and executes no tool', async () => {
  const { requests, prompt, todos } = await setup(1);
  const message = await prompt();
  expect(message.parts.some((part: any) => part.text === 'STEP_LIMIT_SUMMARY')).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]!.tools ?? []).toEqual([]);
  expect(await todos()).toEqual([]);
});

test('a provider that ignores the final-step tool restriction cannot execute another tool or loop', async () => {
  const { worker, requests, prompt, todos } = await setup(2, true);
  await prompt();
  expect(requests).toHaveLength(2);
  expect(await todos()).toEqual([{ content: 'Step 1', status: 'pending', priority: 'medium' }]);
  const result = worker.agent.state.messages.at(-1) as any;
  expect(result.role).toBe('toolResult');
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toContain('step limit');
  expect(worker.agent.state.isStreaming).toBe(false);
});

test('an omitted step limit allows all tool iterations', async () => {
  const { requests, prompt, todos } = await setup();
  const message = await prompt();
  expect(message.parts.some((part: any) => part.text === 'ALL_STEPS_COMPLETE')).toBe(true);
  expect(requests).toHaveLength(4);
  expect(requests.every((request) => request.tools.length > 0)).toBe(true);
  expect(await todos()).toEqual([{ content: 'Step 3', status: 'pending', priority: 'medium' }]);
});
