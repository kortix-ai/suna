import { afterEach, expect, test } from 'bun:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { startWorker } from './worker.ts';

const globals = globalThis as Record<string, unknown>;
const original = globals.__KORTIX_COMPILED__;
const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
afterEach(async () => {
  globals.__KORTIX_COMPILED__ = original;
  for (const worker of workers.splice(0)) {
    worker.agent.abort();
    worker.server.closeAllConnections();
    await worker.close();
  }
});
for (const reply of ['once', 'always', 'reject'] as const) {
  test(`permission ${reply} waits for the UI response before invoking the tool`, async () => {
    globals.__KORTIX_COMPILED__ = {
      manifest: { default_agent: 'build' },
      agentConfig: { agent: { build: { permission: { question: 'ask' } } } },
    };
    const worker = await startWorker({
      port: 0,
      envUrl: 'http://127.0.0.1:1',
      envUrlExplicit: true,
      envCwd: '/workspace',
      systemPrompt: 'Answer.',
      modelMode: 'faux',
      kortixToken: 'test',
      sessionId: 'permission-ui',
    });
    workers.push(worker);
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
      fauxAssistantMessage('COMPLETE'),
    ]);
    const base = `http://127.0.0.1:${worker.port}`;
    const call = (path: string, body?: unknown) =>
      fetch(base + path, {
        headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
      });
    const [session] = (await (await call('/session')).json()) as any[];
    expect((await fetch(base + '/permission')).status).toBe(401);
    expect((await call('/permission')).status).toBe(200);
    await call(`/session/${session.id}/prompt_async`, { parts: [{ type: 'text', text: 'Ask.' }] });
    let permissions: any[] = [];
    for (let n = 0; n < 100; n++) {
      permissions = (await (await call('/permission')).json()) as any[];
      if (permissions.length) break;
      await Bun.sleep(10);
    }
    expect(permissions).toHaveLength(1);
    expect(await (await call('/question')).json()).toEqual([]);
    const messages = (await (await call(`/session/${session.id}/message`)).json()) as any[];
    const part = messages.flatMap((m) => m.parts).find((p) => p.tool === 'question');
    expect(permissions[0].tool).toEqual({ messageID: part.messageID, callID: part.callID });
    const path = `/permission/${permissions[0].id}/reply`;
    expect((await call(path, { reply: 'invalid' })).status).toBe(400);
    expect((await call(path, { reply })).status).toBe(200);
    expect(await (await call('/permission')).json()).toEqual([]);
    if (reply !== 'reject') {
      let pending: any[] = [];
      for (let n = 0; n < 100; n++) {
        pending = (await (await call('/question')).json()) as any[];
        if (pending.length) break;
        await Bun.sleep(10);
      }
      expect(pending).toHaveLength(1);
      expect((await call(`/question/${pending[0].id}/reply`, { answers: [['Yes']] })).status).toBe(
        200,
      );
    }
    for (let n = 0; worker.agent.state.isStreaming && n < 100; n++) await Bun.sleep(10);
    expect(worker.agent.state.isStreaming).toBe(false);
    expect(await (await call('/question')).json()).toEqual([]);
  });
}
