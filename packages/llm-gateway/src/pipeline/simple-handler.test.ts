import { describe, expect, test } from 'bun:test';
import type { GatewayHooks, GatewayTrace, UpstreamDescriptor, UsageEvent } from '../domain';
import { GatewayResolutionError, UpstreamHttpError } from '../errors';
import { rawProviderError } from './dispatch';
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
      fallbackModels: [],
      fallbackOn: 'transient',
    }),
    resolveUpstream: async () => [primary, fallback],
    assertBillingActive: async () => {},
    recordUsage: async (event) => {
      usage.push(event);
    },
    recordTrace: async (trace) => {
      traces.push(trace);
    },
  };
}

describe('simple gateway pipeline', () => {
  test('runs wallet admission only for a Kortix-billed descriptor', async () => {
    const calls: string[] = [];
    for (const descriptor of [
      { ...primary, billingMode: 'none' as const, markup: 0 },
      { ...primary, billingMode: 'credits' as const },
    ]) {
      const response = await handleChatCompletions({
        hooks: {
          ...hooks([], []),
          resolveUpstream: async () => [descriptor],
          assertBillingActive: async (accountId) => { calls.push(accountId); },
        },
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => new Response(JSON.stringify({ choices: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      }, { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'requested-model', messages: [] }) });
      expect(response.status).toBe(200);
    }
    expect(calls).toEqual(['account']);
  });

  test('HTTP pool exhaustion returns the earliest bounded cooldown', async () => {
    const keys: string[] = [];
    const upstream = Bun.serve({ port: 0, fetch: (request) => {
      const key = request.headers.get('authorization') ?? '';
      keys.push(key);
      return new Response('limited', { status: 429, headers: { 'retry-after': key.includes('first') ? '7' : '120' } });
    } });
    const cooldowns: string[] = [];
    try {
      const response = await handleChatCompletions({
        hooks: {
          ...hooks([], []),
          resolveUpstream: async () => [
            // Loopback by address: `upstream.url` reports `localhost`, which does
            // not resolve on a platform sandbox — the pool would answer 502
            // (connection refused) instead of exercising the 429 failover.
            { ...primary, baseUrl: `http://127.0.0.1:${upstream.port}`, poolSecretId: 'first', apiKey: 'first' },
            { ...primary, baseUrl: `http://127.0.0.1:${upstream.port}`, poolSecretId: 'second', apiKey: 'second' },
          ],
          notePoolRateLimit: async (_principal, secretId) => { cooldowns.push(secretId); },
        },
        logger: { info() {}, warn() {}, error() {} },
      }, { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'requested-model', messages: [] }) });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('7');
      // Each key is tried once, and each key's cooldown is recorded.
      expect(keys).toEqual(['Bearer first', 'Bearer second']);
      expect(cooldowns).toEqual(['first', 'second']);
    } finally { await upstream.stop(true); }
  });

  test('pool failover never replays streamed output or a provider-wide failure', async () => {
    for (const status of [200, 503]) {
      const calls: string[] = [];
      const response = await handleChatCompletions({
        hooks: { ...hooks([], []), resolveUpstream: async () => [
          { ...primary, poolSecretId: 'first', apiKey: 'first' },
          { ...primary, poolSecretId: 'second', apiKey: 'second' },
        ] },
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async (_url, init) => {
          calls.push(new Headers(init.headers).get('authorization') ?? '');
          return new Response(status === 200
            ? 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: {"error":{"code":429,"message":"limited"}}\n\ndata: [DONE]\n\n'
            : 'provider unavailable', { status, headers: { 'content-type': 'text/event-stream' } });
        },
      }, { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'requested-model', stream: true, messages: [] }) });
      expect(response.status).toBe(status);
      const body = await response.text();
      if (status === 200) expect(body).toContain('hello');
      expect(calls).toEqual(['Bearer first']);
    }
  });

  test('a pooled credential moves to the next key after a pre-output 429', async () => {
    const usedKeys: string[] = [];
    const cooldowns: Array<{ secretId: string; seconds: number }> = [];
    const response = await handleChatCompletions({
      hooks: {
        ...hooks([], []),
        resolveUpstream: async () => [
          { ...primary, poolSecretId: 'key-a', apiKey: 'first' },
          { ...primary, poolSecretId: 'key-b', apiKey: 'second' },
        ],
        notePoolRateLimit: async (_principal, secretId, seconds) => { cooldowns.push({ secretId, seconds }); },
      },
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async (_url, init) => {
        const credential = new Headers(init.headers).get('authorization') ?? '';
        usedKeys.push(credential);
        return new Response(credential.includes('first') ? 'limited' : '{"choices":[]}', {
          status: credential.includes('first') ? 429 : 200,
          headers: credential.includes('first') ? { 'retry-after': '12' } : undefined,
        });
      },
    }, { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'requested-model', messages: [] }) });
    expect(response.status).toBe(200);
    expect(usedKeys).toEqual(['Bearer first', 'Bearer second']);
    expect(cooldowns).toEqual([{ secretId: 'key-a', seconds: 12 }]);
  });
  // standalone gateway. Every other hook the handler calls classifies its own
  // failure (resolveRoute -> 502 routing_unavailable, resolveUpstream -> 400,
  // billing/budget -> 402); `authorize` did not, so a control-plane transport
  // failure escaped the whole pipeline and was reported by the server's
  // catch-all as `503 gateway_error "Gateway unavailable"` with empty model
  // fields — indistinguishable from a gateway crash. Classify it here instead.
  test('classifies an admission-hook transport failure instead of letting it escape', async () => {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    const errors: string[] = [];
    const response = await handleChatCompletions(
      {
        hooks: {
          ...hooks(usage, traces),
          authorize: async () => {
            throw new Error('attempt 3 exceeded 5000ms');
          },
        },
        logger: {
          info() {},
          warn() {},
          error(message: string) {
            errors.push(message);
          },
        },
        fetchImpl: async () => new Response('{}', { status: 200 }),
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({ model: 'requested-model', messages: [] }),
      },
    );
    expect(response.status).toBe(503);
    const body = (await response.json()) as { code: string; error: { code: string } };
    expect(body.code).toBe('admission_unavailable');
    expect(body.error.code).toBe('admission_unavailable');
    expect(errors.join(' ')).toContain('admission');
  });

  test('dispatches once and passes a provider 503 through without fallback or retry', async () => {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    let calls = 0;
    const response = await handleChatCompletions(
      {
        hooks: hooks(usage, traces),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => {
          calls += 1;
          return new Response('provider unavailable', {
            status: 503,
            headers: { 'x-provider': 'provider-a' },
          });
        },
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({ model: 'requested-model', messages: [] }),
      },
    );

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

  test('a provider fetch that throws reaches the client as a 502 upstream_error', async () => {
    const traces: GatewayTrace[] = [];
    const response = await handleChatCompletions(
      {
        hooks: { ...hooks([], traces), resolveUpstream: async () => [primary] },
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => {
          throw new TypeError('fetch failed');
        },
      },
      { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'requested-model', messages: [] }) },
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: 'upstream_error', message: 'fetch failed' });
    expect(traces[0]).toMatchObject({ ok: false, errorCode: 'upstream_error' });
  });

  // A Kortix-billed model with no catalog price is billed from the cost the
  // provider reports, times the markup; never at zero.
  test.each([
    [
      'JSON',
      false,
      () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'ok' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.002 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    ],
    [
      'SSE',
      true,
      () =>
        new Response(
          'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.002}}\n\ndata: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    ],
  ])('a %s completion without a catalog price settles the reported upstream cost', async (_name, stream, reply) => {
    const usage: UsageEvent[] = [];
    const response = await handleChatCompletions(
      {
        hooks: {
          ...hooks(usage, []),
          resolveUpstream: async () => [{ ...primary, pricing: undefined, markup: 1.2 }],
        },
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => reply(),
      },
      { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'requested-model', stream, messages: [] }) },
    );
    await response.text();
    expect(usage).toHaveLength(1);
    expect(usage[0]!.upstreamCost).toBeCloseTo(0.002, 10);
    expect(usage[0]!.finalCost).toBeCloseTo(0.0024, 10);
  });

  test('retries a bare Bedrock id with its inference profile when Bedrock refuses on-demand invocation', async () => {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    const bedrockGrok: UpstreamDescriptor = {
      ...primary,
      provider: 'amazon-bedrock',
      kind: 'bedrock',
      resolvedModel: 'xai.grok-4.6',
    };
    const urls: string[] = [];
    const response = await handleChatCompletions(
      {
        hooks: { ...hooks(usage, traces), resolveUpstream: async () => [bedrockGrok] },
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async (input) => {
          const url = typeof input === 'string' ? input : ((input as { url?: string }).url ?? String(input));
          urls.push(url);
          if (url.includes('/model/xai.grok-4.6/')) {
            return new Response(
              JSON.stringify({
                message:
                  'Invocation of model ID xai.grok-4.6 with on-demand throughput isn’t supported. Retry your request with the ID or ARN of an inference profile that contains this model.',
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              output: { message: { role: 'assistant', content: [{ text: 'pong' }] } },
              stopReason: 'end_turn',
              usage: { inputTokens: 12, outputTokens: 1, totalTokens: 13 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({
          model: 'amazon-bedrock/xai.grok-4.6',
          messages: [{ role: 'user', content: 'Reply with the single word pong.' }],
        }),
      },
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    expect(body.choices[0]?.message.content).toBe('pong');
    expect(urls.map((u) => new URL(u).pathname.replace(/^.*\/model\//, '/model/'))).toEqual([
      '/model/xai.grok-4.6/converse',
      '/model/global.xai.grok-4.6/converse',
    ]);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      status: 200,
      ok: true,
      resolvedModel: 'global.xai.grok-4.6',
      attempts: 2,
      candidatesTried: ['amazon-bedrock', 'amazon-bedrock:global.xai.grok-4.6'],
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ model: 'global.xai.grok-4.6' });
  });

  test('a Bedrock model that refuses reasoning_effort is retried once without it', async () => {
    const traces: GatewayTrace[] = [];
    const sent: Array<Record<string, unknown>> = [];
    const response = await handleChatCompletions(
      {
        hooks: {
          ...hooks([], traces),
          resolveUpstream: async () => [
            { ...primary, provider: 'amazon-bedrock', kind: 'bedrock', resolvedModel: 'openai.effort-probe' },
          ],
        },
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async (_input, init) => {
          sent.push(JSON.parse(String(init.body)));
          if (sent.length === 1) {
            return new Response(
              JSON.stringify({ message: 'unknown_parameter: reasoning_effort is not supported' }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(
            JSON.stringify({
              output: { message: { role: 'assistant', content: [{ text: 'ok' }] } },
              stopReason: 'end_turn',
              usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        },
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({
          model: 'amazon-bedrock/openai.effort-probe',
          reasoning_effort: 'high',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      },
    );
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(2);
    expect(JSON.stringify(sent[0])).toContain('high');
    expect(JSON.stringify(sent[1])).not.toContain('high');
    expect(traces[0]).toMatchObject({ ok: true, attempts: 2 });
  });

  test('a Bedrock 400 that is NOT the on-demand refusal is passed through with no retry', async () => {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    let calls = 0;
    const response = await handleChatCompletions(
      {
        hooks: {
          ...hooks(usage, traces),
          resolveUpstream: async () => [
            { ...primary, provider: 'amazon-bedrock', kind: 'bedrock', resolvedModel: 'openai.gpt-5.5' },
          ],
        },
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => {
          calls += 1;
          return new Response(JSON.stringify({ message: 'The provided model identifier is invalid.' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        },
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({
          model: 'amazon-bedrock/openai.gpt-5.5',
          messages: [{ role: 'user', content: 'pong?' }],
        }),
      },
    );
    expect(calls).toBe(1);
    expect(response.status).toBe(400);
    expect(traces[0]).toMatchObject({ attempts: 1, candidatesTried: ['amazon-bedrock'] });
  });

  test('a provider 4xx labelled server_error reaches the client without the label OpenCode retries on', async () => {
    // OpenCode retries any body matching /server_error|internal error|.../,
    // whatever the status: this permanent 400 was replayed 5 times (dev 2026-09-29).
    const upstreamBody = JSON.stringify({
      error: { type: 'server_error', message: 'Upstream request failed: This Go model requires Global regions.' },
    });
    for (const stream of [false, true]) {
      const response = await handleChatCompletions(
        {
          hooks: { ...hooks([], []), resolveUpstream: async () => [primary] },
          logger: { info() {}, warn() {}, error() {} },
          fetchImpl: async () => new Response(upstreamBody, { status: 400, headers: { 'content-type': 'application/json' } }),
        },
        { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'requested-model', stream, messages: [{ role: 'user', content: 'hi' }] }) },
      );
      const text = await response.text();
      expect(response.status).toBe(400);
      expect(text).not.toMatch(/server[_ -]?error/i);
      expect(JSON.parse(text)).toEqual({
        error: { message: 'Upstream request failed: This Go model requires Global regions.', type: 'invalid_request_error' },
      });
    }
    const raw = rawProviderError(new UpstreamHttpError(400, upstreamBody));
    expect(await raw.text()).not.toMatch(/server[_ -]?error/i);
    const overflow = rawProviderError(new UpstreamHttpError(400, '{"error":{"message":"prompt is too long"}}'));
    expect((await overflow.json()).error.code).toBe('context_length_exceeded');
    const unavailable = rawProviderError(new UpstreamHttpError(503, upstreamBody));
    expect(await unavailable.text()).toBe(upstreamBody);
  });

  test('settles one successful response exactly once', async () => {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    const body = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    });
    const response = await handleChatCompletions(
      {
        hooks: hooks(usage, traces),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () =>
          new Response(body, { headers: { 'content-type': 'application/json' } }),
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({ model: 'requested-model', messages: [] }),
      },
    );

    expect(await response.text()).toBe(body);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ promptTokens: 10, completionTokens: 4 });
    expect(traces).toHaveLength(1);
  });

  test('a non-stream 200 with no usage object settles an estimate, not zero tokens', async () => {
    const usage: UsageEvent[] = [];
    const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'z'.repeat(800) } }] });
    const response = await handleChatCompletions(
      {
        hooks: hooks(usage, []),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => new Response(body, { headers: { 'content-type': 'application/json' } }),
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({ model: 'requested-model', messages: [{ role: 'user', content: 'p'.repeat(4_000) }] }),
      },
    );
    expect(await response.text()).toBe(body);
    expect(usage).toHaveLength(1);
    // 800 output chars / 4 = 200 tokens; 4,000 prompt chars / 4 + framing >= 1,000 tokens.
    expect(usage[0]).toMatchObject({ usageEstimated: true, completionTokens: 200 });
    expect(usage[0]!.promptTokens).toBeGreaterThanOrEqual(1_000);
  });

  // An error frame before any output served nothing: the client gets the
  // provider's status as an HTTP error, which OpenCode can retry or compact on.
  test.each([
    ['a timeout', '"upstream_timeout"', 502],
    ['a numeric rate limit', '429', 429],
  ])('answers an in-band streaming provider error (%s) before output as an HTTP error', async (_name, code, status) => {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    const response = await handleChatCompletions(
      {
        hooks: hooks(usage, traces),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () =>
          new Response(`data: {"error":{"message":"provider failed","code":${code}}}\n\n`, {
            headers: { 'content-type': 'text/event-stream' },
          }),
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({
          model: 'requested-model',
          messages: [],
          stream: true,
        }),
      },
    );

    expect(response.status).toBe(status);
    expect(await response.text()).toContain('provider failed');
    expect(usage).toHaveLength(0);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({ status, ok: false });
  });

  test('a stream the client stops before the usage frame still settles an estimate', async () => {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    const client = new AbortController();
    const response = await handleChatCompletions(
      {
        hooks: hooks(usage, traces),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                // Output arrives; the usage chunk never does.
                controller.enqueue(
                  new TextEncoder().encode(
                    `data: {"choices":[{"delta":{"content":"${'y'.repeat(800)}"}}]}\n\n`,
                  ),
                );
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      },
      {
        authorization: 'Bearer token',
        signal: client.signal,
        rawBody: JSON.stringify({
          model: 'requested-model',
          stream: true,
          messages: [{ role: 'user', content: 'p'.repeat(40_000) }],
        }),
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    client.abort();
    await reader.cancel();

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ usageEstimated: true, requestId: expect.any(String) });
    expect(usage[0]!.promptTokens).toBeGreaterThanOrEqual(10_000);
    expect(usage[0]!.completionTokens).toBe(200);
    expect(usage[0]!.finalCost).toBeGreaterThan(0);
    // The client left: traced as 499, not as a provider failure.
    expect(traces[0]?.status).toBe(499);
  });

  test('a stream stopped during prefill, before any output, settles the prompt', async () => {
    const usage: UsageEvent[] = [];
    const client = new AbortController();
    let fetched!: () => void;
    const upstreamAnswered = new Promise<void>((resolve) => { fetched = resolve; });
    const pending = handleChatCompletions(
      {
        hooks: hooks(usage, []),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => {
          fetched();
          return new Response(new ReadableStream<Uint8Array>({ pull() {} }), {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      },
      {
        authorization: 'Bearer token',
        signal: client.signal,
        rawBody: JSON.stringify({
          model: 'requested-model',
          stream: true,
          messages: [{ role: 'user', content: 'p'.repeat(4_000) }],
        }),
      },
    );
    // The provider answered headers and is silent in prefill; the client stops.
    await upstreamAnswered;
    client.abort();
    const response = await pending;
    await response.body!.cancel();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ usageEstimated: true, completionTokens: 0 });
    expect(usage[0]!.promptTokens).toBeGreaterThanOrEqual(1_000);
  });

  test('a stream with a usage frame settles the reported usage, never an estimate', async () => {
    const usage: UsageEvent[] = [];
    const response = await handleChatCompletions(
      {
        hooks: hooks(usage, []),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () =>
          new Response(
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
              'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({ model: 'requested-model', stream: true, messages: [] }),
      },
    );
    await response.text();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ promptTokens: 12, completionTokens: 3 });
    expect(usage[0]!.usageEstimated).toBeUndefined();
  });

  test('a BYOK stream stopped early records no estimate', async () => {
    const usage: UsageEvent[] = [];
    const client = new AbortController();
    const response = await handleChatCompletions(
      {
        hooks: { ...hooks(usage, []), resolveUpstream: async () => [{ ...primary, billingMode: 'none', markup: 0 }] },
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      },
      {
        authorization: 'Bearer token',
        signal: client.signal,
        rawBody: JSON.stringify({ model: 'requested-model', stream: true, messages: [{ role: 'user', content: 'q' }] }),
      },
    );
    const reader = response.body!.getReader();
    await reader.read();
    client.abort();
    await reader.cancel();
    expect(usage).toHaveLength(0);
  });

  test('drops wire-framing headers the provider sent for a body fetch already decompressed', async () => {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    const upstreamBody = JSON.stringify({
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const runtime = {
      hooks: hooks(usage, traces),
      logger: { info() {}, warn() {}, error() {} },
    };
    const providerHeaders = {
      'content-type': 'application/json',
      // What OpenRouter sends: fetch gunzips the body, but the headers still
      // describe the compressed wire.
      'content-encoding': 'gzip',
      'content-length': '77',
      'transfer-encoding': 'chunked',
      connection: 'keep-alive',
      'x-request-id': 'upstream-1',
    };

    const json = await handleChatCompletions(
      {
        ...runtime,
        fetchImpl: async () => new Response(upstreamBody, { headers: providerHeaders }),
      },
      { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'm', messages: [] }) },
    );
    expect(json.status).toBe(200);
    expect(json.headers.get('content-encoding')).toBeNull();
    expect(json.headers.get('content-length')).toBeNull();
    expect(json.headers.get('transfer-encoding')).toBeNull();
    expect(json.headers.get('connection')).toBeNull();
    expect(json.headers.get('x-request-id')).toBe('upstream-1');
    expect(await json.text()).toBe(upstreamBody);

    const sse = await handleChatCompletions(
      {
        ...runtime,
        fetchImpl: async () =>
          new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
            headers: { ...providerHeaders, 'content-type': 'text/event-stream' },
          }),
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({ model: 'm', messages: [], stream: true }),
      },
    );
    expect(sse.status).toBe(200);
    expect(sse.headers.get('content-encoding')).toBeNull();
    expect(sse.headers.get('content-length')).toBeNull();
    expect(sse.headers.get('content-type')).toBe('text/event-stream');
    expect(await sse.text()).toContain('[DONE]');
  });

  test('a stream cut before any bytes reach the client is retried transparently against the next pooled key', async () => {
    const warns: unknown[][] = [];
    const cooldowns: Array<{ secretId: string; seconds: number }> = [];
    let call = 0;
    const response = await handleChatCompletions(
      {
        hooks: {
          ...hooks([], []),
          resolveUpstream: async () => [
            { ...primary, poolSecretId: 'key-a', apiKey: 'first' },
            { ...primary, poolSecretId: 'key-b', apiKey: 'second' },
          ],
          notePoolRateLimit: async (_principal, secretId, seconds) => {
            cooldowns.push({ secretId, seconds });
          },
        },
        logger: { info() {}, warn: (...a) => warns.push(a), error() {} },
        fetchImpl: async () => {
          call += 1;
          if (call === 1) {
            // First key: accepts the request, then closes with ZERO bytes —
            // the exact "cut before the first byte" shape.
            return new Response(new ReadableStream({ start(c) { c.close(); } }), {
              headers: { 'content-type': 'text/event-stream' },
            });
          }
          // Second (pooled) key answers cleanly.
          return new Response(
            'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
              'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        },
      },
      { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'm', messages: [], stream: true }) },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"content":"hi"');
    expect(text).not.toContain('upstream_incomplete_stream');
    expect(call).toBe(2);
    // The cut itself is not a rate limit — no cooldown from the retry path.
    expect(cooldowns).toEqual([]);
  });

  test('a stream cut after bytes are already flowing gets an explicit terminal error and a pool cooldown, never a replay', async () => {
    const cooldowns: Array<{ secretId: string; seconds: number }> = [];
    let call = 0;
    const response = await handleChatCompletions(
      {
        hooks: {
          ...hooks([], []),
          resolveUpstream: async () => [{ ...primary, poolSecretId: 'key-a', apiKey: 'first' }],
          notePoolRateLimit: async (_principal, secretId, seconds) => {
            cooldowns.push({ secretId, seconds });
          },
        },
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => {
          call += 1;
          return new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      },
      { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'm', messages: [], stream: true }) },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text.startsWith('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n')).toBe(true);
    expect(text).toContain('upstream_incomplete_stream');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    // No replay: the upstream was only ever called once.
    expect(call).toBe(1);
    expect(cooldowns).toEqual([{ secretId: 'key-a', seconds: 10 }]);
  });

  test('an image-bearing streaming body gets no transparent retry, but still never forwards a partial line', async () => {
    let call = 0;
    const imageBody = JSON.stringify({
      model: 'm',
      stream: true,
      messages: [
        {
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
      ],
    });
    const response = await handleChatCompletions(
      {
        hooks: hooks([], []),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => {
          call += 1;
          // Closes mid-line — no bytes ever complete.
          return new Response('data: {"choices":[{"delta":{"content":"cut', {
            headers: { 'content-type': 'text/event-stream' },
          });
        },
      },
      { authorization: 'Bearer token', rawBody: imageBody },
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('"content":"cut');
    expect(text).toContain('upstream_incomplete_stream');
    expect(call).toBe(1);
  });
});

const isMorph = (url: string): boolean => new URL(url).host === 'morph.example';

describe('provider failover (descriptor.failover)', () => {
  const morph: UpstreamDescriptor = {
    ...primary, provider: 'morph', baseUrl: 'https://morph.example/v1', apiKey: 'morph-key',
    resolvedModel: 'morph-model', failover: true,
  };
  const openrouter: UpstreamDescriptor = {
    ...primary, provider: 'openrouter', baseUrl: 'https://openrouter.example/v1', apiKey: 'or-key',
    resolvedModel: 'vendor/model', failover: true, bodyExtras: { provider: { only: ['a', 'b'] } },
  };
  const ok = () => new Response(JSON.stringify({
    choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });

  async function run(
    candidates: UpstreamDescriptor[],
    respond: (url: string, attempt: number) => Response | Promise<Response>,
    requestBody: Record<string, unknown> = { model: 'requested-model', messages: [{ role: 'user', content: 'hi' }] },
  ) {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const response = await handleChatCompletions({
      hooks: { ...hooks(usage, traces), resolveUpstream: async () => candidates },
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async (url, init) => {
        calls.push({ url, body: JSON.parse(String(init.body)) });
        return respond(url, calls.length);
      },
    }, { authorization: 'Bearer token', rawBody: JSON.stringify(requestBody) });
    return { response, usage, traces, calls };
  }

  for (const status of [429, 401]) {
    test(`a ${status} from the primary moves the request to the next provider`, async () => {
      const { response, usage, traces, calls } = await run([morph, openrouter], (url) =>
        isMorph(url) ? new Response('primary failed', { status }) : ok());
      expect(response.status).toBe(200);
      expect(calls.map((c) => c.url)).toEqual([
        'https://morph.example/v1/chat/completions',
        'https://openrouter.example/v1/chat/completions',
      ]);
      expect(usage.map((u) => [u.provider, u.model])).toEqual([['openrouter', 'vendor/model']]);
      expect(traces.at(-1)?.candidatesTried).toEqual(['morph', 'openrouter']);
      expect(traces.at(-1)?.attempts).toBe(2);
      expect(traces.at(-1)?.attemptFailures?.map((f) => [f.provider, f.code])).toEqual([['morph', status]]);
    });
  }

  test('a network error from the primary moves the request to the next provider', async () => {
    const { response, calls } = await run([morph, openrouter], (url) => {
      if (isMorph(url)) throw new TypeError('fetch failed');
      return ok();
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test('the fallback receives the full request with its own model and body extras', async () => {
    const { calls } = await run([morph, openrouter], (url) =>
      isMorph(url) ? new Response('limited', { status: 429 }) : ok());
    expect(calls[0].body).toMatchObject({ model: 'morph-model', messages: [{ role: 'user', content: 'hi' }] });
    expect(calls[0].body.provider).toBeUndefined();
    expect(calls[1].body).toMatchObject({
      model: 'vendor/model', messages: [{ role: 'user', content: 'hi' }], provider: { only: ['a', 'b'] },
    });
  });

  test('an upstream pin in body extras overrides the same field sent by the client', async () => {
    const { calls } = await run(
      [morph, openrouter],
      (url) => (isMorph(url) ? new Response('limited', { status: 429 }) : ok()),
      { model: 'requested-model', messages: [{ role: 'user', content: 'hi' }], provider: { sort: 'price' } },
    );
    expect(calls[1].body.provider).toEqual({ only: ['a', 'b'] });
  });

  test('a successful primary never calls the fallback', async () => {
    const { response, usage, calls } = await run([morph, openrouter], () => ok());
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(usage.map((u) => u.provider)).toEqual(['morph']);
  });

  test('when every provider fails, the last provider error reaches the client', async () => {
    const { response, calls } = await run([morph, openrouter], (url) =>
      isMorph(url)
        ? new Response('primary down', { status: 503 })
        : new Response('{"error":{"message":"fallback limited"}}', { status: 429 }));
    expect(response.status).toBe(429);
    expect(await response.text()).toContain('fallback limited');
    expect(calls).toHaveLength(2);
  });

  test('a streamed success is relayed from the fallback provider', async () => {
    const { response, calls } = await run([morph, openrouter], (url) =>
      isMorph(url)
        ? new Response('limited', { status: 429 })
        : new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n', {
            status: 200, headers: { 'content-type': 'text/event-stream' },
          }),
      { model: 'requested-model', stream: true, messages: [] });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('hello');
    expect(calls).toHaveLength(2);
    expect(calls[1].body.stream_options).toEqual({ include_usage: true });
  });

  test('candidates without the failover flag keep single-upstream behavior', async () => {
    const byokA: UpstreamDescriptor = { ...primary, provider: 'openai', apiKey: 'a', billingMode: 'none', markup: 0 };
    const byokB: UpstreamDescriptor = { ...byokA, apiKey: 'b' };
    const { response, calls } = await run([byokA, byokB], () => new Response('limited', { status: 429 }));
    expect(response.status).toBe(429);
    expect(calls).toHaveLength(1);
  });

  test('a failover candidate is never reached from a non-failover primary', async () => {
    const byok: UpstreamDescriptor = { ...primary, provider: 'openai', billingMode: 'none', markup: 0 };
    const { response, calls } = await run([byok, openrouter], () => new Response('down', { status: 503 }));
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(1);
  });
});

describe('managed models present as Kortix (descriptor.publicProvider)', () => {
  const managed = (provider: string, baseUrl: string, resolvedModel: string): UpstreamDescriptor => ({
    ...primary, provider, baseUrl, apiKey: `${provider}-key`, resolvedModel, failover: true, publicProvider: 'kortix',
  });
  const morph = managed('morph', 'https://morph.example/v1', 'morph-model');
  const openrouter = managed('openrouter', 'https://openrouter.example/v1', 'vendor/model');
  const LEAK = /openrouter|morph|coreweave|wafer|vendor\/model|morph-model|provider_name/i;
  const coreweave429 = JSON.stringify({ error: {
    message: 'Provider returned error', code: 429,
    metadata: { raw: 'vendor/model is temporarily rate-limited upstream. https://openrouter.ai/settings/integrations', provider_name: 'CoreWeave' },
  } });

  async function run(
    respond: (url: string) => Response | Promise<Response>,
    requestBody: Record<string, unknown> = { model: 'requested-model', messages: [{ role: 'user', content: 'hi' }] },
    candidates: UpstreamDescriptor[] = [morph, openrouter],
  ) {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    const response = await handleChatCompletions({
      hooks: { ...hooks(usage, traces), resolveUpstream: async () => candidates },
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async (url) => respond(url),
    }, { authorization: 'Bearer token', rawBody: JSON.stringify(requestBody) });
    const text = await response.text();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { response, text, usage, traces };
  }

  async function runManaged(
    respond: (url: string) => Response,
    requestBody: Record<string, unknown>,
  ) {
    const calls: string[] = [];
    const result = await run((url) => {
      calls.push(url);
      return respond(url);
    }, requestBody);
    return { ...result, calls };
  }

  test('an upstream 429 reaches the client as a Kortix 429 without upstream identity', async () => {
    const { response, text, traces } = await run(() =>
      new Response(coreweave429, { status: 429, headers: { 'retry-after': '7', 'content-type': 'application/json' } }));
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(text).not.toMatch(LEAK);
    const body = JSON.parse(text);
    expect(body.code).toBe('model_busy');
    expect(body.provider).toBe('kortix');
    expect(body.resolved_model).toBe('primary-model');
    expect(body.message).toContain('primary-model');
    const { upstream, ...customerVisible } = traces.at(-1)!;
    const trace = customerVisible;
    expect(JSON.stringify(customerVisible)).not.toMatch(LEAK);
    // Staff-only: server logs and telemetry keep the real upstream.
    expect(upstream).toEqual({ provider: 'openrouter', model: 'vendor/model' });
    expect(trace.provider).toBe('kortix');
    expect(trace.candidatesTried).toEqual(['kortix', 'kortix']);
  });

  test.each([
    [400, '{"error":{"message":"This endpoint\'s maximum context length is 131072 tokens (Wafer)"}}', 400, 'context_length_exceeded'],
    // CoreWeave through OpenRouter, probed 2026-09-30: no word "context".
    [400, '{"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"message\\":\\"This model configuration accepts at most 1048576 combined input and output tokens. However, your request has 1036630 input tokens and asks for 16384 output tokens (1053014 tokens total).\\"}","provider_name":"CoreWeave"}}}', 400, 'context_length_exceeded'],
    [400, '{"error":{"message":"vendor/model does not support image input on Morph"}}', 400, 'unsupported_input'],
    [400, '{"error":{"message":"Invalid schema for function noop"}}', 400, 'invalid_tool_definition'],
    [422, '{"error":{"message":"bad"}}', 400, 'invalid_request'],
    [401, '{"error":{"message":"Invalid OpenRouter API key"}}', 503, 'model_unavailable'],
    [402, '{"error":{"message":"Morph credits exhausted"}}', 503, 'model_unavailable'],
    [500, 'upstream exploded', 503, 'model_unavailable'],
  ])('an upstream %i is classified for the client', async (status, body, clientStatus, code) => {
    const { response, text } = await run(() => new Response(body, { status }));
    expect(response.status).toBe(clientStatus);
    expect(JSON.parse(text).code).toBe(code);
    expect(text).not.toMatch(LEAK);
  });

  // Prod 2026-09-30: a long GLM session reached OpenRouter's Decart endpoint,
  // which answered 200 and then an in-band 400. OpenCode read that frame as an
  // UnknownError, so it never compacted and every later turn failed the same
  // way. Morph rejects the same request with a bare "Invalid request".
  test('a context overflow reported in-band before output reaches the client as HTTP 400 context_length_exceeded', async () => {
    const overflow =
      'data: {"id":"gen-1","model":"vendor/model","provider":"Decart","choices":[],"error":{"code":400,' +
      '"message":"Upstream error from Decart: Requested token count exceeds the model\'s maximum context length of 1048576 tokens."}}\n\n';
    const { response, text, calls } = await runManaged(
      (url) =>
        new URL(url).hostname === 'morph.example'
          ? new Response('{"error":{"message":"Invalid request","type":"invalid_request_error"}}', { status: 400 })
          : new Response(`: OPENROUTER PROCESSING\n\n${overflow}data: [DONE]\n\n`, {
              status: 200, headers: { 'content-type': 'text/event-stream' },
            }),
      { model: 'requested-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    );
    expect(calls).toEqual(['https://morph.example/v1/chat/completions', 'https://openrouter.example/v1/chat/completions']);
    expect(response.status).toBe(400);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(text);
    // OpenCode's parseAPICallError reads `error.code` to raise ContextOverflowError.
    expect(body.error.code).toBe('context_length_exceeded');
    expect(body.message).toBe('This request is longer than the primary-model context window.');
    expect(text).not.toMatch(LEAK);
  });

  test('a network error on every provider becomes a Kortix 503', async () => {
    const { response, text } = await run(() => { throw new TypeError('connect ECONNREFUSED openrouter.example'); });
    expect(response.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ code: 'model_unavailable', provider: 'kortix' });
    expect(text).not.toMatch(LEAK);
  });

  test('a JSON completion carries the Kortix model and no upstream provider or headers', async () => {
    const { response, text, usage, traces } = await run(() => new Response(JSON.stringify({
      id: 'gen-1', provider: 'Wafer', model: 'vendor/model',
      choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
    }), { status: 200, headers: { 'content-type': 'application/json', 'x-openrouter-provider': 'Wafer', 'x-generation-id': 'gen-1' } }));
    expect(response.status).toBe(200);
    expect(response.headers.get('x-openrouter-provider')).toBeNull();
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(text);
    expect(body.model).toBe('primary-model');
    expect(body.provider).toBeUndefined();
    expect(body.choices[0].message.content).toBe('ok');
    expect(text).not.toMatch(LEAK);
    expect(usage.map((u) => [u.provider, u.model, u.upstream])).toEqual([
      ['kortix', 'primary-model', { provider: 'morph', model: 'morph-model' }],
    ]);
    expect(traces.at(-1)).toMatchObject({ provider: 'kortix', resolvedModel: 'primary-model' });
  });

  test('a stream carries the Kortix model on every chunk and sanitizes an in-band error', async () => {
    const chunks = [
      'data: {"id":"gen-1","provider":"Wafer","model":"vendor/model","choices":[{"delta":{"content":"hel"}}]}\n\n',
      'data: {"id":"gen-1","provider":"Wafer","model":"vendor/mo',
      'del","choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: {"error":{"message":"Provider returned error","code":429,"metadata":{"provider_name":"CoreWeave"}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const { response, text } = await run(() => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    { model: 'requested-model', stream: true, messages: [] });
    expect(response.status).toBe(200);
    expect(text).not.toMatch(LEAK);
    const frames = text.split('\n\n').filter((f) => f.startsWith('data: {')).map((f) => JSON.parse(f.slice(6)));
    expect(frames.slice(0, 2).map((f) => [f.model, f.provider, f.choices[0].delta.content])).toEqual([
      ['primary-model', undefined, 'hel'],
      ['primary-model', undefined, 'lo'],
    ]);
    expect(frames[2].error).toMatchObject({ code: 'model_busy' });
    expect(text).toContain('data: [DONE]');
  });

  test('a managed stream repairs missing upstream event boundaries before a client parses it', async () => {
    const chunks = [
      'data: {"model":"vendor/model","choices":[{"delta":{"reasoning_content":"think"}}]}\n',
      'data: {"model":"vendor/model","choices":[{"delta":{"content":"answer"}}]}\n',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7}}\n',
      'data: [DONE]\n\n',
    ];
    const { response, text, usage, traces } = await run(() => new Response(new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    { model: 'requested-model', stream: true, messages: [] }, [openrouter]);

    expect(response.status).toBe(200);
    const events = text.trim().split(/\r?\n\r?\n/);
    expect(events).toHaveLength(4);
    const data = events.slice(0, -1).map((event) => JSON.parse(event.slice(6)));
    expect(data.slice(0, 2).map((frame) => frame.choices[0].delta)).toEqual([
      { reasoning_content: 'think' },
      { content: 'answer' },
    ]);
    expect(data[0].model).toBe('primary-model');
    expect(data[0].provider).toBeUndefined();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ promptTokens: 11, completionTokens: 7 });
    expect(traces.at(-1)).toMatchObject({ ok: true, status: 200 });
  });

  test('BYOK responses stay byte-for-byte from the provider', async () => {
    const byok: UpstreamDescriptor = { ...primary, provider: 'openrouter', billingMode: 'none', markup: 0 };
    const { response, text } = await run(() => new Response(coreweave429, { status: 429 }), undefined, [byok]);
    expect(response.status).toBe(429);
    expect(text).toBe(coreweave429);
  });
});

describe('model fallback chains (route.fallbackModels)', () => {
  const ok = (content = 'ok') => new Response(JSON.stringify({
    choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
  const primaryUpstream: UpstreamDescriptor = { ...primary, provider: 'primary-upstream', baseUrl: 'https://primary.example/v1' };
  const fallbackUpstream: UpstreamDescriptor = { ...primary, provider: 'fallback-upstream', baseUrl: 'https://fallback.example/v1' };

  async function run(options: {
    fallbackOn?: 'transient' | 'any-error';
    fallbackModels?: string[];
    policyId?: string;
    respond: (url: string) => Response | Promise<Response>;
    resolve?: (model: string) => UpstreamDescriptor[] | Promise<UpstreamDescriptor[]>;
    billing?: GatewayHooks['assertBillingActive'];
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
          policyId: options.policyId ?? 'project:default',
          primaryModel: 'primary-model',
          fallbackModels: options.fallbackModels ?? ['fallback-model'],
          fallbackOn: options.fallbackOn ?? 'transient',
          generationDefaultsForModel: (model) =>
            model === 'fallback-model'
              ? { temperature: 0.2, maxOutputTokens: 50 }
              : { temperature: 0.9, maxOutputTokens: 100 },
        }),
        resolveUpstream: async (_principal, model) => {
          resolved.push(model);
          if (options.resolve) return options.resolve(model);
          return model === 'primary-model' ? [primaryUpstream] : [fallbackUpstream];
        },
        ...(options.billing ? { assertBillingActive: options.billing } : {}),
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
  const isPrimary = (url: string) => new URL(url).host === 'primary.example';

  test('a transient primary failure moves the request to the configured fallback model', async () => {
    const { response, usage, traces, calls, resolved } = await run({
      respond: (url) => (isPrimary(url) ? new Response('down', { status: 503 }) : ok('from fallback')),
      requestBody: { model: 'requested-model', messages: [{ role: 'user', content: 'hi' }], top_p: 0.5 },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('from fallback');
    expect(resolved).toEqual(['primary-model', 'fallback-model']);
    // Each model gets its own generation defaults; a client value wins on every attempt.
    expect(calls.map((c) => [new URL(c.url).host, c.body.model, c.body.temperature, c.body.max_tokens, c.body.top_p])).toEqual([
      ['primary.example', 'primary-model', 0.9, 100, 0.5],
      ['fallback.example', 'fallback-model', 0.2, 50, 0.5],
    ]);
    expect(usage.map((u) => [u.provider, u.model])).toEqual([['fallback-upstream', 'fallback-model']]);
    expect(traces.at(-1)).toMatchObject({
      ok: true,
      attempts: 2,
      resolvedModel: 'fallback-model',
      candidatesTried: ['primary-upstream', 'fallback-upstream:fallback-model'],
      // The route ids a session can show: what answered, and what it stood in for.
      servedModel: 'fallback-model',
      fallbackFrom: 'primary-model',
    });
    expect(traces.at(-1)?.attemptFailures?.map((f) => [f.provider, f.routeModel, f.status])).toEqual([
      ['primary-upstream', 'primary-model', 503],
    ]);
  });

  test('a request its own model answers names that model and no fallback', async () => {
    const { response, traces } = await run({ respond: () => ok('from primary') });
    expect(response.status).toBe(200);
    expect(traces.at(-1)).toMatchObject({ ok: true, servedModel: 'primary-model' });
    expect(traces.at(-1)).not.toHaveProperty('fallbackFrom');
  });

  // Incident 2026-09-28: a routed model the provider would not serve (404 —
  // OpenAI's "the model does not exist or you do not have access to it") left
  // the request with the "model isn't available" error. A 404 is the provider's
  // own "not available" class, so the chain the project configured on Retry on:
  // transient must run.
  test('a model the provider will not serve (404) reaches a transient chain', async () => {
    const { response, resolved, traces } = await run({
      respond: (url) => (isPrimary(url)
        ? new Response(
            JSON.stringify({ error: { message: 'The model does not exist or you do not have access to it.' } }),
            { status: 404, headers: { 'content-type': 'application/json' } },
          )
        : ok('from fallback')),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('from fallback');
    expect(resolved).toEqual(['primary-model', 'fallback-model']);
    expect(traces.at(-1)?.attemptFailures).toEqual([
      expect.objectContaining({ routeModel: 'primary-model', status: 404 }),
    ]);
  });

  // Incident 2026-09-28: codex/gpt-6-sol on a ChatGPT plan hit its usage
  // limit (429); the project's own chain of Kortix models never ran.
  test.each([
    ['a chain the project set in Routing', 'project:exact:primary-model', 200],
    ['the platform route', 'platform-default', 429],
  ])('a ChatGPT-plan primary that fails reaches Kortix models only through %s', async (_name, policyId, expected) => {
    const planUpstream: UpstreamDescriptor = { ...primaryUpstream, provider: 'openai-codex', billingMode: 'none', markup: 0 };
    const managedUpstream: UpstreamDescriptor = { ...fallbackUpstream, billingMode: 'credits' };
    const { response } = await run({
      policyId,
      fallbackOn: 'any-error',
      resolve: (model) => (model === 'primary-model' ? [planUpstream] : [managedUpstream]),
      respond: (url) => (isPrimary(url)
        ? new Response(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'The usage limit has been reached' } }), { status: 429 })
        : ok('from kortix')),
    });
    expect(response.status).toBe(expected);
  });

  // #7979 let a project's chain move a failed ChatGPT request to a Kortix
  // model, but the wallet gate had run for the ChatGPT model alone, which bills
  // nothing: a drained wallet still got Kortix answers.
  test('a Kortix-billed fallback after a ChatGPT failure passes the wallet gate first', async () => {
    const planUpstream: UpstreamDescriptor = { ...primaryUpstream, provider: 'openai-codex', billingMode: 'none', markup: 0 };
    const managedUpstream: UpstreamDescriptor = { ...fallbackUpstream, billingMode: 'credits' };
    const limited = () => new Response(JSON.stringify({ error: { type: 'usage_limit_reached' } }), { status: 429 });
    const chain = {
      policyId: 'project:exact:primary-model',
      fallbackOn: 'any-error' as const,
      resolve: (model: string) => (model === 'primary-model' ? [planUpstream] : [managedUpstream]),
    };

    const gated: string[] = [];
    const paid = await run({
      ...chain,
      respond: (url) => (isPrimary(url) ? limited() : ok('from kortix')),
      billing: async (accountId) => { gated.push(accountId); return { holdUsd: 0.5 }; },
    });
    expect(paid.response.status).toBe(200);
    expect(gated).toEqual(['account']);
    expect(paid.usage).toEqual([expect.objectContaining({ billingMode: 'credits', billingHoldUsd: 0.5 })]);

    const drained = await run({
      ...chain,
      respond: (url) => (isPrimary(url) ? limited() : ok('from kortix')),
      billing: async () => { throw Object.assign(new Error('Insufficient credits'), { reason: 'insufficient_credits' }); },
    });
    expect(drained.response.status).toBe(429);
    expect(drained.calls.map((call) => new URL(call.url).host)).toEqual(['primary.example']);
    expect(drained.usage).toEqual([]);

    // A hold taken for a fallback that then fails is returned in full.
    const failed = await run({
      ...chain,
      respond: (url) => (isPrimary(url) ? limited() : new Response('down', { status: 503 })),
      billing: async () => ({ holdUsd: 0.5 }),
    });
    expect(failed.response.status).toBe(503);
    expect(failed.usage).toEqual([expect.objectContaining({ finalCost: 0, billingHoldUsd: 0.5 })]);
  });

  // With every ChatGPT account paused after a 429, or needing reconnection, the
  // request failed at resolution, before the project's chain could run.
  const unavailable = (code: 'provider_pool_rate_limited' | 'provider_reauth_required' | 'provider_not_connected') => () => {
    throw new GatewayResolutionError(code, `ChatGPT is unavailable: ${code}`, 'Reconnect the account or wait.',
      code === 'provider_pool_rate_limited' ? 42 : undefined);
  };
  test.each([
    ['paused, retry on service errors', 'provider_pool_rate_limited', 'transient', 200],
    ['paused, retry on any error', 'provider_pool_rate_limited', 'any-error', 200],
    ['needing reconnection, retry on any error', 'provider_reauth_required', 'any-error', 200],
    ['needing reconnection, retry on service errors', 'provider_reauth_required', 'transient', 400],
    ['not connected, retry on any error', 'provider_not_connected', 'any-error', 400],
  ] as const)('a ChatGPT model with every account %s', async (_name, code, fallbackOn, expected) => {
    const managedUpstream: UpstreamDescriptor = { ...fallbackUpstream, billingMode: 'credits' };
    const { response, calls, traces } = await run({
      policyId: 'project:exact:primary-model',
      fallbackOn,
      resolve: (model) => (model === 'primary-model' ? unavailable(code)() : [managedUpstream]),
      respond: () => ok('from kortix'),
    });
    expect(response.status).toBe(expected);
    if (expected !== 200) {
      expect(calls).toEqual([]);
      expect(await response.json()).toMatchObject({ error: { code } });
      return;
    }
    expect(await response.text()).toContain('from kortix');
    expect(traces.at(-1)).toMatchObject({
      ok: true,
      attempts: 1,
      resolvedModel: 'fallback-model',
      candidatesTried: [`primary-model:${code}`, 'fallback-upstream:fallback-model'],
    });
    expect(traces.at(-1)?.attemptFailures).toEqual([expect.objectContaining({
      attempt: 1,
      stage: 'resolve',
      routeModel: 'primary-model',
      code,
      status: code === 'provider_pool_rate_limited' ? 429 : 401,
    })]);
  });

  // A routed model that cannot be resolved at all is the same "the provider
  // will not serve this model" class as an upstream 404. The project's own
  // chain is configured for exactly this, so it runs.
  const unroutable = (code: 'model_not_found' | 'model_retired' | 'model_disabled_on_deployment') => () => {
    throw new GatewayResolutionError(code, `The model is unavailable: ${code}`, 'Choose another model.');
  };
  test.each(['model_not_found', 'model_retired', 'model_disabled_on_deployment'] as const)(
    'a project chain takes over an unroutable primary (%s)',
    async (code) => {
      const managedUpstream: UpstreamDescriptor = { ...fallbackUpstream, billingMode: 'credits' };
      const { response, traces } = await run({
        policyId: 'project:exact:primary-model',
        fallbackOn: 'transient',
        resolve: (model) => (model === 'primary-model' ? unroutable(code)() : [managedUpstream]),
        respond: () => ok('from fallback'),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('from fallback');
      expect(traces.at(-1)?.attemptFailures).toEqual([
        expect.objectContaining({ stage: 'resolve', routeModel: 'primary-model', code, status: 404 }),
      ]);
    },
  );

  test('an unroutable primary on the platform route keeps its own error', async () => {
    const { response, calls } = await run({
      policyId: 'platform-default',
      fallbackOn: 'transient',
      resolve: (model) => (model === 'primary-model' ? unroutable('model_not_found')() : [fallbackUpstream]),
      respond: () => ok('from fallback'),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'model_not_found' } });
    expect(calls).toEqual([]);
  });

  test('a paused ChatGPT model on the platform route returns its own error', async () => {
    const { response, calls } = await run({
      policyId: 'platform-default',
      fallbackOn: 'any-error',
      resolve: (model) => (model === 'primary-model' ? unavailable('provider_pool_rate_limited')() : [fallbackUpstream]),
      respond: () => ok('from kortix'),
    });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('42');
    expect(calls).toEqual([]);
  });

  test('a paused ChatGPT model is not moved to a Kortix model the account cannot pay for', async () => {
    const managedUpstream: UpstreamDescriptor = { ...fallbackUpstream, billingMode: 'credits' };
    const { response, calls, usage } = await run({
      policyId: 'project:default',
      resolve: (model) => (model === 'primary-model' ? unavailable('provider_pool_rate_limited')() : [managedUpstream]),
      respond: () => ok('from kortix'),
      billing: async () => { throw Object.assign(new Error('Insufficient credits'), { reason: 'insufficient_credits' }); },
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error: { code: 'provider_pool_rate_limited' } });
    expect(calls).toEqual([]);
    expect(usage).toEqual([]);
  });

  test('a rescued chain keeps numbering its failures when it moves again', async () => {
    const { response, traces } = await run({
      fallbackModels: ['fallback-model', 'second-fallback'],
      resolve: (model) => {
        if (model === 'primary-model') return unavailable('provider_pool_rate_limited')();
        return [{ ...fallbackUpstream, provider: model === 'fallback-model' ? 'fallback-upstream' : 'second-upstream',
          baseUrl: `https://${model}.example/v1` }];
      },
      respond: (url) => (new URL(url).host === 'fallback-model.example' ? new Response('down', { status: 503 }) : ok('second')),
    });
    expect(response.status).toBe(200);
    expect(traces.at(-1)?.attemptFailures?.map((f) => [f.attempt, f.stage, f.routeModel])).toEqual([
      [1, 'resolve', 'primary-model'],
      [2, 'dispatch', 'fallback-model'],
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

describe('trace timing', () => {
  // Measured on dev-api 2026-09-27: a managed call's gateway latency_ms was
  // 7.2-8.4 s while the same model direct took 2-3 s to first token, and the
  // trace could not say whether admission or the upstream spent the gap.
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function run(stream: boolean) {
    const traces: GatewayTrace[] = [];
    const response = await handleChatCompletions(
      {
        hooks: {
          ...hooks([], traces),
          authorize: async () => {
            await sleep(60);
            return { ok: true, principal };
          },
        },
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () => {
          await sleep(120);
          return stream
            ? new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
              })
            : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
        },
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({ model: 'requested-model', messages: [], stream }),
      },
    );
    await response.text();
    for (let i = 0; i < 50 && traces.length === 0; i++) await sleep(10);
    return traces[0]!;
  }

  for (const stream of [false, true]) {
    test(`splits admission from the upstream wait (${stream ? 'stream' : 'json'})`, async () => {
      const trace = await run(stream);
      const timing = trace.metadata.timing as { prep_ms: number; upstream_response_ms: number };
      expect(timing.prep_ms).toBeGreaterThanOrEqual(55);
      expect(timing.upstream_response_ms).toBeGreaterThanOrEqual(115);
      expect(timing.prep_ms + timing.upstream_response_ms).toBeLessThanOrEqual(trace.latencyMs);
    });
  }
});

describe('trace timing segments', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test('names which admission step spent the time before dispatch', async () => {
    const traces: GatewayTrace[] = [];
    const base = hooks([], traces);
    const response = await handleChatCompletions(
      {
        hooks: {
          ...base,
          authorize: async () => {
            await sleep(40);
            return { ok: true, principal };
          },
          resolveRoute: async (p, input) => {
            await sleep(60);
            return base.resolveRoute!(p, input);
          },
          resolveUpstream: async () => {
            await sleep(80);
            return [primary];
          },
          assertBillingActive: async () => {
            await sleep(100);
          },
        },
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () =>
          new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      },
      { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'requested-model', messages: [] }) },
    );
    await response.text();
    for (let i = 0; i < 50 && traces.length === 0; i++) await sleep(10);
    const timing = traces[0]!.metadata.timing as Record<string, number>;
    expect(timing.admit_ms).toBeGreaterThanOrEqual(35);
    expect(timing.route_ms).toBeGreaterThanOrEqual(55);
    expect(timing.resolve_ms).toBeGreaterThanOrEqual(75);
    expect(timing.billing_ms).toBeGreaterThanOrEqual(95);
    expect(timing.admit_ms + timing.route_ms + timing.resolve_ms + timing.billing_ms).toBeLessThanOrEqual(timing.prep_ms);
  });
});
