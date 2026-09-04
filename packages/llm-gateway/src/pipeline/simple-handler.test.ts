import { describe, expect, test } from 'bun:test';
import type { GatewayHooks, GatewayTrace, UpstreamDescriptor, UsageEvent } from '../domain';
import {
  handleChatCompletions,
  streamErrorTraceStatus,
  upstreamHeadersTimeoutMs,
  withUpstreamHeadersTimeout,
  retryWithoutReasoningEffortPossible,
} from './simple-handler';

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
    recordUsage: async (event) => {
      usage.push(event);
    },
    recordTrace: async (trace) => {
      traces.push(trace);
    },
  };
}

describe('simple gateway pipeline', () => {
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

describe('retryWithoutReasoningEffortPossible', () => {
  const bedrock: UpstreamDescriptor = { ...primary, provider: 'amazon-bedrock', kind: 'bedrock', resolvedModel: 'global.openai.gpt-5.6-sol' };
  test('only a Bedrock candidate carrying reasoning_effort qualifies', () => {
    expect(retryWithoutReasoningEffortPossible({ reasoning_effort: 'max' }, bedrock)).toBe(true);
    expect(retryWithoutReasoningEffortPossible({}, bedrock)).toBe(false);
    expect(retryWithoutReasoningEffortPossible({ reasoning_effort: 'max' }, primary)).toBe(false);
    expect(retryWithoutReasoningEffortPossible(null, bedrock)).toBe(false);
  });
});
