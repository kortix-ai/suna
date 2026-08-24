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
    recordUsage: async (event) => {
      usage.push(event);
    },
    recordTrace: async (trace) => {
      traces.push(trace);
    },
  };
}

describe('simple gateway pipeline', () => {
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

  test('the acceptance deadline NEVER aborts a stream that outlives it (#6473 regression)', async () => {
    // A long-running turn: headers arrive instantly, tokens keep flowing far
    // past the acceptance budget. The old implementation handed
    // AbortSignal.timeout to the fetch, which governs the whole response —
    // killing every turn longer than the budget with "timeout of 90000ms".
    const enc = new TextEncoder();
    const response = await handleChatCompletions(
      {
        hooks: hooks([], []),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: async (_input, init) =>
          new Response(
            new ReadableStream<Uint8Array>({
              async start(c) {
                for (let i = 0; i < 6; i += 1) {
                  if (init.signal?.aborted) {
                    c.error(new Error('aborted by gateway'));
                    return;
                  }
                  c.enqueue(enc.encode(`data: {"choices":[{"delta":{"content":"t${i}"}}]}\n\n`));
                  await new Promise((resolve) => setTimeout(resolve, 25));
                }
                c.enqueue(enc.encode('data: [DONE]\n\n'));
                c.close();
              },
            }),
            { headers: { 'content-type': 'text/event-stream' } },
          ),
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({ model: 'm', messages: [], stream: true }),
      },
    );
    expect(response.status).toBe(200);
    const text = await response.text(); // total stream time ~150ms >> 30ms budget
    expect(text).toContain('t5');
    expect(text).toContain('[DONE]');
  });

  test('no gateway deadline exists: a dead provider ends only when the client aborts', async () => {
    // Removed 2026-08-24, the same day it was added — every gateway-side
    // timer here has eventually killed a legitimate long turn. The contract
    // is abort-forwarding instead: the client's abort must reach the
    // in-flight upstream call and end the dispatch (freeing the admission
    // lease), and a hang here would mean it does not.
    const client = new AbortController();
    const pending = handleChatCompletions(
      {
        hooks: hooks([], []),
        logger: { info() {}, warn() {}, error() {} },
        fetchImpl: (_input, init) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      },
      {
        authorization: 'Bearer token',
        rawBody: JSON.stringify({ model: 'm', messages: [], stream: true }),
        signal: client.signal,
      },
    );
    setTimeout(() => client.abort(new DOMException('client gave up', 'AbortError')), 30);
    const response = await Promise.race([
      pending,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('dispatch did not end after client abort')), 2_000),
      ),
    ]);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });
});
