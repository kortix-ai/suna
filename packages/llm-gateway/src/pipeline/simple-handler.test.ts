import { describe, expect, test } from 'bun:test';
import type { GatewayHooks, GatewayTrace, UpstreamDescriptor, UsageEvent } from '../domain';
import { upstreamHeadersTimeoutMs, withUpstreamHeadersTimeout } from './dispatch';
import { handleChatCompletions, streamErrorTraceStatus } from './simple-handler';

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
    try {
      const response = await handleChatCompletions({
        hooks: { ...hooks([], []), resolveUpstream: async () => [
          { ...primary, baseUrl: upstream.url.toString(), poolSecretId: 'first', apiKey: 'first' },
          { ...primary, baseUrl: upstream.url.toString(), poolSecretId: 'second', apiKey: 'second' },
        ] },
        logger: { info() {}, warn() {}, error() {} },
      }, { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'requested-model', messages: [] }) });
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('7');
      expect(keys).toEqual(['Bearer first', 'Bearer second']);
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
  test('a pool exhausts each key once and returns the provider rate limit', async () => {
    const usedKeys: string[] = [];
    const cooldowns: string[] = [];
    const response = await handleChatCompletions({
      hooks: {
        ...hooks([], []),
        resolveUpstream: async () => [
          { ...primary, poolSecretId: 'key-a', apiKey: 'first' },
          { ...primary, poolSecretId: 'key-b', apiKey: 'second' },
        ],
        notePoolRateLimit: async (_principal, secretId) => { cooldowns.push(secretId); },
      },
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async (_url, init) => {
        usedKeys.push(new Headers(init.headers).get('authorization') ?? '');
        return new Response('limited', { status: 429, headers: { 'retry-after': '8' } });
      },
    }, { authorization: 'Bearer token', rawBody: JSON.stringify({ model: 'requested-model', messages: [] }) });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('8');
    expect(usedKeys).toEqual(['Bearer first', 'Bearer second']);
    expect(cooldowns).toEqual(['key-a', 'key-b']);
  });

// The admission hook is a NETWORK call to the API control plane on the
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

  test('aborts a provider fetch that does not return response headers before the deadline', async () => {
    const fetchWithTimeout = withUpstreamHeadersTimeout(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        }),
      5,
    );

    await expect(fetchWithTimeout('https://provider.example', {})).rejects.toMatchObject({
      name: 'TimeoutError',
    });
  });

  test('clears the provider-headers deadline before consuming the response body', async () => {
    const providerSignals: AbortSignal[] = [];
    const fetchWithTimeout = withUpstreamHeadersTimeout(async (_input, init) => {
      if (init.signal) providerSignals.push(init.signal);
      return new Response(
        new ReadableStream({
          async start(controller) {
            await Bun.sleep(15);
            controller.enqueue(new TextEncoder().encode('late body'));
            controller.close();
          },
        }),
      );
    }, 5);

    const response = await fetchWithTimeout('https://provider.example', {});
    expect(await response.text()).toBe('late body');
    expect(providerSignals[0]?.aborted).toBe(false);
  });

  test('keeps client cancellation attached after provider headers arrive', async () => {
    const client = new AbortController();
    const providerSignals: AbortSignal[] = [];
    const fetchWithTimeout = withUpstreamHeadersTimeout(async (_input, init) => {
      if (init.signal) providerSignals.push(init.signal);
      return new Response('stream');
    }, 50);

    await fetchWithTimeout('https://provider.example', {
      signal: client.signal,
    });
    client.abort('client left');
    expect(providerSignals[0]?.aborted).toBe(true);
    expect(providerSignals[0]?.reason).toBe('client left');
  });

  test('preserves numeric stream failures and distinguishes client cancellation', () => {
    expect(streamErrorTraceStatus({ message: 'limited', code: 429 })).toBe(429);
    expect(streamErrorTraceStatus({ message: 'left', code: 'client_aborted' })).toBe(499);
    expect(streamErrorTraceStatus({ message: 'timeout', code: 'upstream_timeout' })).toBe(502);
  });

  test('keeps a bounded but longer header budget for synthetic streaming responses', () => {
    const limits = { direct: 90_000, syntheticStreaming: 300_000 };
    expect(upstreamHeadersTimeoutMs({ stream: true }, { ...primary, kind: 'bedrock' }, true, limits)).toBe(300_000);
    expect(upstreamHeadersTimeoutMs({ stream: true }, primary, true, limits)).toBe(90_000);
    expect(upstreamHeadersTimeoutMs({ stream: false }, { ...primary, kind: 'bedrock' }, false, limits)).toBe(90_000);
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

  test('records an in-band streaming provider error as a failed gateway request', async () => {
    const usage: UsageEvent[] = [];
    const traces: GatewayTrace[] = [];
    const response = await handleChatCompletions(
      {
        hooks: hooks(usage, traces),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () =>
          new Response('data: {"error":{"message":"provider timed out","code":"upstream_timeout"}}\n\n', {
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

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('provider timed out');
    expect(usage).toHaveLength(0);
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      status: 502,
      ok: false,
      errorCode: 'upstream_timeout',
      errorMessage: 'provider timed out',
    });
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
  });

  test('a stream stopped during prefill, before any output, settles the prompt', async () => {
    const usage: UsageEvent[] = [];
    const client = new AbortController();
    const response = await handleChatCompletions(
      {
        hooks: hooks(usage, []),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async () =>
          new Response(new ReadableStream<Uint8Array>({ pull() {} }), {
            headers: { 'content-type': 'text/event-stream' },
          }),
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
    client.abort();
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

  for (const status of [429, 500, 502, 503, 401, 402]) {
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

  test('a network error on the primary also moves to the fallback model', async () => {
    const { response, calls } = await run({
      respond: (url) => {
        if (isPrimary(url)) throw new TypeError('fetch failed');
        return ok();
      },
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test('a transient chain returns a request error (400) unchanged', async () => {
    const { response, calls, resolved } = await run({
      respond: () => new Response('{"error":{"message":"bad request"}}', { status: 400 }),
    });
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(1);
    expect(resolved).toEqual(['primary-model']);
  });

  test('an any-error chain moves past a request error too', async () => {
    const { response, calls } = await run({
      fallbackOn: 'any-error',
      respond: (url) => (isPrimary(url) ? new Response('bad', { status: 400 }) : ok()),
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test('a successful primary never resolves the fallback model', async () => {
    const { response, calls, resolved } = await run({ respond: () => ok() });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(resolved).toEqual(['primary-model']);
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

  test('a fallback model that cannot be resolved is skipped', async () => {
    const { response, calls, resolved } = await run({
      fallbackModels: ['unavailable-model', 'fallback-model'],
      resolve: (model) => {
        if (model === 'unavailable-model') throw new Error('provider not connected');
        return model === 'primary-model' ? [primaryUpstream] : [fallbackUpstream];
      },
      respond: (url) => (isPrimary(url) ? new Response('down', { status: 502 }) : ok()),
    });
    expect(response.status).toBe(200);
    expect(resolved).toEqual(['primary-model', 'unavailable-model', 'fallback-model']);
    expect(calls).toHaveLength(2);
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

  test('a BYOK primary may fall back to another BYOK model', async () => {
    const byok: UpstreamDescriptor = { ...primaryUpstream, billingMode: 'none', markup: 0 };
    const byokFallback: UpstreamDescriptor = { ...fallbackUpstream, billingMode: 'none', markup: 0 };
    const { response, calls } = await run({
      resolve: (model) => (model === 'primary-model' ? [byok] : [byokFallback]),
      respond: (url) => (isPrimary(url) ? new Response('limited', { status: 429 }) : ok()),
    });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  test('the client leaving stops the chain', async () => {
    const client = new AbortController();
    const calls: string[] = [];
    const response = await handleChatCompletions({
      hooks: {
        ...hooks([], []),
        resolveRoute: async () => ({ policyId: 'p', primaryModel: 'primary-model', fallbackModels: ['fallback-model'], fallbackOn: 'any-error' }),
        resolveUpstream: async (_p, model) => (model === 'primary-model' ? [primaryUpstream] : [fallbackUpstream]),
      },
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl: async (url) => {
        calls.push(url);
        client.abort();
        throw new DOMException('aborted', 'AbortError');
      },
    }, { authorization: 'Bearer token', signal: client.signal, rawBody: JSON.stringify({ model: 'm', messages: [] }) });
    expect(response.status).toBeGreaterThanOrEqual(400);
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
