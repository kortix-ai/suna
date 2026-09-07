import { afterEach, expect, test } from 'bun:test';
import { parsePromptInput } from './prompt-input.ts';
import { startWorker } from './worker.ts';

const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const providers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  await Promise.all(
    workers.splice(0).map(async (worker) => {
      worker.server.closeAllConnections();
      await worker.close();
    }),
  );
  for (const provider of providers.splice(0)) provider.stop(true);
});

test.each(['Use the first convention.', ''])('preserves the prompt system string %j', (system) => {
  expect(
    parsePromptInput(JSON.stringify({ system, parts: [{ type: 'text', text: 'Hello' }] }), {}),
  ).toEqual({ ok: true, value: { text: 'Hello', system } });
});

test.each([null, false, 42, {}, []].map((system) => [system] as const))(
  'rejects a non-string prompt system %j',
  (system) => {
    expect(
      parsePromptInput(JSON.stringify({ system, parts: [{ type: 'text', text: 'Hello' }] }), {}),
    ).toEqual({ ok: false, error: 'system must be a string' });
  },
);

test('provider requests append only the current prompt system and restore the compiled instructions', async () => {
  const requests: { messages: { role: string; content: unknown }[] }[] = [];
  const provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: unknown }[] };
      requests.push(body);
      if (JSON.stringify(body.messages.at(-1)?.content).includes('Fail this request.')) {
        return Response.json(
          { error: { message: 'Fixture provider rejected this request.' } },
          { status: 400 },
        );
      }
      const frames = [
        {
          id: 'system-response',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'openai/gpt-4.1',
          choices: [
            { index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: null },
          ],
        },
        {
          id: 'system-response',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'openai/gpt-4.1',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
      ];
      return new Response(
        frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  providers.push(provider);
  const worker = await startWorker({
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    envTransport: 'fetch',
    systemPrompt: 'Compiled agent instruction.',
    modelMode: 'real',
    providerId: 'openrouter',
    modelId: 'openai/gpt-4.1',
    gatewayUrl: provider.url.toString().replace(/\/$/, '') + '/v1',
    apiKey: 'fixture-provider-token',
    sessionId: 'prompt-system',
    kortixToken: 'runtime-token',
  });
  workers.push(worker);
  const base = `http://127.0.0.1:${worker.port}`;
  const headers = { authorization: 'Bearer runtime-token', 'content-type': 'application/json' };
  const sessions = (await (await fetch(base + '/session', { headers })).json()) as { id: string }[];
  const systemBefore = worker.agent.state.systemPrompt;
  for (const system of [
    'Use convention A.',
    undefined,
    'Use convention B.',
    '',
    'Fail convention.',
    undefined,
  ]) {
    const response = await fetch(base + `/session/${sessions[0]!.id}/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        system,
        parts: [
          { type: 'text', text: system === 'Fail convention.' ? 'Fail this request.' : 'Reply.' },
        ],
      }),
    });
    expect(response.status).toBe(200);
    const answer = (await response.json()) as { info: { error?: unknown } };
    if (system === 'Fail convention.') expect(answer.info.error).toBeDefined();
    else expect(answer.info.error).toBeUndefined();
    const request = requests.at(-1)!;
    const prompt = request.messages
      .filter((message) => message.role === 'system')
      .map((message) => message.content)
      .join('\n');
    expect(prompt).toBe(system ? `${systemBefore}\n${system}` : systemBefore);
    expect(worker.agent.state.systemPrompt).toBe(systemBefore);
  }
  expect(requests).toHaveLength(6);
  const messages = (await (
    await fetch(base + `/session/${sessions[0]!.id}/message`, { headers })
  ).json()) as { info: { role: string; system?: string } }[];
  expect(
    messages
      .filter((message) => message.info.role === 'user')
      .map((message) => message.info.system),
  ).toEqual([
    'Use convention A.',
    undefined,
    'Use convention B.',
    '',
    'Fail convention.',
    undefined,
  ]);
});
