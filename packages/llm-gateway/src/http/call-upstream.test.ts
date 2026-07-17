import { describe, expect, test } from 'bun:test';

import type { UpstreamDescriptor } from '../domain';
import { CircuitOpenError, ClientAbortError, UpstreamHttpError } from '../errors';
import { CircuitBreaker } from '../resilience';
import { buildUpstreamRequest } from '../transports';
import { type FetchImpl, callUpstream } from './call-upstream';

const descriptor: UpstreamDescriptor = {
  provider: 'openrouter',
  kind: 'openai-compat',
  baseUrl: 'https://up.test/v1',
  apiKey: 'sk-test',
  billingMode: 'credits',
  markup: 1.2,
};

const fastRetry = { sleep: async () => {}, rand: () => 0.5, baseDelayMs: 1, maxAttempts: 3 };

type Step = { status: number; body?: string } | { throw: string };

function makeFetch(steps: Step[]) {
  let calls = 0;
  const impl: FetchImpl = async () => {
    const step = steps[Math.min(calls, steps.length - 1)];
    calls++;
    if ('throw' in step) throw new TypeError(step.throw);
    return new Response(step.body ?? '{}', {
      status: step.status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, getCalls: () => calls };
}

function makeRecordingFetch() {
  const seenHeaders: Record<string, string>[] = [];
  const impl: FetchImpl = async (_input, init) => {
    seenHeaders.push({ ...(init.headers as Record<string, string>) });
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, seenHeaders };
}

describe('buildUpstreamRequest', () => {
  test('targets /chat/completions with a bearer key', () => {
    const req = buildUpstreamRequest({ model: 'x' }, descriptor);
    expect(req.url).toBe('https://up.test/v1/chat/completions');
    expect(req.headers.authorization).toBe('Bearer sk-test');
  });
  test('trims a trailing slash on the base URL', () => {
    const req = buildUpstreamRequest({}, { ...descriptor, baseUrl: 'https://up.test/v1/' });
    expect(req.url).toBe('https://up.test/v1/chat/completions');
  });
});

describe('callUpstream', () => {
  // Pins the WIRE body for the exact shape the gateway playground endpoint
  // sends (apps/api/src/projects/routes/gateway.ts hardcodes `max_tokens: 512`
  // and calls this same callUpstream): for a genuine api.openai.com descriptor
  // the openai-compat transport must rename it to `max_completion_tokens`
  // (OpenAI's current chat models 400 on `max_tokens`), while every other
  // openai-compat upstream keeps `max_tokens` verbatim.
  test('sends max_completion_tokens on the wire to genuine OpenAI, max_tokens elsewhere', async () => {
    const bodies: string[] = [];
    const capturingFetch: FetchImpl = async (_input, init) => {
      bodies.push(String(init.body));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const playgroundRequest = {
      model: 'openai/gpt-5.5',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
      max_tokens: 512,
    };
    await callUpstream(
      playgroundRequest,
      {
        ...descriptor,
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        resolvedModel: 'gpt-5.5',
      },
      { retry: fastRetry, fetchImpl: capturingFetch },
    );
    await callUpstream(playgroundRequest, descriptor, {
      retry: fastRetry,
      fetchImpl: capturingFetch,
    });

    const toOpenAi = JSON.parse(bodies[0]!);
    expect(toOpenAi.max_completion_tokens).toBe(512);
    expect('max_tokens' in toOpenAi).toBe(false);

    const toOpenRouter = JSON.parse(bodies[1]!);
    expect(toOpenRouter.max_tokens).toBe(512);
    expect('max_completion_tokens' in toOpenRouter).toBe(false);
  });

  // P0 regression (req_mro97uigg6rnflvf): a real `openai/gpt-5.6-sol` BYOK
  // session 400ed on the wire with the max_tokens error even though the
  // resolved descriptor's baseUrl WAS genuinely api.openai.com — the fix
  // widens the openai-compat translation to key off `descriptor.provider ===
  // 'openai'` (set once in resolveCandidates.ts from the requested model id)
  // rather than the resolved host, so it survives ANY future routing shape
  // that resolves an `openai/`-labeled model to a non-`api.openai.com` host
  // (operator proxy, managed/Azure-fronted route, ...). End-to-end through
  // callUpstream (not just buildUpstreamRequest) to pin the real wire bytes.
  test('sends max_completion_tokens on the wire for an openai-labeled descriptor even when its baseUrl is NOT api.openai.com', async () => {
    const bodies: string[] = [];
    const capturingFetch: FetchImpl = async (_input, init) => {
      bodies.push(String(init.body));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await callUpstream(
      { model: 'openai/gpt-5.6-sol', messages: [{ role: 'user', content: 'hi' }], stream: false, max_tokens: 32000 },
      {
        ...descriptor,
        provider: 'openai',
        baseUrl: 'https://openrouter.ai/api/v1',
        resolvedModel: 'gpt-5.6-sol',
      },
      { retry: fastRetry, fetchImpl: capturingFetch },
    );

    const wire = JSON.parse(bodies[0]!);
    expect(wire.max_completion_tokens).toBe(32000);
    expect('max_tokens' in wire).toBe(false);
  });

  test('retries a 503 then returns the ok response', async () => {
    const fetchMock = makeFetch([
      { status: 503, body: 'down' },
      { status: 200, body: '{"ok":true}' },
    ]);
    const res = await callUpstream({ model: 'x' }, descriptor, {
      retry: fastRetry,
      fetchImpl: fetchMock.impl,
    });
    expect(res.status).toBe(200);
    expect(fetchMock.getCalls()).toBe(2);
  });

  test('retries a thrown network error (provider down)', async () => {
    const fetchMock = makeFetch([{ throw: 'ECONNREFUSED' }, { status: 200 }]);
    const res = await callUpstream({}, descriptor, { retry: fastRetry, fetchImpl: fetchMock.impl });
    expect(res.status).toBe(200);
    expect(fetchMock.getCalls()).toBe(2);
  });

  test('does not retry a 400 and surfaces status + body', async () => {
    const fetchMock = makeFetch([{ status: 400, body: 'bad model' }]);
    try {
      await callUpstream({}, descriptor, { retry: fastRetry, fetchImpl: fetchMock.impl });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamHttpError);
      expect((err as UpstreamHttpError).status).toBe(400);
      expect((err as UpstreamHttpError).body).toBe('bad model');
    }
    expect(fetchMock.getCalls()).toBe(1);
  });

  test('opens the breaker and fails fast after repeated failures', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    const fetchMock = makeFetch([{ status: 500, body: 'boom' }]);
    const binding = { provider: descriptor.provider, breaker };

    await callUpstream({}, descriptor, {
      retry: { ...fastRetry, maxAttempts: 1 },
      fetchImpl: fetchMock.impl,
      binding,
    }).catch(() => {});
    expect(breaker.current).toBe('open');

    const callsBefore = fetchMock.getCalls();
    await expect(
      callUpstream({}, descriptor, { retry: fastRetry, fetchImpl: fetchMock.impl, binding }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchMock.getCalls()).toBe(callsBefore);
  });

  test('threads requestId through to the upstream as a correlation header', async () => {
    const recording = makeRecordingFetch();
    await callUpstream({ model: 'x' }, descriptor, {
      retry: fastRetry,
      fetchImpl: recording.impl,
      requestId: 'req_abc123',
    });
    expect(recording.seenHeaders[0]?.['x-kortix-request-id']).toBe('req_abc123');
  });

  test('omits the correlation header when no requestId is given', async () => {
    const recording = makeRecordingFetch();
    await callUpstream({ model: 'x' }, descriptor, { retry: fastRetry, fetchImpl: recording.impl });
    expect(recording.seenHeaders[0]).not.toHaveProperty('x-kortix-request-id');
  });
});

// Captures the exact outgoing request (url/headers/body) instead of just
// counting calls, so sidecar-mode assertions can check the rewritten shape.
function makeCapturingFetch(status = 200, body = '{"ok":true}') {
  const requests: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const impl: FetchImpl = async (url, init) => {
    requests.push({
      url,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
  };
  return { impl, requests };
}

describe('callUpstream — translation sidecar mode', () => {
  test('unset translationSidecar: dispatches directly to the upstream, unchanged', async () => {
    const capture = makeCapturingFetch();
    await callUpstream({ model: 'x', messages: [] }, descriptor, { fetchImpl: capture.impl });
    expect(capture.requests).toHaveLength(1);
    expect(capture.requests[0].url).toBe('https://up.test/v1/chat/completions');
    expect(capture.requests[0].headers.authorization).toBe('Bearer sk-test');
    expect(capture.requests[0].body).not.toHaveProperty('api_key');
    expect(capture.requests[0].body).not.toHaveProperty('api_base');
  });

  test('translationSidecar set + eligible kind: routes to the sidecar with per-request key/base/model', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      { model: 'x', messages: [], max_tokens: 512 },
      { ...descriptor, resolvedModel: 'grok-4.3' },
      {
        fetchImpl: capture.impl,
        translationSidecar: { url: 'http://litellm.internal:4000', authToken: 'sk-sidecar-master' },
      },
    );
    expect(capture.requests).toHaveLength(1);
    const req = capture.requests[0];
    expect(req.url).toBe('http://litellm.internal:4000/v1/chat/completions');
    // The sidecar's OWN auth, never the resolved upstream key.
    expect(req.headers.authorization).toBe('Bearer sk-sidecar-master');
    expect(req.body).toMatchObject({
      model: 'grok-4.3',
      max_tokens: 512,
      api_key: 'sk-test',
      api_base: 'https://up.test/v1',
    });
  });

  test('translationSidecar set but kind is anthropic/bedrock: stays on the direct path', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      { model: 'x' },
      { ...descriptor, kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
      { fetchImpl: capture.impl, translationSidecar: { url: 'http://litellm.internal:4000' } },
    );
    expect(capture.requests[0].url).not.toContain('litellm.internal');
  });

  test('translationSidecar set but descriptor omits auth (public upstream): stays on the direct path', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      { model: 'x' },
      { ...descriptor, apiKey: '', omitAuthorization: true },
      { fetchImpl: capture.impl, translationSidecar: { url: 'http://litellm.internal:4000' } },
    );
    expect(capture.requests[0].url).toBe('https://up.test/v1/chat/completions');
  });

  // COEXISTENCE with the direct-path quirk translations that live inside
  // buildUpstreamRequest (openai-compat/index.ts): the max_tokens ->
  // max_completion_tokens hotfix (#4805) AND the reasoning-restricted
  // sampling-param strip + Perplexity role normalization (#4814). callUpstream
  // runs transport.buildRequest() UNCONDITIONALLY and only THEN rewrites into
  // the sidecar shape, so every one of those direct-path fixes still fires
  // even with the sidecar on. LiteLLM's own equivalent quirk tables would
  // handle the same cases, so this is harmless overlap (our translation is
  // idempotent / already-clean by the time LiteLLM sees it), never a
  // double-translation or a bypass — and it's exactly what keeps a box correct
  // the moment it flips the flag on without also upgrading LiteLLM, and keeps
  // #4814's fixes intact when the flag is off (the no-sidecar fallback).
  test('genuine OpenAI + sidecar enabled: the max_tokens hotfix still fires ahead of the sidecar rewrite', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      { model: 'x', messages: [], max_tokens: 4096 },
      {
        ...descriptor,
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        resolvedModel: 'gpt-5.6-sol',
      },
      { fetchImpl: capture.impl, translationSidecar: { url: 'http://litellm.internal:4000' } },
    );
    expect(capture.requests[0].body).toMatchObject({ max_completion_tokens: 4096 });
    expect(capture.requests[0].body).not.toHaveProperty('max_tokens');
  });

  test('genuine OpenAI reasoning model + sidecar enabled: #4814 reasoning-restricted sampling-param strip still fires ahead of the sidecar rewrite', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      { model: 'x', messages: [], temperature: 0.7, top_p: 0.9, presence_penalty: 1 },
      {
        ...descriptor,
        provider: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        resolvedModel: 'gpt-5.6-sol',
        temperature: false,
      },
      { fetchImpl: capture.impl, translationSidecar: { url: 'http://litellm.internal:4000' } },
    );
    const body = capture.requests[0].body as Record<string, unknown>;
    expect('temperature' in body).toBe(false);
    expect('top_p' in body).toBe(false);
    expect('presence_penalty' in body).toBe(false);
  });

  test('Perplexity + sidecar enabled: #4814 role-alternation normalization still fires ahead of the sidecar rewrite', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      {
        model: 'x',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'user', content: 'b' },
        ],
      },
      { ...descriptor, provider: 'perplexity', baseUrl: 'https://api.perplexity.ai' },
      { fetchImpl: capture.impl, translationSidecar: { url: 'http://litellm.internal:4000' } },
    );
    const body = capture.requests[0].body as { messages: unknown[] };
    // The two consecutive user turns were merged into one before the sidecar
    // rewrite ever saw them.
    expect(body.messages).toHaveLength(1);
  });

  test('sidecar auth token is optional (no master key configured)', async () => {
    const capture = makeCapturingFetch();
    await callUpstream({ model: 'x' }, descriptor, {
      fetchImpl: capture.impl,
      translationSidecar: { url: 'http://litellm.internal:4000' },
    });
    expect(capture.requests[0].headers.authorization).toBeUndefined();
  });
});

// Regression coverage for the "gpt-5.5/5.6 BYOK sessions fail with 'Function
// tools with reasoning_effort are not supported ... in /v1/chat/completions'"
// incident (essentia.kortix.cloud, session 21c6cfd0-5157-4e78-9d26-4198656b1a81):
// a genuine api.openai.com reasoning model + function tools + a live
// reasoning_effort must be dispatched over the Responses API
// (packages/llm-gateway/src/transports/openai-responses), not chat/completions —
// see transports/route-kind.ts for the exact gating.
describe('callUpstream — genuine OpenAI reasoning model auto-routes to /v1/responses', () => {
  const byokReasoningDescriptor: UpstreamDescriptor = {
    provider: 'openai',
    kind: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-byok-test',
    billingMode: 'platform-fee',
    markup: 0.1,
    resolvedModel: 'gpt-5.5',
    reasoning: true,
    temperature: false,
  };

  const weatherTool = {
    type: 'function',
    function: { name: 'get_weather', description: 'get weather', parameters: { type: 'object' } },
  };

  test('the exact failing shape (tools + reasoning_effort) targets /responses with a translated payload', async () => {
    const capture = makeCapturingFetch(
      200,
      JSON.stringify({
        id: 'resp_1',
        model: 'gpt-5.5',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'sunny' }] },
        ],
        usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25 },
      }),
    );
    const res = await callUpstream(
      {
        model: 'openai/gpt-5.5',
        messages: [{ role: 'user', content: 'weather in sf?' }],
        tools: [weatherTool],
        reasoning_effort: 'medium',
        stream: false,
      },
      byokReasoningDescriptor,
      { fetchImpl: capture.impl, retry: fastRetry },
    );

    expect(capture.requests).toHaveLength(1);
    const req = capture.requests[0];
    expect(req.url).toBe('https://api.openai.com/v1/responses');
    expect(req.headers.authorization).toBe('Bearer sk-byok-test');
    const body = req.body as Record<string, unknown>;
    expect(body.model).toBe('gpt-5.5');
    expect(body.input).toEqual([{ role: 'user', content: 'weather in sf?' }]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'get weather',
        parameters: { type: 'object' },
      },
    ]);
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(body.stream).toBe(false);

    // The response comes back translated into an OpenAI chat.completion shape,
    // not the raw Responses API envelope.
    const chat = await res.json();
    expect(chat.object).toBe('chat.completion');
    expect(chat.choices[0].message.content).toBe('sunny');
  });

  test('reasoning_effort explicitly "none": stays on chat/completions (OpenAI\'s own documented escape hatch)', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      {
        model: 'openai/gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [weatherTool],
        reasoning_effort: 'none',
      },
      byokReasoningDescriptor,
      { fetchImpl: capture.impl, retry: fastRetry },
    );
    expect(capture.requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
  });

  test('no tools: a plain reasoning-model turn is untouched, still chat/completions', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      {
        model: 'openai/gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'medium',
      },
      byokReasoningDescriptor,
      { fetchImpl: capture.impl, retry: fastRetry },
    );
    expect(capture.requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
  });

  test('non-reasoning genuine-OpenAI model (capability flag false): tools + reasoning_effort still chat/completions (no regression)', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      {
        model: 'openai/gpt-4.1',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [weatherTool],
        reasoning_effort: 'medium',
      },
      { ...byokReasoningDescriptor, resolvedModel: 'gpt-4.1', reasoning: false },
      { fetchImpl: capture.impl, retry: fastRetry },
    );
    expect(capture.requests[0].url).toBe('https://api.openai.com/v1/chat/completions');
  });

  test('a reasoning-flagged model on a different openai-compat host (OpenRouter) is not rerouted', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      {
        model: 'kortix/o3',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [weatherTool],
        reasoning_effort: 'medium',
      },
      {
        ...byokReasoningDescriptor,
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
      },
      { fetchImpl: capture.impl, retry: fastRetry },
    );
    expect(capture.requests[0].url).toBe('https://openrouter.ai/api/v1/chat/completions');
  });

  test('the translation sidecar is bypassed for the rerouted request — dispatches directly to api.openai.com/v1/responses', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      {
        model: 'openai/gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [weatherTool],
        reasoning_effort: 'medium',
      },
      byokReasoningDescriptor,
      {
        fetchImpl: capture.impl,
        retry: fastRetry,
        translationSidecar: { url: 'http://litellm.internal:4000', authToken: 'sk-sidecar-master' },
      },
    );
    expect(capture.requests[0].url).toBe('https://api.openai.com/v1/responses');
    expect(capture.requests[0].body).not.toHaveProperty('api_key');
    expect(capture.requests[0].body).not.toHaveProperty('api_base');
  });

  test('a non-rerouted request for the SAME reasoning model (no tools) still uses the sidecar when enabled', async () => {
    const capture = makeCapturingFetch();
    await callUpstream(
      {
        model: 'openai/gpt-5.5',
        messages: [{ role: 'user', content: 'hi' }],
        reasoning_effort: 'medium',
      },
      byokReasoningDescriptor,
      {
        fetchImpl: capture.impl,
        retry: fastRetry,
        translationSidecar: { url: 'http://litellm.internal:4000' },
      },
    );
    expect(capture.requests[0].url).toBe('http://litellm.internal:4000/v1/chat/completions');
    expect(capture.requests[0].body).toMatchObject({
      api_key: 'sk-byok-test',
      api_base: 'https://api.openai.com/v1',
    });
  });

  test('streaming tool-call round trip: SSE Responses events translate into OpenAI tool_call chunks for a genuine BYOK descriptor', async () => {
    const encoder = new TextEncoder();
    const events = [
      { type: 'response.created', response: { id: 'resp_9', model: 'gpt-5.5' } },
      {
        type: 'response.output_item.added',
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' },
      },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"sf"}' },
      {
        type: 'response.completed',
        response: {
          model: 'gpt-5.5',
          usage: { input_tokens: 12, output_tokens: 8, total_tokens: 20 },
        },
      },
    ];
    const fetchImpl: FetchImpl = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of events) {
            controller.enqueue(
              encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
            );
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };

    const res = await callUpstream(
      {
        model: 'openai/gpt-5.5',
        messages: [{ role: 'user', content: 'weather in sf?' }],
        tools: [weatherTool],
        reasoning_effort: 'medium',
        stream: true,
      },
      byokReasoningDescriptor,
      { fetchImpl, retry: fastRetry },
    );

    const text = await res.text();
    const chunks = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter((p) => p && p !== '[DONE]')
      .map((p) => JSON.parse(p));

    const args = chunks
      .flatMap((c) => c.choices?.[0]?.delta?.tool_calls ?? [])
      .map(
        (tc: Record<string, unknown>) =>
          (tc.function as Record<string, unknown> | undefined)?.arguments ?? '',
      )
      .join('');
    expect(args).toBe('{"city":"sf"}');
    expect(chunks.at(-1).choices[0].finish_reason).toBe('tool_calls');
  });
});

// Regression coverage for the client-disconnect finding: an inbound abort
// signal must reach the actual `fetch()` call (so a real upstream fetch is
// cancelled, not just logically ignored), and must never be retried or trip
// the shared provider circuit breaker — there's no one left to serve either
// way, so failing over would only waste more upstream spend for nothing.
describe('callUpstream client abort propagation', () => {
  test('an inbound signal is combined into the actual fetch call and aborts it', async () => {
    let receivedSignal: AbortSignal | undefined;
    const fetchImpl: FetchImpl = async (_url, init) => {
      receivedSignal = init.signal as AbortSignal;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const ac = new AbortController();
    await callUpstream({}, descriptor, { retry: fastRetry, fetchImpl, signal: ac.signal });
    expect(receivedSignal).toBeTruthy();
    expect(receivedSignal!.aborted).toBe(false);
    ac.abort();
    expect(receivedSignal!.aborted).toBe(true);
  });

  test('an already-aborted inbound signal fails fast as ClientAbortError, never reaching fetch', async () => {
    let fetchCalls = 0;
    const fetchImpl: FetchImpl = async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    };
    const ac = new AbortController();
    ac.abort();
    await expect(
      callUpstream({}, descriptor, { retry: fastRetry, fetchImpl, signal: ac.signal }),
    ).rejects.toBeInstanceOf(ClientAbortError);
    expect(fetchCalls).toBe(0);
  });

  test('a client abort mid-fetch is never retried (unlike a genuine network failure)', async () => {
    let calls = 0;
    const ac = new AbortController();
    const fetchImpl: FetchImpl = async () => {
      calls += 1;
      ac.abort();
      throw new DOMException('The operation was aborted', 'AbortError');
    };
    await expect(
      callUpstream({}, descriptor, { retry: fastRetry, fetchImpl, signal: ac.signal }),
    ).rejects.toBeInstanceOf(ClientAbortError);
    expect(calls).toBe(1); // no retry attempts spent on a caller that's already gone
  });

  test('a client abort never trips the shared provider circuit breaker', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    const binding = { provider: descriptor.provider, breaker };
    const ac = new AbortController();
    const fetchImpl: FetchImpl = async () => {
      ac.abort();
      throw new DOMException('The operation was aborted', 'AbortError');
    };
    await callUpstream({}, descriptor, {
      retry: fastRetry,
      fetchImpl,
      signal: ac.signal,
      binding,
    }).catch(() => {});
    expect(breaker.current).toBe('closed');
  });
});
