import { describe, expect, test } from 'bun:test';
import type { GatewayHooks, GatewayTrace, UpstreamDescriptor, UsageEvent } from '../domain';
import { handleChatCompletions } from './simple-handler';

// The handler's side of the attempt plan: which upstream serves, and what the
// usage event and trace record about it. The plan's rules themselves are
// tested at the Dispatch seam (dispatch.test.ts).

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

function hooks(usage: UsageEvent[], traces: GatewayTrace[]): GatewayHooks {
  return {
    authenticate: async () => principal,
    authorize: async () => ({ ok: true, principal }),
    resolveRoute: async () => ({ policyId: 'route', primaryModel: 'primary-model', fallbackModels: [] }),
    resolveUpstream: async () => [primary],
    assertBillingActive: async () => {},
    recordUsage: async (event) => {
      usage.push(event);
    },
    recordTrace: async (trace) => {
      traces.push(trace);
    },
  };
}

describe('model fallback chains (route.fallbackModels)', () => {
  const ok = (content = 'ok') => new Response(JSON.stringify({
    choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const primaryUpstream: UpstreamDescriptor = { ...primary, provider: 'primary-upstream', baseUrl: 'https://primary.example/v1' };
  const fallbackUpstream: UpstreamDescriptor = { ...primary, provider: 'fallback-upstream', baseUrl: 'https://fallback.example/v1' };

  async function run(options: {
    fallbackOn?: 'transient' | 'any-error';
    fallbackModels?: string[];
    respond: (url: string) => Response | Promise<Response>;
    resolve?: (model: string) => UpstreamDescriptor[] | Promise<UpstreamDescriptor[]>;
    requestBody?: Record<string, unknown>;
  }) {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const resolved: string[] = [];
    const response = await handleChatCompletions({
      hooks: {
        ...hooks(usage, traces),
        resolveRoute: async () => ({
          policyId: 'project:default',
          primaryModel: 'primary-model',
          fallbackModels: options.fallbackModels ?? ['fallback-model'],
          fallbackOn: options.fallbackOn ?? 'transient',
          generationDefaultsForModel: (model) => (model === 'fallback-model' ? { temperature: 0.2 } : { temperature: 0.9 }),
        }),
        resolveUpstream: async (_principal, model) => {
          resolved.push(model);
          if (options.resolve) return options.resolve(model);
          return model === 'primary-model' ? [primaryUpstream] : [fallbackUpstream];
        },
      },
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return options.respond(url);
      },
    }, {
      authorization: 'Bearer token',
      rawBody: JSON.stringify(options.requestBody ?? { model: 'requested-model', messages: [{ role: 'user', content: 'hi' }] }),
    });
    return { response, usage, traces, calls, resolved };
  }
  const isPrimary = (url: string) => url.startsWith('https://primary.example');

  test('a transient primary failure moves the request to the configured fallback model', async () => {
    const { response, usage, traces, calls, resolved } = await run({
      respond: (url) => (isPrimary(url) ? new Response('down', { status: 503 }) : ok('from fallback')),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('from fallback');
    expect(resolved).toEqual(['primary-model', 'fallback-model']);
    expect(calls.map((c) => [new URL(c.url).host, c.body.model, c.body.temperature])).toEqual([
      ['primary.example', 'primary-model', 0.9],
      ['fallback.example', 'fallback-model', 0.2],
    ]);
    expect(usage.map((u) => [u.provider, u.model])).toEqual([['fallback-upstream', 'fallback-model']]);
    expect(traces.at(-1)).toMatchObject({
      ok: true,
      attempts: 2,
      resolvedModel: 'fallback-model',
      candidatesTried: ['primary-upstream', 'fallback-upstream:fallback-model'],
    });
    expect(traces.at(-1)?.attemptFailures?.map((f) => [f.provider, f.routeModel, f.status])).toEqual([
      ['primary-upstream', 'primary-model', 503],
    ]);
  });

  test('when every model fails, the last failure reaches the client', async () => {
    const { response, calls } = await run({
      fallbackModels: ['fallback-model', 'second-fallback'],
      respond: (url) => new Response(isPrimary(url) ? 'primary down' : 'fallback down', { status: 503 }),
    });
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('fallback down');
    expect(calls).toHaveLength(3);
  });

  test('a BYOK primary never falls back to a Kortix-billed model', async () => {
    const byok: UpstreamDescriptor = { ...primaryUpstream, billingMode: 'none', markup: 0 };
    const { response, calls } = await run({
      resolve: (model) => (model === 'primary-model' ? [byok] : [fallbackUpstream]),
      respond: () => new Response('limited', { status: 429 }),
    });
    expect(response.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

});

describe('streaming AI SDK transports retry failures raised before the first output', () => {
  const anthropicKey = (secret: string): UpstreamDescriptor => ({
    provider: 'anthropic', kind: 'anthropic', npm: '@ai-sdk/anthropic', baseUrl: 'https://anthropic.example/v1',
    apiKey: secret, poolSecretId: `secret-${secret}`, credentialRef: `secret-${secret}`,
    billingMode: 'none', markup: 0, resolvedModel: 'claude-probe',
  });
  const anthropicStream = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-probe","content":[],"stop_reason":null,"usage":{"input_tokens":5,"output_tokens":1}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello from the second key"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":6}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\n');

  test('a pooled Anthropic stream rotates to the next key after a 429', async () => {
    const usedKeys: string[] = [];
    const cooldowns: Array<{ secretId: string; seconds: number }> = [];
    const traces: GatewayTrace[] = [];
    const response = await handleChatCompletions({
      hooks: {
        ...hooks([], traces),
        resolveUpstream: async () => [anthropicKey('first'), anthropicKey('second')],
        notePoolRateLimit: async (_principal, secretId, seconds) => { cooldowns.push({ secretId, seconds }); },
      },
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async (_url, init) => {
        const key = new Headers(init.headers).get('x-api-key') ?? '';
        usedKeys.push(key);
        if (key === 'first') {
          return new Response(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }), {
            status: 429,
            headers: { 'content-type': 'application/json', 'retry-after': '9' },
          });
        }
        return new Response(anthropicStream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    }, {
      authorization: 'Bearer token',
      rawBody: JSON.stringify({ model: 'anthropic/claude-probe', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('hello from the second key');
    expect(usedKeys).toEqual(['first', 'second']);
    expect(cooldowns).toEqual([{ secretId: 'secret-first', seconds: 9 }]);
    expect(traces.at(-1)).toMatchObject({ ok: true, attempts: 2 });
  });

  test('a streamed rate limit with no other key reaches the client as an HTTP 429', async () => {
    const response = await handleChatCompletions({
      hooks: { ...hooks([], []), resolveUpstream: async () => [anthropicKey('only')] },
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async () => new Response(
        JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } }),
        { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '4' } },
      ),
    }, {
      authorization: 'Bearer token',
      rawBody: JSON.stringify({ model: 'anthropic/claude-probe', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('4');
  });
});
