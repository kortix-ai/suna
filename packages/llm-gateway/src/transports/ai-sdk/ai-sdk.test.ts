import { describe, expect, it, afterEach } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { jsonSchema, streamText, tool } from 'ai';
import { calculateCost, extractUsageFromSseBuffer } from '../../usage';
import { sseErrorFrame, sseHasContent } from '../../usage/completion-guard';
import type { UpstreamDescriptor } from '../../domain';
import { guardAgainstUnhandledResultRejections, mapToolCalls } from './index';
import {
  aiSdkFamilyFor,
  clampMaxOutputTokensForBedrock,
  isCodexDescriptor,
  needsResponsesApi,
  openRouterCostMetadataExtractor,
  resolveAiModel,
} from './model';
import { buildAiSdkArgs, toModelMessages } from './request';
import { mapUsage, openAiJsonFromResult, openAiSseFromFullStream } from './sse';

// A fullStream is just an async iterable of TextStreamPart-shaped objects — feed
// the adapter the exact parts streamText emits and assert the OpenAI SSE bytes.
async function* parts(...items: Array<Record<string, unknown>>) {
  for (const item of items) yield item as { type: string; [k: string]: unknown };
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) out += decoder.decode(value, { stream: true });
  }
  return out;
}

// Parse `data: {...}` frames (ignoring [DONE] + heartbeats) — the same view the
// gateway's probe/relay/usage-extraction take of the stream.
function frames(sse: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    out.push(JSON.parse(payload));
  }
  return out;
}

const usage = (over: Record<string, unknown> = {}) => ({
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  inputTokenDetails: { cacheReadTokens: 20 },
  outputTokenDetails: { reasoningTokens: 10 },
  ...over,
});

const CTX = { model: 'openai/gpt-5.6', provider: 'openai' };

describe('ai-sdk SSE adapter — /v1/llm contract fidelity', () => {
  it('streams text as OpenAI chat.completion.chunk deltas + usage + [DONE]', async () => {
    const sse = await readAll(
      openAiSseFromFullStream(
        parts(
          { type: 'text-delta', id: '1', text: 'Hello' },
          { type: 'text-delta', id: '1', text: ' world' },
          { type: 'finish', finishReason: 'stop', totalUsage: usage() },
        ),
        CTX,
      ),
    );

    expect(sse.endsWith('data: [DONE]\n\n')).toBe(true);
    expect(sseHasContent(sse)).toBe(true);

    const f = frames(sse);
    // First delta carries the assistant role.
    expect((f[0] as any).choices[0].delta.role).toBe('assistant');
    const text = f
      .map((c: any) => c.choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(text).toBe('Hello world');
    // Every chunk is a chat.completion.chunk on the right model.
    expect(f.every((c: any) => c.object === 'chat.completion.chunk' || c.usage)).toBe(true);
    // Terminal finish_reason then usage-only chunk.
    const finishChunk = f.find((c: any) => c.choices?.[0]?.finish_reason);
    expect((finishChunk as any).choices[0].finish_reason).toBe('stop');
    const usageChunk = f.find((c: any) => c.usage);
    expect((usageChunk as any).usage.prompt_tokens).toBe(100);
    expect((usageChunk as any).usage.completion_tokens).toBe(50);
    expect((usageChunk as any).usage.prompt_tokens_details.cached_tokens).toBe(20);
  });

  it('streams tool calls as incremental OpenAI tool_calls deltas', async () => {
    const sse = await readAll(
      openAiSseFromFullStream(
        parts(
          { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' },
          { type: 'tool-input-delta', id: 'call_1', delta: '{"city":' },
          { type: 'tool-input-delta', id: 'call_1', delta: '"Paris"}' },
          { type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: { city: 'Paris' } },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: usage() },
        ),
        CTX,
      ),
    );
    expect(sseHasContent(sse)).toBe(true);
    const f = frames(sse);
    const toolDeltas = f
      .flatMap((c: any) => c.choices?.[0]?.delta?.tool_calls ?? []);
    // One opening delta (index 0, id, name) + two argument deltas; the terminal
    // `tool-call` for the same id is NOT re-emitted (already streamed).
    expect(toolDeltas[0]).toMatchObject({
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '' },
    });
    const args = toolDeltas.map((t: any) => t.function?.arguments ?? '').join('');
    expect(args).toBe('{"city":"Paris"}');
    const finishChunk = f.find((c: any) => c.choices?.[0]?.finish_reason);
    expect((finishChunk as any).choices[0].finish_reason).toBe('tool_calls');
  });

  it('emits a full tool_call when the provider gives no input-start/delta', async () => {
    const sse = await readAll(
      openAiSseFromFullStream(
        parts(
          { type: 'tool-call', toolCallId: 'c2', toolName: 'search', input: { q: 'hi' } },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: usage() },
        ),
        CTX,
      ),
    );
    const tc = frames(sse).flatMap((c: any) => c.choices?.[0]?.delta?.tool_calls ?? [])[0];
    expect(tc).toMatchObject({
      index: 0,
      id: 'c2',
      function: { name: 'search', arguments: '{"q":"hi"}' },
    });
  });

  it('surfaces an upstream error as an OpenAI error frame the probe detects', async () => {
    const sse = await readAll(
      openAiSseFromFullStream(
        parts({ type: 'error', error: Object.assign(new Error('overloaded'), { statusCode: 529 }) }),
        CTX,
      ),
    );
    const frame = sseErrorFrame(sse);
    expect(frame?.message).toBe('overloaded');
    expect(frame?.code).toBe(529);
  });

  it('maps reasoning deltas to delta.reasoning (counts as content)', async () => {
    const sse = await readAll(
      openAiSseFromFullStream(
        parts(
          { type: 'reasoning-delta', id: 'r', text: 'thinking...' },
          { type: 'text-delta', id: '1', text: 'answer' },
          { type: 'finish', finishReason: 'stop', totalUsage: usage() },
        ),
        CTX,
      ),
    );
    expect(sseHasContent(sse)).toBe(true);
    const reasoning = frames(sse)
      .map((c: any) => c.choices?.[0]?.delta?.reasoning ?? '')
      .join('');
    expect(reasoning).toBe('thinking...');
  });
});

describe('ai-sdk billing parity vs native openai-compat', () => {
  // The native path forwards the provider's OpenAI-shaped usage verbatim; the
  // AI-SDK path maps LanguageModelUsage → the same shape. For any given token
  // counts, extract + cost must be identical on both engines.
  const pricing = { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 };

  it('extracts identical token counts + cost from both engines', async () => {
    // AI-SDK engine output.
    const aiSse = await readAll(
      openAiSseFromFullStream(
        parts(
          { type: 'text-delta', id: '1', text: 'hi' },
          { type: 'finish', finishReason: 'stop', totalUsage: usage({ inputTokens: 1000, outputTokens: 400, totalTokens: 1400, inputTokenDetails: { cacheReadTokens: 250 } }) },
        ),
        CTX,
      ),
    );
    // Equivalent native OpenAI SSE (what openai-compat forwards verbatim).
    const nativeSse =
      `data: ${JSON.stringify({ model: 'openai/gpt-5.6', choices: [{ delta: { content: 'hi' } }] })}\n\n` +
      `data: ${JSON.stringify({ model: 'openai/gpt-5.6', choices: [], usage: { prompt_tokens: 1000, completion_tokens: 400, total_tokens: 1400, prompt_tokens_details: { cached_tokens: 250 } } })}\n\n` +
      'data: [DONE]\n\n';

    const aiUsage = extractUsageFromSseBuffer(aiSse);
    const nativeUsage = extractUsageFromSseBuffer(nativeSse);
    expect(aiUsage).not.toBeNull();
    expect(aiUsage!.promptTokens).toBe(nativeUsage!.promptTokens);
    expect(aiUsage!.completionTokens).toBe(nativeUsage!.completionTokens);
    expect(aiUsage!.cachedTokens).toBe(nativeUsage!.cachedTokens);

    const counts = (u: any) => ({
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      cachedTokens: u.cachedTokens,
    });
    const aiCost = calculateCost('gpt', counts(aiUsage), 1.1, aiUsage!.upstreamCostHint, pricing);
    const nativeCost = calculateCost('gpt', counts(nativeUsage), 1.1, nativeUsage!.upstreamCostHint, pricing);
    expect(aiCost.upstreamCost).toBe(nativeCost.upstreamCost);
    expect(aiCost.finalCost).toBe(nativeCost.finalCost);
    expect(aiCost.upstreamCost).toBeGreaterThan(0);
  });
});

describe('ai-sdk request conversion', () => {
  it('resolves the provider family from npm then kind', () => {
    const d = (over: Partial<UpstreamDescriptor>): UpstreamDescriptor => ({
      provider: 'p', kind: 'openai-compat', baseUrl: '', apiKey: '', billingMode: 'none', markup: 0, ...over,
    });
    expect(aiSdkFamilyFor(d({ npm: '@ai-sdk/openai' }))).toBe('openai');
    expect(aiSdkFamilyFor(d({ npm: '@ai-sdk/anthropic' }))).toBe('anthropic');
    expect(aiSdkFamilyFor(d({ npm: '@ai-sdk/amazon-bedrock' }))).toBe('bedrock');
    // Fallback to kind when npm is absent/unknown.
    expect(aiSdkFamilyFor(d({ kind: 'anthropic' }))).toBe('anthropic');
    expect(aiSdkFamilyFor(d({ kind: 'bedrock' }))).toBe('bedrock');
    expect(aiSdkFamilyFor(d({ kind: 'openai-compat' }))).toBe('openai-compatible');
    expect(aiSdkFamilyFor(d({ npm: 'unknown', kind: 'custom' }))).toBe('openai-compatible');
  });

  it('hoists system, translates tool calls + tool results', () => {
    const { system, messages } = toModelMessages([
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'weather?' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'wx', arguments: '{"city":"Paris"}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'wx', content: 'sunny' },
    ]);
    expect(system).toBe('be brief');
    expect(messages[0]).toEqual({ role: 'user', content: 'weather?' });
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'wx', input: { city: 'Paris' } }],
    });
    expect(messages[2]).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'c1', output: { type: 'text', value: 'sunny' } }],
    });
  });

  it('translates image_url user parts', () => {
    const { messages } = toModelMessages([
      { role: 'user', content: [{ type: 'text', text: 'what is this' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] },
    ]);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ],
    });
  });

  it('defaults maxOutputTokens for anthropic/bedrock, maps reasoning_effort + tool_choice', () => {
    const anthropic = buildAiSdkArgs({ messages: [], reasoning_effort: 'high', tools: [{ function: { name: 't', parameters: {} } }], tool_choice: 'required' }, 'anthropic');
    expect(anthropic.maxOutputTokens).toBe(4096);
    expect(anthropic.toolChoice).toBe('required');
    expect(anthropic.tools).toBeTruthy();

    const openai = buildAiSdkArgs({ messages: [], reasoning_effort: 'high', max_tokens: 2000 }, 'openai');
    expect(openai.maxOutputTokens).toBe(2000);
    expect(openai.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
  });
});

describe('ai-sdk end-to-end via streamText + mock model', () => {
  it('drives streamText through a mock provider and emits valid OpenAI SSE', async () => {
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [ /* LanguageModelV4StreamPart[]; cast to skip union narrowing */
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '0' },
            { type: 'text-delta', id: '0', delta: 'Hi ' },
            { type: 'text-delta', id: '0', delta: 'there' },
            { type: 'text-end', id: '0' },
            {
              type: 'finish',
              finishReason: 'stop',
              // LanguageModelV4 provider-level usage shape (nested totals).
              usage: {
                inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 3, reasoning: 0 },
                totalTokens: 15,
              },
            },
          ] as any,
        }),
      }),
    });

    const result = streamText({ model: mock, prompt: 'hello', maxRetries: 0 });
    const sse = await readAll(openAiSseFromFullStream(result.fullStream, { model: 'mock/x', provider: 'mock' }));

    expect(sseHasContent(sse)).toBe(true);
    const text = frames(sse).map((c: any) => c.choices?.[0]?.delta?.content ?? '').join('');
    expect(text).toBe('Hi there');
    const u = extractUsageFromSseBuffer(sse);
    expect(u!.promptTokens).toBe(12);
    expect(u!.completionTokens).toBe(3);
  });
});

describe('ai-sdk non-streaming JSON adapter', () => {
  it('produces a chat.completion with tool_calls + usage jsonHasContent sees', () => {
    const json = openAiJsonFromResult(
      {
        text: '',
        toolCalls: [{ toolCallId: 'c1', toolName: 'wx', input: { city: 'Paris' } }],
        finishReason: 'tool-calls',
        usage: usage() as any,
      },
      CTX,
    ) as any;
    expect(json.object).toBe('chat.completion');
    expect(json.choices[0].finish_reason).toBe('tool_calls');
    expect(json.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'c1',
      function: { name: 'wx', arguments: '{"city":"Paris"}' },
    });
    expect(json.usage.prompt_tokens).toBe(100);
  });
});

// Defect 1 (2026-07-17): streaming's unconsumed streamText result promises
// (usage/text/finishReason/steps/...) crashing the whole Bun worker with an
// unhandled promise rejection on a mid-stream upstream error, dropping the
// connection as a bare 502 before sse.ts's clean error frame or any
// settle/logging path ever runs. `guardAgainstUnhandledResultRejections`
// (index.ts) is the fix: attach a no-op catch to every one of those promises
// right after `streamText()` returns.
describe('guardAgainstUnhandledResultRejections — defect 1 (streaming crash safety)', () => {
  const shapeOf = (usage: Promise<unknown>) => ({
    usage,
    text: Promise.resolve(''),
    finishReason: Promise.resolve('stop'),
    steps: Promise.resolve([]),
    toolCalls: Promise.resolve([]),
    finalStep: Promise.resolve({}),
    providerMetadata: Promise.resolve(undefined),
  });

  const unhandled: unknown[] = [];
  const onUnhandledRejection = (err: unknown) => unhandled.push(err);

  afterEach(() => {
    process.off('unhandledRejection', onUnhandledRejection);
    unhandled.length = 0;
  });

  // NOTE: bun:test intercepts the process's own `unhandledRejection` event to
  // fail whichever test is running when one fires — so a THIRD "and without
  // the guard it WOULD have crashed" test can't observe that counterfactual
  // from inside the same suite without failing itself (proven while writing
  // this file: bun's harness turned the deliberate unhandled rejection into a
  // hard test failure rather than routing it to a custom listener). The two
  // tests below instead verify the guard's actual, positive contract: applied
  // to a result shape, a later rejection on any of its promises is inert.

  it('with the guard applied, a later rejection is inert — no unhandled rejection reaches the process', async () => {
    let reject: (e: unknown) => void = () => {};
    const usagePromise = new Promise((_resolve, r) => {
      reject = r;
    });
    process.on('unhandledRejection', onUnhandledRejection);

    guardAgainstUnhandledResultRejections(shapeOf(usagePromise));
    reject(new Error('upstream boom'));
    await new Promise((r) => setTimeout(r, 20));

    expect(unhandled).toEqual([]);
  });

  it('drives a real streamText() through a mock model that errors mid-stream, guards it, and still gets a clean SSE error frame with no crash', async () => {
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: 'partial' });
            controller.error(Object.assign(new Error('upstream socket reset'), { statusCode: undefined }));
          },
        }),
      }),
    });

    process.on('unhandledRejection', onUnhandledRejection);

    const result = streamText({
      model: mock,
      prompt: 'hello',
      maxRetries: 0,
      onError: () => {
        /* mirrors index.ts's swallow — the real error surfaces via fullStream */
      },
    });
    guardAgainstUnhandledResultRejections(result);

    const sse = await readAll(openAiSseFromFullStream(result.fullStream, CTX));
    await new Promise((r) => setTimeout(r, 20));

    const frame = sseErrorFrame(sse);
    expect(frame?.message).toBe('upstream socket reset');
    expect(unhandled).toEqual([]);
  });
});

// Defect 2 (2026-07-17, live-confirmed against Nova Micro): Bedrock's
// Converse API hard-rejects any maxOutputTokens above the model's own
// ceiling ("The maximum tokens you requested exceeds the model limit of
// 10000...") instead of clamping it — a generic large client default then
// 400s/502s every call to a small Nova model, breaking a tool loop before it
// completes a single round trip.
describe('clampMaxOutputTokensForBedrock — defect 2 (Nova max-tokens ceiling)', () => {
  it('clamps an oversized request for a Nova model on the bedrock family', () => {
    expect(clampMaxOutputTokensForBedrock(32_000, 'bedrock', 'us.amazon.nova-micro-v1:0')).toBe(10_000);
    expect(clampMaxOutputTokensForBedrock(64_000, 'bedrock', 'amazon.nova-lite-v1:0')).toBe(10_000);
  });

  it('leaves an already-small request untouched', () => {
    expect(clampMaxOutputTokensForBedrock(4096, 'bedrock', 'us.amazon.nova-micro-v1:0')).toBe(4096);
  });

  it('never touches non-Nova bedrock models (e.g. Claude-on-Bedrock)', () => {
    expect(
      clampMaxOutputTokensForBedrock(64_000, 'bedrock', 'us.anthropic.claude-opus-4-8-v1:0'),
    ).toBe(64_000);
  });

  it('never touches non-bedrock families', () => {
    expect(clampMaxOutputTokensForBedrock(64_000, 'anthropic', 'claude-haiku-4-5')).toBe(64_000);
  });

  it('passes through undefined unchanged', () => {
    expect(clampMaxOutputTokensForBedrock(undefined, 'bedrock', 'us.amazon.nova-micro-v1:0')).toBeUndefined();
  });
});

// Defect 3 (2026-07-17, live-confirmed against OpenRouter): mapUsage emitted
// token-only usage, never cost — a managed OpenRouter model with no
// models.dev catalog price booked $0 even though OpenRouter's own
// `usage.cost` (returned only when the request carries `usage:
// {include:true}`, threaded via model.ts's openRouterCostMetadataExtractor)
// has the real upstream-billed figure.
describe('cost-hint threading — defect 3 (OpenRouter usage.cost parity)', () => {
  it('mapUsage folds a providerMetadata cost into the OpenAI-shaped usage.cost field', () => {
    const out = mapUsage(usage() as any, { openrouterCost: { cost: 0.00012 } });
    expect(out.cost).toBe(0.00012);
  });

  it('mapUsage omits cost entirely when no provider metadata carries one', () => {
    const out = mapUsage(usage() as any, undefined);
    expect(out.cost).toBeUndefined();
    const out2 = mapUsage(usage() as any, { openrouterCost: {} });
    expect(out2.cost).toBeUndefined();
  });

  it('a no-catalog-price model bills non-zero end-to-end via the SSE usage-chunk cost field', async () => {
    // No `pricingOverride` passed to calculateCost — mirrors a managed model
    // with no models.dev catalog entry, exactly the $0-booking bug.
    const sse = await readAll(
      openAiSseFromFullStream(
        parts(
          { type: 'text-delta', id: '1', text: 'hi' },
          {
            type: 'finish-step',
            usage: usage(),
            finishReason: 'stop',
            providerMetadata: { openrouterCost: { cost: 0.00042 } },
          },
          { type: 'finish', finishReason: 'stop', totalUsage: usage() },
        ),
        CTX,
      ),
    );
    const extracted = extractUsageFromSseBuffer(sse);
    expect(extracted).not.toBeNull();
    expect(extracted!.upstreamCostHint).toBe(0.00042);

    const cost = calculateCost('some/no-catalog-model', extracted!, 1.1, extracted!.upstreamCostHint);
    expect(cost.upstreamCost).toBe(0.00042);
    expect(cost.finalCost).toBeGreaterThan(0);
  });

  it('openRouterCostMetadataExtractor pulls usage.cost from both non-streaming and streaming shapes', async () => {
    const extractor = openRouterCostMetadataExtractor();
    const nonStreaming = await extractor.extractMetadata({
      parsedBody: { usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0009 } },
    });
    expect(nonStreaming).toEqual({ openrouterCost: { cost: 0.0009 } });

    const streamExtractor = extractor.createStreamExtractor();
    streamExtractor.processChunk({ choices: [{ delta: { content: 'hi' } }] });
    streamExtractor.processChunk({ usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0011 } });
    expect(streamExtractor.buildMetadata()).toEqual({ openrouterCost: { cost: 0.0011 } });
  });
});

// Piece A (2026-07-17): absorbs the OpenAI Responses API into the ai-sdk
// engine itself, so Codex + genuine-OpenAI reasoning-with-tools no longer
// need to fall through to the native openai-responses transport. The routing
// decision (needsResponsesApi) is the exact same predicate route-kind.ts's
// resolveTransportKind already uses for the native path — see route-kind.test.ts
// for the exhaustive truth table this reuses; the tests here focus on what's
// NEW: the AI SDK model that decision builds, and Codex's forced-streaming
// wrinkle (its backend 400s on `stream:false`, which is all `generateText`
// ever sends).
describe('Piece A — OpenAI Responses API absorbed into the ai-sdk engine', () => {
  const reasoningTool = {
    type: 'function',
    function: { name: 'get_weather', description: 'd', parameters: { type: 'object' } },
  };

  const genuineOpenAiReasoning: UpstreamDescriptor = {
    provider: 'openai',
    kind: 'openai-compat',
    baseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-test',
    billingMode: 'platform-fee',
    markup: 0.1,
    resolvedModel: 'gpt-5.6',
    reasoning: true,
    temperature: false,
    npm: '@ai-sdk/openai',
  };

  // Mirrors apps/api's descriptors.ts codexDescriptor shape (no `npm` field —
  // it's hand-built for the ChatGPT OAuth backend, never catalog-resolved).
  const codex: UpstreamDescriptor = {
    provider: 'openai-codex',
    kind: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKey: 'oat_test',
    billingMode: 'none',
    markup: 0,
    resolvedModel: 'gpt-5-codex',
    headers: { 'ChatGPT-Account-ID': 'acct_1' },
  };

  describe('needsResponsesApi — reused verbatim from resolveTransportKind', () => {
    it('is true for a genuine OpenAI reasoning model with function tools and a live effort', () => {
      expect(
        needsResponsesApi(
          { messages: [], tools: [reasoningTool], reasoning_effort: 'medium' },
          genuineOpenAiReasoning,
        ),
      ).toBe(true);
    });

    it('is false for the same descriptor with no tools (not the broken combination)', () => {
      expect(
        needsResponsesApi({ messages: [], reasoning_effort: 'medium' }, genuineOpenAiReasoning),
      ).toBe(false);
    });

    it("is false when reasoning_effort is explicitly 'none' (OpenAI's documented escape hatch)", () => {
      expect(
        needsResponsesApi(
          { messages: [], tools: [reasoningTool], reasoning_effort: 'none' },
          genuineOpenAiReasoning,
        ),
      ).toBe(false);
    });

    it('is true for a Codex descriptor no matter what the body contains', () => {
      expect(needsResponsesApi({}, codex)).toBe(true);
      expect(needsResponsesApi({ messages: [], stream: false }, codex)).toBe(true);
    });
  });

  it('aiSdkFamilyFor resolves a Codex descriptor to the openai family (Responses-capable), not generic openai-compatible', () => {
    expect(aiSdkFamilyFor(codex)).toBe('openai');
  });

  describe('resolveAiModel — .chat() vs .responses() selection', () => {
    // `LanguageModel` (the return type) is a union that also admits a bare
    // model-id string (a global-registry reference) — narrow to the object
    // shape resolveAiModel actually returns to read `.provider` off it.
    const providerOf = (model: ReturnType<typeof resolveAiModel>): string =>
      (model as { provider: string }).provider;

    it('builds a .responses() model for genuine OpenAI reasoning + tools + a live effort', () => {
      const model = resolveAiModel(genuineOpenAiReasoning, {
        messages: [],
        tools: [reasoningTool],
        reasoning_effort: 'medium',
      });
      expect(providerOf(model)).toBe('openai.responses');
    });

    it('keeps using .chat() for a plain non-reasoning-blocked openai request (no tools)', () => {
      const model = resolveAiModel(genuineOpenAiReasoning, { messages: [], reasoning_effort: 'medium' });
      expect(providerOf(model)).toBe('openai.chat');
    });

    it('keeps using .chat() when no body is passed at all (default {})', () => {
      expect(providerOf(resolveAiModel(genuineOpenAiReasoning))).toBe('openai.chat');
    });

    it('always builds a .responses() model for Codex, regardless of what the body says', () => {
      expect(providerOf(resolveAiModel(codex, { messages: [] }))).toBe('openai.responses');
      expect(providerOf(resolveAiModel(codex, { messages: [], stream: false }))).toBe('openai.responses');
    });
  });

  describe('buildAiSdkArgs — reasoning-effort mapping onto providerOptions.openai', () => {
    it('maps the nested reasoning.effort shape the same as the flat reasoning_effort field', () => {
      const args = buildAiSdkArgs({ messages: [], reasoning: { effort: 'high' } }, 'openai');
      expect(args.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
    });

    it("applies defaultReasoningEffort (Codex's 'low') only when the body carries none of its own", () => {
      const defaulted = buildAiSdkArgs({ messages: [] }, 'openai', { defaultReasoningEffort: 'low' });
      expect(defaulted.providerOptions).toEqual({ openai: { reasoningEffort: 'low' } });

      const explicitWins = buildAiSdkArgs(
        { messages: [], reasoning_effort: 'high' },
        'openai',
        { defaultReasoningEffort: 'low' },
      );
      expect(explicitWins.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });

      const noDefaultNoEffort = buildAiSdkArgs({ messages: [] }, 'openai');
      expect(noDefaultNoEffort.providerOptions).toBeUndefined();
    });
  });

  // Codex's backend is stream-only (`stream:false` 400s — see
  // openai-responses/request.ts's chatToResponses comment). The AI SDK's
  // non-streaming `doGenerate` always sends `stream:false`, so
  // callUpstreamViaAiSdk drives Codex through `streamText` (`doStream`, which
  // DOES force `stream:true` on the wire — see @ai-sdk/openai's
  // OpenAIResponsesLanguageModel) even for a client that asked for a
  // non-streaming completion, then collapses the settled result into one JSON
  // response. This exercises that exact sequence — streamText + guard +
  // Promise.all + mapToolCalls + openAiJsonFromResult — against a real
  // streamText() result (mock model, no network) instead of hand-rolling the
  // JSON shape, so a regression in how callUpstreamViaAiSdk assembles it would
  // very likely break this too.
  describe('Codex non-streaming client request over a stream-only upstream (collapse path)', () => {
    it('collapses a streamText() tool-call result into the same JSON shape generateText would produce', async () => {
      const mock = new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'tool-input-start', id: 'call_1', toolName: 'get_weather' },
              { type: 'tool-input-delta', id: 'call_1', delta: '{"city":"sf"}' },
              { type: 'tool-input-end', id: 'call_1' },
              {
                type: 'tool-call',
                toolCallId: 'call_1',
                toolName: 'get_weather',
                input: JSON.stringify({ city: 'sf' }),
              },
              {
                type: 'finish',
                // LanguageModelV4's finish reason is `{unified, raw}`, not a bare
                // string (see @ai-sdk/provider's LanguageModelV4FinishReason) —
                // a plain string here silently degrades to 'other'.
                finishReason: { unified: 'tool-calls', raw: undefined },
                usage: {
                  inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 6, reasoning: 0 },
                  totalTokens: 10,
                },
              },
            ] as any,
          }),
        }),
      });

      // The same tool the gateway builds via request.ts's `toToolSet` — no
      // `execute`, so the SDK surfaces the call and stops instead of running it.
      const result = streamText({
        model: mock,
        prompt: 'weather?',
        maxRetries: 0,
        tools: {
          get_weather: tool({
            description: 'd',
            inputSchema: jsonSchema({ type: 'object', properties: {} }),
          }),
        },
      });
      guardAgainstUnhandledResultRejections(result);

      const [text, reasoningText, toolCalls, finishReason, usage, providerMetadata] = await Promise.all([
        result.text,
        result.reasoningText,
        result.toolCalls,
        result.finishReason,
        result.usage,
        result.providerMetadata,
      ]);
      const json = openAiJsonFromResult(
        {
          text,
          reasoningText,
          toolCalls: mapToolCalls(toolCalls as any),
          finishReason,
          usage,
          providerMetadata,
        },
        { model: 'codex/gpt-5-codex', provider: 'openai-codex' },
      ) as any;

      expect(json.object).toBe('chat.completion');
      expect(json.choices[0].finish_reason).toBe('tool_calls');
      expect(json.choices[0].message.tool_calls[0]).toMatchObject({
        id: 'call_1',
        function: { name: 'get_weather', arguments: '{"city":"sf"}' },
      });
      expect(json.usage.prompt_tokens).toBe(4);
      expect(json.usage.completion_tokens).toBe(6);
    });

    it('collapses a plain-text streamText() result the same way, with no tool_calls key', async () => {
      const mock = new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: 'low-effort answer' },
              { type: 'text-end', id: '0' },
              {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
                  outputTokens: { total: 2, reasoning: 0 },
                  totalTokens: 5,
                },
              },
            ] as any,
          }),
        }),
      });

      const result = streamText({ model: mock, prompt: 'hi', maxRetries: 0 });
      guardAgainstUnhandledResultRejections(result);
      const [text, reasoningText, toolCalls, finishReason, usage, providerMetadata] = await Promise.all([
        result.text,
        result.reasoningText,
        result.toolCalls,
        result.finishReason,
        result.usage,
        result.providerMetadata,
      ]);
      const json = openAiJsonFromResult(
        { text, reasoningText, toolCalls: mapToolCalls(toolCalls as any), finishReason, usage, providerMetadata },
        { model: 'codex/gpt-5-codex', provider: 'openai-codex' },
      ) as any;

      expect(json.object).toBe('chat.completion');
      expect(json.choices[0].finish_reason).toBe('stop');
      expect(json.choices[0].message.content).toBe('low-effort answer');
      expect(json.choices[0].message.tool_calls).toBeUndefined();
    });
  });

  // Codex OAuth cannot be driven live in this environment (no OAuth creds
  // available here) — the routing (needsResponsesApi/resolveAiModel/
  // aiSdkFamilyFor above) and the forced-streaming collapse path (this
  // describe block) are covered by code path + unit test only, matching the
  // native openai-responses transport's own existing Codex test coverage
  // (openai-responses/request.test.ts, response.test.ts), which is unchanged
  // by this piece.
});
