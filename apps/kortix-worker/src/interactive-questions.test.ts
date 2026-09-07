import { afterEach, expect, test } from 'bun:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { startWorker } from './worker.ts';
import { RuntimeSurface } from './runtime-surface.ts';

const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
afterEach(async () => {
  for (const worker of workers.splice(0)) {
    worker.agent.abort();
    worker.server.closeAllConnections();
    await worker.close();
  }
});
const questions = [
  {
    question: 'Which database?',
    header: 'Database',
    options: [
      { label: 'SQLite', description: 'One file.' },
      { label: 'PostgreSQL', description: 'A database server.' },
    ],
  },
  {
    question: 'Which checks?',
    header: 'Checks',
    multiple: true,
    options: [
      { label: 'Types', description: 'Check types.' },
      { label: 'Tests', description: 'Run tests.' },
    ],
  },
];
async function setup() {
  const worker = await startWorker({
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    systemPrompt: 'Answer.',
    modelMode: 'faux',
    kortixToken: 'question-test',
    sessionId: 'question-test',
  });
  workers.push(worker);
  worker.faux!.setResponses([
    fauxAssistantMessage([fauxToolCall('question', { questions })], { stopReason: 'toolUse' }),
    fauxAssistantMessage('ANSWER_RECEIVED'),
  ]);
  const base = `http://127.0.0.1:${worker.port}`;
  const headers = { authorization: 'Bearer question-test', 'content-type': 'application/json' };
  const call = (path: string, body?: unknown) =>
    fetch(base + path, {
      headers,
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    });
  const [session] = (await (await call('/session')).json()) as Array<{ id: string }>;
  return { worker, base, call, sessionID: session!.id };
}
async function until<T>(read: () => Promise<T>, match: (value: T) => boolean): Promise<T> {
  for (let n = 0; n < 200; n++) {
    const value = await read();
    if (match(value)) return value;
    await Bun.sleep(10);
  }
  throw new Error('Question lifecycle did not settle');
}

test('question routes recover pending cards, validate replies, and preserve answers after restore', async () => {
  const { worker, base, call, sessionID } = await setup();
  expect((await fetch(base + '/question')).status).toBe(401);
  expect((await call('/question')).status).toBe(200);
  const response = await call(`/session/${sessionID}/prompt_async`, {
    parts: [{ type: 'text', text: 'Ask me.' }],
  });
  expect(response.status).toBe(204);
  const pending = await until(
    async () => (await (await call('/question')).json()) as any[],
    (value) => value.length === 1,
  );
  const question = pending[0]!;
  const messages = (await (await call(`/session/${sessionID}/message`)).json()) as any[];
  const part = messages
    .flatMap((m) => m.parts)
    .find((p) => p.type === 'tool' && p.tool === 'question');
  expect(question.tool).toEqual({ messageID: part.messageID, callID: part.callID });
  const state = (await (await call('/kortix/opencode/state')).json()) as any;
  expect(state.questions.value).toEqual(pending);
  expect((await call('/session/status')).status).toBe(200);
  expect(await (await call('/session/status')).json()).toEqual({ [sessionID]: { type: 'busy' } });
  expect(
    (await fetch(base + `/question/${question.id}/reply`, { method: 'POST', body: '{}' })).status,
  ).toBe(401);
  expect((await call(`/question/${question.id}/reply`, { answers: [] })).status).toBe(400);
  expect((await call('/question/%ZZ/reply', { answers: [] })).status).toBe(400);
  expect(await (await call('/question')).json()).toHaveLength(1);
  const answers = [['My custom database'], ['Types', 'Tests']];
  const reply = await call(`/question/${question.id}/reply`, { answers });
  expect(reply.status).toBe(200);
  expect(await reply.json()).toBe(true);
  await until(
    async () => (await (await call(`/session/${sessionID}/message`)).json()) as any[],
    (value) => value.some((m) => m.parts.some((p: any) => p.text === 'ANSWER_RECEIVED')),
  );
  expect(await (await call('/question')).json()).toEqual([]);
  expect((await call(`/question/${question.id}/reply`, { answers })).status).toBe(404);
  const completed = (await (await call(`/session/${sessionID}/message`)).json()) as any[];
  expect(
    completed.flatMap((m) => m.parts).find((p) => p.id === part.id).state.metadata.answers,
  ).toEqual(answers);
  const restored = new RuntimeSurface({ sessionId: 'question-test' });
  restored.seedRestoredMessages(worker.agent.state.messages as any);
  const restoredPart = restored.transcript
    .page({ limit: 50, before: null })
    .messages.flatMap((m) => m.parts)
    .find((p) => p.id === part.id) as any;
  expect(restoredPart.state.metadata.answers).toEqual(answers);
  expect(restoredPart.callID).toBe(part.callID);
});

for (const action of ['reject', 'abort'] as const) {
  test(`${action} removes a pending question and permits the next prompt`, async () => {
    const { worker, call, sessionID } = await setup();
    await call(`/session/${sessionID}/prompt_async`, {
      parts: [{ type: 'text', text: 'Ask me.' }],
    });
    const pending = await until(
      async () => (await (await call('/question')).json()) as any[],
      (value) => value.length === 1,
    );
    const path =
      action === 'reject' ? `/question/${pending[0]!.id}/reject` : `/session/${sessionID}/abort`;
    expect((await call(path, {})).status).toBe(200);
    await until(
      async () => (await (await call('/question')).json()) as any[],
      (value) => value.length === 0,
    );
    await until(
      async () => worker.agent.state.isStreaming,
      (value) => !value,
    );
    worker.faux!.setResponses([fauxAssistantMessage('NEXT_PROMPT_WORKS')]);
    expect(
      (
        await call(`/session/${sessionID}/prompt_async`, {
          parts: [{ type: 'text', text: 'Continue.' }],
        })
      ).status,
    ).toBe(204);
    await until(
      async () => (await (await call(`/session/${sessionID}/message`)).json()) as any[],
      (value) => value.some((m) => m.parts.some((p: any) => p.text === 'NEXT_PROMPT_WORKS')),
    );
  });
}
