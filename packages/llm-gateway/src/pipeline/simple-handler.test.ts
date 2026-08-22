import { describe, expect, test } from 'bun:test';
import type { GatewayHooks, GatewayTrace, UpstreamDescriptor, UsageEvent } from '../domain';
import { handleChatCompletions } from './simple-handler';

const principal = { userId: 'user', accountId: 'account', projectId: 'project' };
const primary: UpstreamDescriptor = {
  provider: 'provider-a',
  kind: 'openai-compat',
  baseUrl: 'https://provider-a.example/v1',
  apiKey: 'key',
  billingMode: 'credits',
  markup: 1,
  pricing: { inputPerMillion: 1, outputPerMillion: 2 },
};
const fallback: UpstreamDescriptor = { ...primary, provider: 'provider-b' };

function hooks(usage: UsageEvent[], traces: GatewayTrace[]): GatewayHooks {
  return {
    authenticate: async () => principal,
    authorize: async () => ({ ok: true, principal }),
    resolveRoute: async () => ({
      policyId: 'route',
      primaryModel: 'primary-model',
      fallbackModels: ['fallback-model'],
      fallbackOn: 'any-error',
    }),
    resolveUpstream: async () => [primary, fallback],
    assertBillingActive: async () => {},
    recordUsage: async (event) => { usage.push(event); },
    recordTrace: async (trace) => { traces.push(trace); },
  };
}

describe('simple gateway pipeline', () => {
  test('dispatches once and passes a provider 503 through without fallback or retry', async () => {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    let calls = 0;
    const response = await handleChatCompletions({
      hooks: hooks(usage, traces),
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async () => {
        calls += 1;
        return new Response('provider unavailable', {
          status: 503,
          headers: { 'x-provider': 'provider-a' },
        });
      },
    }, {
      authorization: 'Bearer token',
      rawBody: JSON.stringify({ model: 'requested-model', messages: [] }),
    });

    expect(calls).toBe(1);
    expect(response.status).toBe(503);
    expect(response.headers.get('x-provider')).toBe('provider-a');
    expect(await response.text()).toBe('provider unavailable');
    expect(usage).toHaveLength(0);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ attempts: 1, candidatesTried: ['provider-a'] });
    expect(traces[0]?.request).toBeUndefined();
    expect(traces[0]?.response).toBeUndefined();
  });

  test('settles one successful response exactly once', async () => {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    const response = await handleChatCompletions({
      hooks: hooks(usage, traces),
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
    }, {
      authorization: 'Bearer token',
      rawBody: JSON.stringify({ model: 'requested-model', messages: [] }),
    });

    expect(await response.text()).toBe(body);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ promptTokens: 10, completionTokens: 4 });
    expect(traces).toHaveLength(1);
  });
});
