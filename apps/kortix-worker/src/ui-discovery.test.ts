import { afterEach, expect, test } from 'bun:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { startWorker } from './worker.ts';
const globals = globalThis as Record<string, unknown>;
const original = globals.__KORTIX_COMPILED__;
let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
afterEach(async () => {
  globals.__KORTIX_COMPILED__ = original;
  if (worker) {
    worker.agent.abort();
    worker.server.closeAllConnections();
    await worker.close();
  }
});
test('the UI discovers its compiled runtime and reads the visible todo state', async () => {
  globals.__KORTIX_COMPILED__ = {
    manifest: { default_agent: 'review' },
    agentConfig: {
      model: 'kortix/openai/gpt-5.4',
      agent: { review: { description: 'Review changes.', model: 'kortix/openai/gpt-5.4' } },
    },
  };
  worker = await startWorker({
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    systemPrompt: 'Answer.',
    modelMode: 'faux',
    modelId: 'openai/gpt-5.4',
    kortixToken: 'test',
    sessionId: 'ui-discovery',
  });
  const base = `http://127.0.0.1:${worker.port}`;
  const call = (path: string, body?: unknown) =>
    fetch(base + path, {
      headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const [session] = (await (await call('/session')).json()) as any[];
  for (const path of [
    '/command',
    '/agent',
    '/permission',
    '/question',
    '/global/config',
    '/config',
    '/lsp/diagnostics',
    `/session/${session.id}/todo`,
    '/tool/ids',
  ]) {
    expect((await fetch(base + path)).status).toBe(401);
    expect((await call(path)).status).toBe(200);
  }
  const agents = (await (await call('/agent')).json()) as any[];
  expect(agents).toMatchObject([
    { name: 'review', description: 'Review changes.', mode: 'primary' },
  ]);
  expect(await (await call('/global/config')).json()).toMatchObject({
    default_agent: 'review',
    model: 'kortix/openai/gpt-5.4',
  });
  const state = await (await call('/kortix/opencode/state')).json() as any;
  expect(state.config.value.model).toBe('kortix/openai/gpt-5.4');
  expect(state.agents.value[0].model).toEqual({ providerID: 'kortix', modelID: 'openai/gpt-5.4' });
  expect(await (await call('/tool/ids')).json()).toEqual(
    expect.arrayContaining(['question', 'todowrite', 'todoread']),
  );
  expect((await call('/session/unknown/todo')).status).toBe(404);
  const todos = [{ content: 'Verify streaming', status: 'completed', priority: 'high' }];
  worker.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('todowrite', { todos })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('DONE'),
  ]);
  await call(`/session/${session.id}/prompt_async`, {
    parts: [{ type: 'text', text: 'Update the task list.' }],
  });
  let readBack: unknown;
  for (let n = 0; n < 100; n++) {
    readBack = await (await call(`/session/${session.id}/todo`)).json();
    if (JSON.stringify(readBack) === JSON.stringify(todos)) break;
    await Bun.sleep(10);
  }
  expect(readBack).toEqual(todos);
  let transcript: any[] = [];
  for (let n = 0; n < 100; n++) {
    transcript = await (await call(`/session/${session.id}/message`)).json() as any[];
    if (transcript.at(-1)?.info.time.completed && !worker.agent.state.isStreaming) break;
    await Bun.sleep(10);
  }
  const assistants = transcript.filter((message) => message.info.role === 'assistant');
  expect(assistants).toHaveLength(2);
  for (const assistant of assistants) {
    expect(assistant.info).toMatchObject({
      agent: 'review',
      mode: 'review',
      providerID: 'kortix',
      modelID: 'openai/gpt-5.4',
    });
  }
});
