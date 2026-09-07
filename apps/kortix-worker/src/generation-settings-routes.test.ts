import { afterEach, describe, expect, test } from 'bun:test';

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
  await Promise.all(
    workers.splice(0).map(async (worker) => {
      worker.server.closeAllConnections();
      await worker.close();
    }),
  );
  for (const provider of providers.splice(0)) provider.stop(true);
});

async function exercise(
  settings: Record<string, unknown>,
  providerId: 'openrouter' | 'anthropic',
  configuredModel?: string,
) {
  const requests: { path: string; body: Record<string, any> }[] = [];
  const modelId =
    configuredModel ?? (providerId === 'openrouter' ? 'openai/gpt-4.1' : 'claude-sonnet-4-5');
  const provider = Bun.serve({
    port: 0,
    async fetch(request) {
      expect(request.headers.get(providerId === 'openrouter' ? 'authorization' : 'x-api-key')).toBe(
        providerId === 'openrouter' ? 'Bearer fixture-provider-token' : 'fixture-provider-token',
      );
      requests.push({ path: new URL(request.url).pathname, body: await request.json() });
      const frames =
        providerId === 'openrouter'
          ? [
              {
                id: 'response-settings',
                object: 'chat.completion.chunk',
                created: 1,
                model: modelId,
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: 'Settings applied.' },
                    finish_reason: null,
                  },
                ],
              },
              {
                id: 'response-settings',
                object: 'chat.completion.chunk',
                created: 1,
                model: modelId,
                choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              },
            ]
              .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
              .join('') + 'data: [DONE]\n\n'
          : [
              {
                type: 'message_start',
                message: {
                  id: 'response-settings',
                  type: 'message',
                  role: 'assistant',
                  model: modelId,
                  content: [],
                  stop_reason: null,
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 0 },
                },
              },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: 'Settings applied.' },
              },
              { type: 'content_block_stop', index: 0 },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn', stop_sequence: null },
                usage: { output_tokens: 3 },
              },
              { type: 'message_stop' },
            ]
              .map((frame) => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`)
              .join('');
      return new Response(frames, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  providers.push(provider);
  process.env.KORTIX_AGENT = 'selected';
  globals.__KORTIX_COMPILED__ = {
    manifest: { default_agent: 'other' },
    agentConfig: { agent: { selected: settings, other: { temperature: 1.9, top_p: 0.1 } } },
  };
  const worker = await startWorker({
    port: 0,
    envUrl: 'http://127.0.0.1:1',
    envUrlExplicit: true,
    envCwd: '/workspace',
    envTransport: 'fetch',
    systemPrompt: 'Answer briefly.',
    modelMode: 'real',
    providerId,
    modelId,
    gatewayUrl:
      provider.url.toString().replace(/\/$/, '') + (providerId === 'openrouter' ? '/v1' : ''),
    apiKey: 'fixture-provider-token',
    sessionId: 'generation-settings',
    kortixToken: 'runtime-token',
  });
  workers.push(worker);
  const base = `http://127.0.0.1:${worker.port}`;
  const headers = { authorization: 'Bearer runtime-token', 'content-type': 'application/json' };
  const sessions = (await (await fetch(base + '/session', { headers })).json()) as { id: string }[];
  for (let turn = 0; turn < 2; turn++) {
    const response = await fetch(base + `/session/${sessions[0]!.id}/message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ parts: [{ type: 'text', text: 'Reply.' }] }),
    });
    expect(response.status).toBe(200);
    const message = (await response.json()) as any;
    expect(message.info.error).toBeUndefined();
    expect(
      message.parts.some((part: any) => part.type === 'text' && part.text === 'Settings applied.'),
    ).toBe(true);
  }
  expect(requests).toHaveLength(2);
  for (const request of requests) expect(request.body.model).toBe(modelId);
  return requests;
}

describe('compiled agent sampling through the real provider HTTP transport', () => {
  test('a gateway model absent from the Pi catalog retains its exact model reference', async () => {
    const requests = await exercise(
      { temperature: 0.25, top_p: 0.9 },
      'openrouter',
      'fixture/new-model',
    );
    for (const request of requests) {
      expect(request.body.temperature).toBe(0.25);
      expect(request.body.top_p).toBe(0.9);
    }
  });

  for (const provider of ['openrouter', 'anthropic'] as const) {
    test(`${provider} sends the selected agent settings on every model request`, async () => {
      const requests = await exercise({ temperature: 0, top_p: 0.75 }, provider);
      for (const request of requests) {
        expect(request.path).toBe(
          provider === 'openrouter' ? '/v1/chat/completions' : '/v1/messages',
        );
        expect(request.body.temperature).toBe(0);
        expect(request.body.top_p).toBe(0.75);
        expect(request.body.stream).toBe(true);
        expect(request.body.tools.length).toBeGreaterThan(0);
      }
    });

    test(`${provider} preserves an explicit zero top_p without adding temperature`, async () => {
      const requests = await exercise({ top_p: 0 }, provider);
      for (const request of requests) {
        expect(request.body.top_p).toBe(0);
        expect(request.body).not.toHaveProperty('temperature');
      }
    });

    test(`${provider} leaves omitted sampling fields to the provider defaults`, async () => {
      const requests = await exercise({}, provider);
      for (const request of requests) {
        expect(request.body).not.toHaveProperty('temperature');
        expect(request.body).not.toHaveProperty('top_p');
      }
    });
  }
});
