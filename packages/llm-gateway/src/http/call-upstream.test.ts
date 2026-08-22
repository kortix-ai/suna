import { describe, expect, test } from 'bun:test';
import type { UpstreamDescriptor } from '../domain';
import { callUpstream } from './call-upstream';

const descriptor: UpstreamDescriptor = {
  provider: 'openrouter',
  kind: 'openai-compat',
  baseUrl: 'https://provider.example/v1/',
  apiKey: 'secret',
  billingMode: 'none',
  markup: 0,
  resolvedModel: 'provider-model',
};

describe('callUpstream OpenAI-compatible passthrough', () => {
  test('performs one fetch and returns the provider response unchanged', async () => {
    let calls = 0;
    let received: { input: string; init: RequestInit } | undefined;
    const provider = new Response('provider failure', {
      status: 503,
      headers: { 'x-provider': 'exact' },
    });
    const response = await callUpstream(
      { model: 'requested', messages: [{ role: 'user', content: 'hello' }] },
      descriptor,
      {
        requestId: 'req_1',
        fetchImpl: async (input, init) => {
          calls += 1;
          received = { input, init };
          return provider;
        },
      },
    );

    expect(calls).toBe(1);
    expect(response).toBe(provider);
    expect(received?.input).toBe('https://provider.example/v1/chat/completions');
    expect(received?.init.headers).toMatchObject({
      authorization: 'Bearer secret',
      'content-type': 'application/json',
      'x-request-id': 'req_1',
    });
    expect(JSON.parse(String(received?.init.body))).toMatchObject({ model: 'provider-model' });
  });

  test('does not dispatch when the client already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await expect(
      callUpstream({}, descriptor, {
        signal: controller.signal,
        fetchImpl: async () => {
          calls += 1;
          return new Response();
        },
      }),
    ).rejects.toThrow('client disconnected');
    expect(calls).toBe(0);
  });
});
