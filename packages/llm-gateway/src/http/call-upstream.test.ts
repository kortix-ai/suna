import { describe, expect, test } from 'bun:test';

import type { UpstreamDescriptor } from '../domain';
import {
  CircuitOpenError,
  ClientAbortError,
  UpstreamHttpError,
  UpstreamMisconfiguredError,
  defaultIsRetryable,
  indicatesUpstreamDown,
} from '../errors';
import { CircuitBreaker } from '../resilience';
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
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: 'x',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  return { impl, seenHeaders };
}

// Note: the exact wire-level param translations (max_tokens ->
// max_completion_tokens for genuine OpenAI reasoning models, reasoning-
// restricted sampling-param stripping, Perplexity role-alternation, ...)
// used to be hand-rolled in the now-deleted native openai-compat transport
// and pinned here at the callUpstream level. The ai-sdk engine (the sole
// transport engine — see http/call-upstream.ts) delegates request
// serialization to the AI SDK provider packages themselves (@ai-sdk/openai,
// @ai-sdk/anthropic, @ai-sdk/amazon-bedrock, @ai-sdk/openai-compatible),
// which own those wire-format quirks internally; this package's own
// responsibility is normalizing the incoming OpenAI-chat body into the SDK's
// call options (see transports/ai-sdk/request.ts and its tests), not
// re-deriving the final wire bytes a third-party package already tests.

// A minimal but genuinely valid OpenAI chat.completion body — the ai-sdk
// engine's provider packages parse/validate the actual response shape (unlike
// the retired native transport, which passed a 2xx body through verbatim
// without looking at it), so every "successful call" fixture below needs a
// real `choices[].message` + `usage`, not a placeholder object.
function okChatCompletionBody(content = 'ok'): string {
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'x',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

// A minimal but genuinely non-empty chat body — `generateText`/`streamText`
// (the 'ai' package) validate the prompt CLIENT-SIDE and throw
// `InvalidPromptError` before ever dispatching a request when `messages`
// resolves to an empty array; the retired native transport had no such
// check and forwarded any body verbatim. Every call below that expects to
// actually reach the mocked upstream needs a real message.
function chatBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'x', messages: [{ role: 'user', content: 'hi' }], ...over };
}

describe('callUpstream', () => {
  test('retries a 503 then returns the ok response', async () => {
    const fetchMock = makeFetch([
      { status: 503, body: 'down' },
      { status: 200, body: okChatCompletionBody() },
    ]);
    const res = await callUpstream(chatBody(), descriptor, {
      retry: fastRetry,
      fetchImpl: fetchMock.impl,
    });
    expect(res.status).toBe(200);
    expect(fetchMock.getCalls()).toBe(2);
  });

  test('retries a thrown network error (provider down)', async () => {
    const fetchMock = makeFetch([
      { throw: 'ECONNREFUSED' },
      { status: 200, body: okChatCompletionBody() },
    ]);
    const res = await callUpstream(chatBody(), descriptor, {
      retry: fastRetry,
      fetchImpl: fetchMock.impl,
    });
    expect(res.status).toBe(200);
    expect(fetchMock.getCalls()).toBe(2);
  });

  test('does not retry a 400 and surfaces status + body', async () => {
    const fetchMock = makeFetch([{ status: 400, body: 'bad model' }]);
    try {
      await callUpstream(chatBody(), descriptor, { retry: fastRetry, fetchImpl: fetchMock.impl });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UpstreamHttpError);
      expect((err as UpstreamHttpError).status).toBe(400);
      expect((err as UpstreamHttpError).body).toContain('bad model');
    }
    expect(fetchMock.getCalls()).toBe(1);
  });

  test('opens the breaker and fails fast after repeated failures', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    const fetchMock = makeFetch([{ status: 500, body: 'boom' }]);
    const binding = { provider: descriptor.provider, breaker };

    await callUpstream(chatBody(), descriptor, {
      retry: { ...fastRetry, maxAttempts: 1 },
      fetchImpl: fetchMock.impl,
      binding,
    }).catch(() => {});
    expect(breaker.current).toBe('open');

    const callsBefore = fetchMock.getCalls();
    await expect(
      callUpstream(chatBody(), descriptor, {
        retry: fastRetry,
        fetchImpl: fetchMock.impl,
        binding,
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchMock.getCalls()).toBe(callsBefore);
  });

  test('threads requestId through to the upstream as a correlation header', async () => {
    const recording = makeRecordingFetch();
    await callUpstream(chatBody(), descriptor, {
      retry: fastRetry,
      fetchImpl: recording.impl,
      requestId: 'req_abc123',
    });
    expect(recording.seenHeaders[0]?.['x-kortix-request-id']).toBe('req_abc123');
  });

  test('omits the correlation header when no requestId is given', async () => {
    const recording = makeRecordingFetch();
    await callUpstream(chatBody(), descriptor, { retry: fastRetry, fetchImpl: recording.impl });
    expect(recording.seenHeaders[0]).not.toHaveProperty('x-kortix-request-id');
  });
});

// Captures the exact outgoing request (url/headers/body) instead of just
// counting calls, so routing/translation assertions can check the shape the
// ai-sdk engine actually put on the wire. Defaults to a genuinely valid
// chat.completion body (see `okChatCompletionBody`) — the ai-sdk engine
// parses/validates whatever the mock returns, so a placeholder object fails
// even when a test only cares about the REQUEST it captured.
function makeCapturingFetch(status = 200, body = okChatCompletionBody()) {
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

// Regression coverage for the "gpt-5.5/5.6 BYOK sessions fail with 'Function
// tools with reasoning_effort are not supported ... in /v1/chat/completions'"
// incident (essentia.kortix.cloud, session 21c6cfd0-5157-4e78-9d26-4198656b1a81):
// a genuine api.openai.com reasoning model + function tools + a live
// reasoning_effort must be dispatched over OpenAI's Responses API (the
// ai-sdk engine's `provider.responses()` model — see transports/ai-sdk/
// model.ts's `needsResponsesApi`), not chat/completions — see
// transports/route-kind.ts for the exact gating.
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
        object: 'response',
        status: 'completed',
        created_at: 1_700_000_000,
        model: 'gpt-5.5',
        output: [
          {
            type: 'message',
            id: 'msg_1',
            status: 'completed',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'sunny', annotations: [] }],
          },
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
    expect(body.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'weather in sf?' }] },
    ]);
    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'get weather',
        parameters: { type: 'object' },
      },
    ]);
    expect(body.reasoning).toMatchObject({ effort: 'medium' });

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

  test('streaming tool-call round trip: SSE Responses events translate into OpenAI tool_call chunks for a genuine BYOK descriptor', async () => {
    const encoder = new TextEncoder();
    const events = [
      {
        type: 'response.created',
        response: { id: 'resp_9', created_at: 1_700_000_000, model: 'gpt-5.5' },
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '',
        },
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 0,
        delta: '{"city":',
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_1',
        output_index: 0,
        delta: '"sf"}',
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'get_weather',
          arguments: '{"city":"sf"}',
          status: 'completed',
        },
      },
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
    // The finish_reason chunk isn't necessarily the LAST frame on the wire —
    // a trailing usage-only chunk (mirroring real OpenAI's
    // `stream_options:{include_usage:true}` behavior) can follow it, exactly
    // like it does for genuine chat/completions streams.
    const finishReasons = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean);
    expect(finishReasons).toEqual(['tool_calls']);
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
      return new Response(okChatCompletionBody(), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const ac = new AbortController();
    await callUpstream(chatBody(), descriptor, { retry: fastRetry, fetchImpl, signal: ac.signal });
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
      callUpstream(chatBody(), descriptor, { retry: fastRetry, fetchImpl, signal: ac.signal }),
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
      callUpstream(chatBody(), descriptor, { retry: fastRetry, fetchImpl, signal: ac.signal }),
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
    await callUpstream(chatBody(), descriptor, {
      retry: fastRetry,
      fetchImpl,
      signal: ac.signal,
      binding,
    }).catch(() => {});
    expect(breaker.current).toBe('closed');
  });
});

// Regression coverage for a defect class this codebase has repeatedly hit
// (2026-07-17): a BYOK call to a model NOT individually catalogued by
// models.dev (e.g. OpenRouter's dynamic/no-catalog-price auto-router,
// `openrouter/openrouter/fusion`) failing with a 502 whose message is a raw
// "Invalid URL" — the ai-sdk engine's `createOpenAICompatible({baseURL:
// baseURL || ''})` (transports/ai-sdk/model.ts) builds an unparseable request
// straight from an empty `descriptor.baseUrl`, deep inside a provider SDK/
// fetch call, with no clear diagnostic. Live re-verification against dev
// (both the in-process gateway and the standalone gateway pod, streaming and
// non-streaming) confirms apps/api's resolveCandidates — which resolves
// `baseUrl` from the PROVIDER (resolveCatalogUpstream, keyed by provider id,
// never by individual model — see provider-registry.ts) — already gets this
// right for a non-catalog BYOK model today (see apps/api's
// resolve-candidates.test.ts for the pinned regression). This suite guards
// the OTHER half: `callUpstream` itself must never let a descriptor with a
// missing/blank/unparseable baseUrl reach the transport at all — a fail-fast
// backstop against any FUTURE resolution regression (a different host's
// resolveUpstream hook, a new provider kind, ...) instead of surfacing as an
// opaque "Invalid URL" 502 (non-streaming) or — worse — a 200-status SSE
// stream carrying an in-band error frame that looks like success at the HTTP
// layer (streaming).
describe('callUpstream — descriptor with no usable baseUrl fails fast', () => {
  const noBaseUrlDescriptor: UpstreamDescriptor = {
    provider: 'openrouter',
    kind: 'openai-compat',
    npm: '@openrouter/ai-sdk-provider',
    baseUrl: '',
    apiKey: 'sk-test',
    billingMode: 'none',
    markup: 0,
    resolvedModel: 'openrouter/fusion',
  };

  test('an empty baseUrl throws UpstreamMisconfiguredError before any fetch', async () => {
    let fetchCalls = 0;
    const fetchImpl: FetchImpl = async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    };
    await expect(
      callUpstream(
        { model: 'openrouter/openrouter/fusion', messages: [], stream: false },
        noBaseUrlDescriptor,
        { retry: fastRetry, fetchImpl },
      ),
    ).rejects.toBeInstanceOf(UpstreamMisconfiguredError);
    // Never dispatched — the ai-sdk engine's own fetch (undici, not our
    // fetchImpl) would otherwise be the one to throw the opaque error deep
    // inside the SDK, since we never even reach `callUpstreamViaAiSdk`.
    expect(fetchCalls).toBe(0);
  });

  test('same fail-fast for a streaming request (never returns a 200 with an in-band error frame)', async () => {
    const fetchImpl: FetchImpl = async () => new Response('{}', { status: 200 });
    await expect(
      callUpstream(
        { model: 'openrouter/openrouter/fusion', messages: [], stream: true },
        noBaseUrlDescriptor,
        { retry: fastRetry, fetchImpl },
      ),
    ).rejects.toBeInstanceOf(UpstreamMisconfiguredError);
  });

  test('a whitespace-only baseUrl is treated the same as empty', async () => {
    await expect(
      callUpstream(
        { model: 'x' },
        { ...noBaseUrlDescriptor, baseUrl: '   ' },
        { retry: fastRetry, fetchImpl: async () => new Response('{}', { status: 200 }) },
      ),
    ).rejects.toBeInstanceOf(UpstreamMisconfiguredError);
  });

  test('an unparseable baseUrl is rejected with the same error, not a raw URL-parse crash', async () => {
    await expect(
      callUpstream(
        { model: 'x' },
        { ...noBaseUrlDescriptor, baseUrl: 'not-a-url' },
        { retry: fastRetry, fetchImpl: async () => new Response('{}', { status: 200 }) },
      ),
    ).rejects.toBeInstanceOf(UpstreamMisconfiguredError);
  });

  test('a non-http(s) scheme is rejected (defense against a future non-URL descriptor shape)', async () => {
    await expect(
      callUpstream(
        { model: 'x' },
        { ...noBaseUrlDescriptor, baseUrl: 'ftp://example.com' },
        { retry: fastRetry, fetchImpl: async () => new Response('{}', { status: 200 }) },
      ),
    ).rejects.toBeInstanceOf(UpstreamMisconfiguredError);
  });

  test('a valid baseUrl is unaffected (no false positives)', async () => {
    const res = await callUpstream(chatBody(), descriptor, {
      retry: fastRetry,
      fetchImpl: async () => new Response(okChatCompletionBody(), { status: 200 }),
    });
    expect(res.status).toBe(200);
  });

  test('never retried and never trips the shared circuit breaker for the provider', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000 });
    let fetchCalls = 0;
    const fetchImpl: FetchImpl = async () => {
      fetchCalls += 1;
      return new Response('{}', { status: 200 });
    };
    await callUpstream({ model: 'x' }, noBaseUrlDescriptor, {
      retry: fastRetry,
      fetchImpl,
      binding: { provider: noBaseUrlDescriptor.provider, breaker },
    }).catch(() => {});
    expect(fetchCalls).toBe(0);
    expect(breaker.current).toBe('closed');
  });

  test('classified as non-retryable and not upstream-down, unlike a genuine network error', () => {
    const err = new UpstreamMisconfiguredError('openrouter', 'missing baseUrl');
    expect(defaultIsRetryable(err)).toBe(false);
    expect(indicatesUpstreamDown(err)).toBe(false);
  });
});
