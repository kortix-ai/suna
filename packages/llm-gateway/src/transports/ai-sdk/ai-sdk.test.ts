import { afterEach, describe, expect, it } from 'bun:test';
import type { CatalogModel } from '@kortix/llm-catalog';
import { generateText, jsonSchema, streamText, tool } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { UpstreamDescriptor } from '../../domain';
import { NetworkError, UpstreamHttpError, defaultIsRetryable } from '../../errors';
import { calculateCost, extractUsageFromSseBuffer } from '../../usage';
import { sseErrorFrame, sseHasContent } from '../../usage/completion-guard';
import { guardAgainstUnhandledResultRejections, mapToolCalls, toTransportError } from './index';
import {
  aiSdkFamilyFor,
  clampMaxOutputTokensForBedrock,
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
    const text = f.map((c: any) => c.choices?.[0]?.delta?.content ?? '').join('');
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
          {
            type: 'tool-call',
            toolCallId: 'call_1',
            toolName: 'get_weather',
            input: { city: 'Paris' },
          },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: usage() },
        ),
        CTX,
      ),
    );
    expect(sseHasContent(sse)).toBe(true);
    const f = frames(sse);
    const toolDeltas = f.flatMap((c: any) => c.choices?.[0]?.delta?.tool_calls ?? []);
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
        parts({
          type: 'error',
          error: Object.assign(new Error('overloaded'), { statusCode: 529 }),
        }),
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
          {
            type: 'finish',
            finishReason: 'stop',
            totalUsage: usage({
              inputTokens: 1000,
              outputTokens: 400,
              totalTokens: 1400,
              inputTokenDetails: { cacheReadTokens: 250 },
            }),
          },
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
    const nativeCost = calculateCost(
      'gpt',
      counts(nativeUsage),
      1.1,
      nativeUsage!.upstreamCostHint,
      pricing,
    );
    expect(aiCost.upstreamCost).toBe(nativeCost.upstreamCost);
    expect(aiCost.finalCost).toBe(nativeCost.finalCost);
    expect(aiCost.upstreamCost).toBeGreaterThan(0);
  });
});

describe('ai-sdk request conversion', () => {
  it('resolves the provider family from npm then kind', () => {
    const d = (over: Partial<UpstreamDescriptor>): UpstreamDescriptor => ({
      provider: 'p',
      kind: 'openai-compat',
      baseUrl: '',
      apiKey: '',
      billingMode: 'none',
      markup: 0,
      ...over,
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
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'wx', arguments: '{"city":"Paris"}' } }],
      },
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
      content: [
        { type: 'tool-result', toolCallId: 'c1', output: { type: 'text', value: 'sunny' } },
      ],
    });
  });

  it('translates image_url user parts', () => {
    const { messages } = toModelMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        { type: 'image', image: 'data:image/png;base64,AAAA' },
      ],
    });
  });

  it('defaults maxOutputTokens for anthropic/bedrock (non-thinking), maps reasoning_effort + tool_choice', () => {
    // No reasoning_effort/thinking here — plain 4096 default, no thinking bump.
    const anthropic = buildAiSdkArgs(
      {
        messages: [],
        tools: [{ function: { name: 't', parameters: {} } }],
        tool_choice: 'required',
      },
      'anthropic',
    );
    expect(anthropic.maxOutputTokens).toBe(4096);
    expect(anthropic.toolChoice).toBe('required');
    expect(anthropic.tools).toBeTruthy();

    const openai = buildAiSdkArgs(
      { messages: [], reasoning_effort: 'high', max_tokens: 2000 },
      'openai',
    );
    expect(openai.maxOutputTokens).toBe(2000);
    expect(openai.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
  });
});

// buildAiSdkArgs is now models.dev-capability-driven: when the caller passes
// the resolved CatalogModel (index.ts resolves it via @kortix/llm-catalog's
// `catalogModelForWireModel`), the four generation params are clamped ONCE in
// normalizeRequest through the CANONICAL `clampGenerationConfig` — the exact
// same gate the host runs on route defaults, now also applied to the
// client-supplied values that path never touched. With NO model the clamp is a
// deliberate NO-OP (permissive parity), which is why every test above still
// passes a body with no model and sees pre-gating behavior verbatim.
describe('ai-sdk per-request capability gating (reuses @kortix/llm-catalog clampGenerationConfig)', () => {
  // Fixtures use only capability shapes that derive identically in every
  // catalog version (an explicit `effort` reasoning_options entry, a literal
  // `temperature` flag, an explicit `limit.output`) — never a bare
  // `reasoning:true`-with-no-options, whose effort-control synthesis is a
  // catalog-internal heuristic, not the contract under test here.
  const effortModel = (over: Partial<CatalogModel> = {}): CatalogModel => ({
    id: 'test-model',
    name: 'Test Model',
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    temperature: true,
    limit: { output: 8000 },
    ...over,
  });

  it('(a) drops a client temperature (and top_p) for a temperature:false model, keeps them for a capable one', () => {
    const fixed = buildAiSdkArgs({ messages: [], temperature: 0.7, top_p: 0.9 }, 'openai', {
      model: effortModel({ temperature: false }),
    });
    expect(fixed.temperature).toBeUndefined();
    expect(fixed.topP).toBeUndefined();

    const tunable = buildAiSdkArgs({ messages: [], temperature: 0.7, top_p: 0.9 }, 'openai', {
      model: effortModel({ temperature: true }),
    });
    expect(tunable.temperature).toBe(0.7);
    expect(tunable.topP).toBe(0.9);
  });

  it('(b) drops a reasoning_effort the model does not publish, keeps a published one, and clamps max_tokens to limit.output', () => {
    // 'xhigh' is NOT in the model's effort values → dropped, so no reasoningEffort
    // reaches providerOptions at all (providerOptions ends up empty → undefined).
    const rejected = buildAiSdkArgs(
      { messages: [], reasoning_effort: 'xhigh', max_tokens: 100000 },
      'openai',
      { model: effortModel() },
    );
    expect(rejected.providerOptions).toBeUndefined();
    // max_tokens clamped down to the model's real output ceiling.
    expect(rejected.maxOutputTokens).toBe(8000);

    // A published tier survives verbatim.
    const accepted = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'openai', {
      model: effortModel(),
    });
    expect(accepted.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
  });

  it('(c) a non-reasoning model suppresses thinking/reasoningEffort entirely (anthropic family)', () => {
    // reasoning:false + no reasoning_options → the effort tier is dropped, so
    // resolveThinkingRequest never turns extended thinking on and maxOutputTokens
    // falls back to the plain (non-thinking) 4096 default, not the thinking bump.
    const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'anthropic', {
      model: effortModel({ reasoning: false, reasoning_options: undefined }),
    });
    expect(args.providerOptions).toBeUndefined();
    expect(args.maxOutputTokens).toBe(4096);
  });

  it('(d) parity: with NO model passed, gating is a no-op — output matches the pre-gating result exactly', () => {
    const body = { messages: [], temperature: 1.5, top_p: 0.2, reasoning_effort: 'xhigh' };
    const ungated = buildAiSdkArgs({ ...body }, 'openai');
    // Every capability-relevant field passes through untouched — no model, no gate.
    expect(ungated.temperature).toBe(1.5);
    expect(ungated.topP).toBe(0.2);
    // 'xhigh' would be dropped by a temperature:true/effort-limited model above,
    // but with no model it survives verbatim — the exact permissive parity contract.
    expect(ungated.providerOptions).toEqual({ openai: { reasoningEffort: 'xhigh' } });
  });
});

// Regression coverage for the PR #4943 review finding: the deleted native
// anthropic/bedrock transports translated reasoning_effort/raw `thinking`
// into real Anthropic extended thinking and applied prompt-cache
// breakpoints; the ai-sdk engine had neither. See request.ts's
// `resolveThinkingRequest` / `applyAnthropicPromptCaching` for the
// ported implementation and the exact @ai-sdk/anthropic +
// @ai-sdk/amazon-bedrock field names it's built against.
describe('ai-sdk anthropic/bedrock extended thinking (ported from native)', () => {
  it('anthropic: reasoning_effort maps to adaptive thinking + effort (never enabled/budgetTokens) and bumps maxOutputTokens', () => {
    const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'anthropic');
    expect(args.providerOptions).toMatchObject({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'high' },
    });
    // The legacy enabled/budgetTokens shape must NEVER be sent — current-gen
    // Claude (Opus 4.5+/4.8) 400s on `thinking.type:"enabled"`.
    expect((args.providerOptions as any)?.anthropic?.thinking?.type).not.toBe('enabled');
    expect((args.providerOptions as any)?.anthropic?.thinking?.budgetTokens).toBeUndefined();
    // The bogus flat key from the generic (openai-shaped) path must never appear.
    expect((args.providerOptions as any)?.anthropic?.reasoningEffort).toBeUndefined();
    // No explicit max_tokens + thinking active → bumped to the thinking default,
    // not the plain 4096 non-thinking default, so there's headroom for thinking.
    expect(args.maxOutputTokens).toBe(32000);
  });

  it('anthropic: every reasoning_effort level maps to an adaptive effort tier (minimal folds to low)', () => {
    const table: Record<string, string> = {
      minimal: 'low', // Anthropic's effort enum has no 'minimal' tier
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: 'xhigh',
      max: 'max',
    };
    for (const [effort, expected] of Object.entries(table)) {
      const args = buildAiSdkArgs({ messages: [], reasoning_effort: effort }, 'anthropic');
      expect((args.providerOptions as any)?.anthropic).toMatchObject({
        thinking: { type: 'adaptive' },
        effort: expected,
      });
    }
  });

  it('anthropic: adaptive thinking carries no token budget, so a small explicit max_tokens is honored without a clamp', () => {
    const args = buildAiSdkArgs(
      { messages: [], reasoning_effort: 'max', max_tokens: 2000 },
      'anthropic',
    );
    expect(args.maxOutputTokens).toBe(2000);
    expect((args.providerOptions as any)?.anthropic).toMatchObject({
      thinking: { type: 'adaptive' },
      effort: 'max',
    });
    // No budgetTokens to clamp — adaptive lets the model manage its own budget.
    expect((args.providerOptions as any)?.anthropic?.thinking?.budgetTokens).toBeUndefined();
  });

  it('anthropic: a raw Anthropic-shaped body.thinking budget maps onto an adaptive effort tier', () => {
    const args = buildAiSdkArgs(
      { messages: [], thinking: { type: 'enabled', budget_tokens: 5000 } },
      'anthropic',
    );
    // 5000 tokens → the 'medium' tier (<= 8192), emitted as adaptive + effort —
    // never the raw enabled/budgetTokens shape current-gen Claude rejects.
    expect(args.providerOptions).toMatchObject({
      anthropic: { thinking: { type: 'adaptive' }, effort: 'medium' },
    });
    expect((args.providerOptions as any)?.anthropic?.thinking?.type).not.toBe('enabled');
    expect(args.maxOutputTokens).toBe(32000);
  });

  it('anthropic: an explicit body.thinking:{type:"disabled"} does not fall through to reasoning_effort', () => {
    const args = buildAiSdkArgs(
      { messages: [], thinking: { type: 'disabled' }, reasoning_effort: 'high' },
      'anthropic',
    );
    expect((args.providerOptions as any)?.anthropic?.thinking).toBeUndefined();
    // Non-thinking default, not the thinking-bumped one.
    expect(args.maxOutputTokens).toBe(4096);
  });

  it('bedrock: reasoning_effort maps to providerOptions.bedrock.reasoningConfig, never providerOptions.anthropic', () => {
    const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'medium' }, 'bedrock');
    expect(args.providerOptions).toMatchObject({
      bedrock: { reasoningConfig: { type: 'enabled', budgetTokens: 8192 } },
    });
    expect(args.providerOptions).not.toHaveProperty('anthropic');
    expect((args.providerOptions as any)?.bedrock?.reasoningEffort).toBeUndefined();
    expect(args.maxOutputTokens).toBe(32000);
  });

  it('bedrock: clamps budgetTokens below an explicit small max_tokens (Converse rejects budget >= max)', () => {
    const args = buildAiSdkArgs(
      { messages: [], reasoning_effort: 'max', max_tokens: 2000 },
      'bedrock',
    );
    expect(args.maxOutputTokens).toBe(2000);
    // max(1024, 2000-1024) = 1024 < the max-effort 32000 budget → clamped to 1024.
    expect((args.providerOptions as any)?.bedrock?.reasoningConfig).toEqual({
      type: 'enabled',
      budgetTokens: 1024,
    });
  });

  it('does not set thinking/reasoningConfig or bump maxOutputTokens for openai/openai-compatible families', () => {
    const openai = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'openai');
    expect(openai.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
    expect(openai.maxOutputTokens).toBeUndefined();

    const openrouter = buildAiSdkArgs(
      { messages: [], reasoning_effort: 'high' },
      'openai-compatible',
      { providerName: 'openrouter' },
    );
    expect(openrouter.providerOptions).toEqual({ openrouter: { reasoningEffort: 'high' } });
    expect(openrouter.maxOutputTokens).toBeUndefined();
  });
});

describe('ai-sdk anthropic/bedrock prompt caching (ported from native)', () => {
  it('anthropic: attaches cacheControl to the system prompt, the last tool, and the last message', () => {
    const args = buildAiSdkArgs(
      {
        messages: [
          { role: 'system', content: 'be brief' },
          { role: 'user', content: 'first' },
          { role: 'user', content: 'last' },
        ],
        tools: [
          { function: { name: 'first_tool', parameters: {} } },
          { function: { name: 'last_tool', parameters: {} } },
        ],
      },
      'anthropic',
    );

    expect(args.system).toEqual({
      role: 'system',
      content: 'be brief',
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });

    const toolNames = Object.keys(args.tools ?? {});
    expect(toolNames).toEqual(['first_tool', 'last_tool']);
    expect((args.tools as any)?.first_tool?.providerOptions).toBeUndefined();
    expect((args.tools as any)?.last_tool?.providerOptions).toEqual({
      anthropic: { cacheControl: { type: 'ephemeral' } },
    });

    expect(args.messages[0]).not.toHaveProperty('providerOptions');
    expect(args.messages[args.messages.length - 1]).toMatchObject({
      providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
    });
  });

  it('bedrock: attaches cachePoint (not cacheControl) to the system prompt and the last message; tools are untouched', () => {
    // @ai-sdk/amazon-bedrock talks AWS's Converse API, whose cache primitive
    // is a `cachePoint` content block — NOT Anthropic's `cacheControl` — and
    // its tool-config builder never reads a function tool's providerOptions
    // at all (verified against node_modules/@ai-sdk/amazon-bedrock/dist/index.js).
    const args = buildAiSdkArgs(
      {
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ function: { name: 'only_tool', parameters: {} } }],
      },
      'bedrock',
    );

    expect(args.system).toBeUndefined();
    expect((args.tools as any)?.only_tool?.providerOptions).toBeUndefined();
    expect(args.messages[0]).toMatchObject({
      providerOptions: { bedrock: { cachePoint: { type: 'default' } } },
    });

    const withSystem = buildAiSdkArgs(
      {
        messages: [
          { role: 'system', content: 'ctx' },
          { role: 'user', content: 'hi' },
        ],
      },
      'bedrock',
    );
    expect(withSystem.system).toEqual({
      role: 'system',
      content: 'ctx',
      providerOptions: { bedrock: { cachePoint: { type: 'default' } } },
    });
  });

  it('never attaches cacheControl/cachePoint providerOptions for openai/openai-compatible families', () => {
    const openai = buildAiSdkArgs(
      {
        messages: [
          { role: 'system', content: 'ctx' },
          { role: 'user', content: 'hi' },
        ],
        tools: [{ function: { name: 't', parameters: {} } }],
      },
      'openai',
    );
    expect(openai.system).toBe('ctx');
    expect(openai.messages[openai.messages.length - 1]).not.toHaveProperty('providerOptions');
    expect((openai.tools as any)?.t?.providerOptions).toBeUndefined();
  });
});

describe('ai-sdk end-to-end via streamText + mock model', () => {
  it('drives streamText through a mock provider and emits valid OpenAI SSE', async () => {
    const mock = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            /* LanguageModelV4StreamPart[]; cast to skip union narrowing */
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
    const sse = await readAll(
      openAiSseFromFullStream(result.fullStream, { model: 'mock/x', provider: 'mock' }),
    );

    expect(sseHasContent(sse)).toBe(true);
    const text = frames(sse)
      .map((c: any) => c.choices?.[0]?.delta?.content ?? '')
      .join('');
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
            controller.error(
              Object.assign(new Error('upstream socket reset'), { statusCode: undefined }),
            );
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
    expect(clampMaxOutputTokensForBedrock(32_000, 'bedrock', 'us.amazon.nova-micro-v1:0')).toBe(
      10_000,
    );
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
    expect(
      clampMaxOutputTokensForBedrock(undefined, 'bedrock', 'us.amazon.nova-micro-v1:0'),
    ).toBeUndefined();
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

    const cost = calculateCost(
      'some/no-catalog-model',
      extracted!,
      1.1,
      extracted!.upstreamCostHint,
    );
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
    streamExtractor.processChunk({
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0011 },
    });
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
      const model = resolveAiModel(genuineOpenAiReasoning, {
        messages: [],
        reasoning_effort: 'medium',
      });
      expect(providerOf(model)).toBe('openai.chat');
    });

    it('keeps using .chat() when no body is passed at all (default {})', () => {
      expect(providerOf(resolveAiModel(genuineOpenAiReasoning))).toBe('openai.chat');
    });

    it('always builds a .responses() model for Codex, regardless of what the body says', () => {
      expect(providerOf(resolveAiModel(codex, { messages: [] }))).toBe('openai.responses');
      expect(providerOf(resolveAiModel(codex, { messages: [], stream: false }))).toBe(
        'openai.responses',
      );
    });
  });

  describe('buildAiSdkArgs — reasoning-effort mapping onto providerOptions.openai', () => {
    it('maps the nested reasoning.effort shape the same as the flat reasoning_effort field', () => {
      const args = buildAiSdkArgs({ messages: [], reasoning: { effort: 'high' } }, 'openai');
      expect(args.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
    });

    it("applies defaultReasoningEffort (Codex's 'low') only when the body carries none of its own", () => {
      const defaulted = buildAiSdkArgs({ messages: [] }, 'openai', {
        defaultReasoningEffort: 'low',
      });
      expect(defaulted.providerOptions).toEqual({ openai: { reasoningEffort: 'low' } });

      const explicitWins = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'openai', {
        defaultReasoningEffort: 'low',
      });
      expect(explicitWins.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });

      const noDefaultNoEffort = buildAiSdkArgs({ messages: [] }, 'openai');
      expect(noDefaultNoEffort.providerOptions).toBeUndefined();
    });
  });

  // REGRESSION (prod, 2026-07-20): every codex/* model 400'd with a bare
  // `"Bad Request"` SSE frame. The deleted native transport set `store:false`
  // unconditionally for Codex (openai-responses/request.ts:156); #4943 made
  // ai-sdk the sole engine and never ported that line, so `store` went
  // undefined → dropped from the wire body → the ChatGPT backend rejected it.
  // Omitted and `false` are DIFFERENT requests to that backend.
  describe('buildAiSdkArgs — Codex requires an explicit store:false', () => {
    it('sets store:false for the openai-codex provider', () => {
      const args = buildAiSdkArgs({ messages: [] }, 'openai', {
        providerName: 'openai-codex',
      });
      expect(args.providerOptions?.openai).toMatchObject({ store: false });
    });

    it('keeps store:false alongside the reasoning effort Codex always sends', () => {
      const args = buildAiSdkArgs({ messages: [] }, 'openai', {
        providerName: 'openai-codex',
        defaultReasoningEffort: 'low',
      });
      expect(args.providerOptions).toEqual({ openai: { reasoningEffort: 'low', store: false } });
    });

    it('does NOT set store for plain OpenAI — the platform API defaults it itself', () => {
      const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'openai', {
        providerName: 'openai',
      });
      expect(args.providerOptions?.openai).not.toHaveProperty('store');
    });

    it('does not set store when no provider name is passed at all', () => {
      const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'openai');
      expect(args.providerOptions?.openai).not.toHaveProperty('store');
    });

    // Deliberately UNCONDITIONAL, matching the native transport it replaces:
    // `store` is not in extraOpenAiFields' allowlist, so a client-supplied
    // `store` never reaches providerOptions in the first place, and Codex is
    // the one backend where the wrong value fails the entire request. If a
    // future change starts forwarding client `store`, this test fails and the
    // Codex override must be re-examined rather than silently overridden.
    it('forces store:false for Codex even when the client body sets store:true', () => {
      const args = buildAiSdkArgs({ messages: [], store: true }, 'openai', {
        providerName: 'openai-codex',
      });
      expect(args.providerOptions?.openai).toMatchObject({ store: false });
    });
  });

  // REGRESSION (prod, 2026-07-20): every REAL Codex turn 400'd with
  // `{"detail":"Unsupported parameter: max_output_tokens"}` (captured via the
  // error-detail path). @ai-sdk/openai serializes maxOutputTokens →
  // max_output_tokens, which the ChatGPT backend rejects. Simple probes with no
  // cap passed, masking it. Drop the cap for Codex; keep it for plain OpenAI.
  describe('buildAiSdkArgs — Codex must NOT send max_output_tokens', () => {
    it('drops an explicit max_tokens for openai-codex', () => {
      const args = buildAiSdkArgs({ messages: [], max_tokens: 1024 }, 'openai', {
        providerName: 'openai-codex',
      });
      expect(args.maxOutputTokens).toBeUndefined();
    });

    it('drops max_completion_tokens for openai-codex too', () => {
      const args = buildAiSdkArgs({ messages: [], max_completion_tokens: 2048 }, 'openai', {
        providerName: 'openai-codex',
      });
      expect(args.maxOutputTokens).toBeUndefined();
    });

    it('STILL forwards max_tokens for plain OpenAI (the platform API accepts it)', () => {
      const args = buildAiSdkArgs({ messages: [], max_tokens: 1024 }, 'openai', {
        providerName: 'openai',
      });
      expect(args.maxOutputTokens).toBe(1024);
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

      const [text, reasoningText, toolCalls, finishReason, usage, providerMetadata] =
        await Promise.all([
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
      const [text, reasoningText, toolCalls, finishReason, usage, providerMetadata] =
        await Promise.all([
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

// Defect 4 (2026-07-17, live-confirmed): an invalid upstream key was retried
// 11+ times over 2+ minutes and the session turn stayed permanently empty —
// no clean error was ever surfaced. Root cause: toTransportError only ever
// inspected `.statusCode`; provider errors that never populate one (an AWS
// credential/SigV4 resolution failure thrown before any HTTP response exists,
// or an AI-SDK error class without `.statusCode`) fell through to a generic
// NetworkError, which `defaultIsRetryable` treats as retryable — so a dead
// credential got retried instead of failing fast. Fixed by classifying a
// statusCode-less error's MESSAGE via `looksLikeTerminalAuthFailure` (errors.ts)
// as a terminal 401 UpstreamHttpError.
describe('toTransportError — terminal auth classification (defect 4: 401 retried into a hang)', () => {
  it('maps a clean statusCode straight through as an UpstreamHttpError with that status', () => {
    const err = Object.assign(new Error('Incorrect API key provided'), {
      statusCode: 401,
      responseBody: '{"error":{"code":"invalid_api_key"}}',
    });
    const mapped = toTransportError(err, 'openai');
    expect(mapped).toBeInstanceOf(UpstreamHttpError);
    expect((mapped as UpstreamHttpError).status).toBe(401);
    expect(defaultIsRetryable(mapped)).toBe(false);
  });

  it('reads a statusCode nested under `.cause` when the top-level error lacks one', () => {
    const err = Object.assign(new Error('wrapped'), { cause: { statusCode: 403 } });
    const mapped = toTransportError(err, 'anthropic');
    expect(mapped).toBeInstanceOf(UpstreamHttpError);
    expect((mapped as UpstreamHttpError).status).toBe(403);
  });

  it('classifies a statusCode-less AWS credential failure as a terminal 401, not a retryable NetworkError', () => {
    const err = new Error(
      'UnrecognizedClientException: The security token included in the request is invalid',
    );
    const mapped = toTransportError(err, 'bedrock');
    expect(mapped).toBeInstanceOf(UpstreamHttpError);
    expect((mapped as UpstreamHttpError).status).toBe(401);
    expect(defaultIsRetryable(mapped)).toBe(false);
  });

  it('still falls back to a retryable NetworkError for a genuine statusCode-less transient failure', () => {
    const err = new Error('socket hang up');
    const mapped = toTransportError(err, 'openai');
    expect(mapped).toBeInstanceOf(NetworkError);
    expect(defaultIsRetryable(mapped)).toBe(true);
  });

  it('a 500-shaped error still maps to a retryable UpstreamHttpError (contrast with the 401 case above)', () => {
    const err = Object.assign(new Error('internal error'), { statusCode: 500 });
    const mapped = toTransportError(err, 'openai');
    expect(mapped).toBeInstanceOf(UpstreamHttpError);
    expect(defaultIsRetryable(mapped)).toBe(true);
  });
});

describe('ai-sdk streaming error frame — defect 4 (401 surfaces cleanly, no hang)', () => {
  it('a statusCode-carrying auth error surfaces its real code in the SSE error frame', async () => {
    const sse = await readAll(
      openAiSseFromFullStream(
        parts({
          type: 'error',
          error: Object.assign(new Error('Incorrect API key provided'), { statusCode: 401 }),
        }),
        CTX,
      ),
    );
    const frame = sseErrorFrame(sse);
    expect(frame?.message).toBe('Incorrect API key provided');
    expect(frame?.code).toBe(401);
    // No content was ever produced — a same-candidate empty-completion retry
    // would otherwise be indistinguishable from this terminal failure.
    expect(sseHasContent(sse)).toBe(false);
  });

  it('a statusCode-less terminal auth error message is still classified as a 401 error frame', async () => {
    const sse = await readAll(
      openAiSseFromFullStream(
        parts({
          type: 'error',
          error: new Error('AccessDeniedException: not authorized to invoke model'),
        }),
        CTX,
      ),
    );
    const frame = sseErrorFrame(sse);
    expect(frame?.code).toBe(401);
  });

  it('drives a real streamText() through a mock model whose doStream rejects with a 401 — exactly one call, one clean error frame, no retry storm', async () => {
    let calls = 0;
    const mock = new MockLanguageModelV4({
      doStream: async () => {
        calls++;
        throw Object.assign(new Error('Incorrect API key provided'), {
          statusCode: 401,
          responseBody: '{"error":{"code":"invalid_api_key"}}',
        });
      },
    });

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
    const frame = sseErrorFrame(sse);
    expect(frame?.code).toBe(401);
    expect(sseHasContent(sse)).toBe(false);
    // The mock model's doStream is called once by streamText itself — the
    // gateway's own resilience layer (withResilience wrapping
    // callUpstreamViaAiSdk) never gets a chance to retry a streaming call in
    // the first place, since it resolves as soon as the SSE Response is built
    // (see index.ts's callUpstreamViaAiSdk); the terminal classification that
    // matters for streaming lives in the pipeline's probeStream/errorFrame
    // handling, verified above. This still confirms doStream itself is
    // invoked exactly once, not retried internally.
    expect(calls).toBe(1);
  });
});

// Piece B (2026-07-17): AI-SDK ⇄ native request PARITY AUDIT + fix.
//
// CONFIRMED DEFECT: buildAiSdkArgs never read `body.response_format` at all
// — JSON mode / structured output was silently dropped on the ai-sdk
// engine (plain prose back instead of JSON) even though native
// (openai-compat) forwards the whole body, response_format included,
// verbatim to the upstream. Fixed in request.ts by
// responseFormatFromBody + buildResponseFormatOutput, threaded through as
// streamText/generateText's `output` param (the ONLY hook that drives
// LanguageModelV4CallOptions.responseFormat — see request.ts's big comment
// on buildResponseFormatOutput, which cites the exact ai/dist/index.js call
// sites where `output.responseFormat` is awaited).
describe('Piece B — response_format parity (CONFIRMED DEFECT fix)', () => {
  it('maps response_format:{type:"json_object"} to a plain JSON output (no schema) for the openai family', async () => {
    const args = buildAiSdkArgs(
      { messages: [], response_format: { type: 'json_object' } },
      'openai',
    );
    expect(args.output).toBeDefined();
    await expect(args.output!.responseFormat).resolves.toEqual({ type: 'json' });
  });

  it('maps response_format:{type:"json_schema",...} to a JSON output carrying the schema/name/description verbatim', async () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const args = buildAiSdkArgs(
      {
        messages: [],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'thing', description: 'd', schema },
        },
      },
      'openai',
    );
    await expect(args.output!.responseFormat).resolves.toEqual({
      type: 'json',
      schema,
      name: 'thing',
      description: 'd',
    });
  });

  it('maps response_format for the openai-compatible family too (OpenRouter etc.) — native forwards it there identically', async () => {
    const args = buildAiSdkArgs(
      { messages: [], response_format: { type: 'json_object' } },
      'openai-compatible',
      { providerName: 'openrouter' },
    );
    await expect(args.output!.responseFormat).resolves.toEqual({ type: 'json' });
  });

  it('honors an explicit strict:true from the client via providerOptions.openai.strictJsonSchema', () => {
    const args = buildAiSdkArgs(
      {
        messages: [],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'x', schema: {}, strict: true },
        },
      },
      'openai',
    );
    expect(args.providerOptions).toMatchObject({ openai: { strictJsonSchema: true } });
  });

  // @ai-sdk/openai and @ai-sdk/openai-compatible both default
  // strictJsonSchema to `true` (OpenAI's Structured Outputs mode) when the
  // key is absent from providerOptions — but native forwards the client's
  // body verbatim, so an omitted `strict` field reaches OpenAI as OpenAI's
  // OWN default for chat/completions json_schema mode (`false`), not the AI
  // SDK provider package's default. Only an EXPLICIT `strict:true` may ever
  // escalate this — see the previous test.
  it("defaults strictJsonSchema to false when the client omits strict (native's implicit behavior), NOT the AI-SDK package's own default of true", () => {
    const args = buildAiSdkArgs(
      {
        messages: [],
        response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } },
      },
      'openai',
    );
    expect(args.providerOptions).toMatchObject({ openai: { strictJsonSchema: false } });
  });

  it('drops response_format for anthropic/bedrock — matches native, whose anthropic/request.ts (shared by bedrock) never reads body.response_format either', () => {
    const anthropic = buildAiSdkArgs(
      { messages: [], response_format: { type: 'json_object' } },
      'anthropic',
    );
    expect(anthropic.output).toBeUndefined();
    const bedrock = buildAiSdkArgs(
      { messages: [], response_format: { type: 'json_object' } },
      'bedrock',
    );
    expect(bedrock.output).toBeUndefined();
  });

  it('ignores an unrecognized/empty response_format (no output built, no throw)', () => {
    expect(buildAiSdkArgs({ messages: [], response_format: {} }, 'openai').output).toBeUndefined();
    expect(buildAiSdkArgs({ messages: [] }, 'openai').output).toBeUndefined();
  });
});

// Live-observed regression this whole piece exists to fix: a
// response_format:{type:'json_object'} request got plain prose back on the
// ai-sdk engine. These two tests drive the EXACT sequence
// callUpstreamViaAiSdk runs (buildAiSdkArgs → generateText with the built
// `output`) against a mock model that records what LanguageModelV4CallOptions
// it actually received — proving the fix reaches the wire-level call, not
// just buildAiSdkArgs's own return value.
describe('response_format end-to-end — the built model call actually receives the structured-output arg', () => {
  const usage = {
    inputTokens: { total: 5, noCache: 5, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
    totalTokens: 10,
  };

  it('a json_object request reaches doGenerate as responseFormat:{type:"json"} (no schema) and the model text is valid JSON', async () => {
    let seenResponseFormat: unknown;
    const mock = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seenResponseFormat = options.responseFormat;
        return {
          content: [{ type: 'text', text: '{"ok":true}' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: [],
        };
      },
    });

    const args = buildAiSdkArgs(
      {
        messages: [{ role: 'user', content: 'give me json' }],
        response_format: { type: 'json_object' },
      },
      'openai',
    );
    const result = await generateText({
      model: mock,
      system: args.system,
      messages: args.messages,
      output: args.output,
      maxRetries: 0,
    });

    expect(seenResponseFormat).toEqual({ type: 'json' });
    expect(result.text).toBe('{"ok":true}');
    expect(() => JSON.parse(result.text)).not.toThrow();
  });

  it('a json_schema request reaches doGenerate carrying the schema verbatim', async () => {
    let seenResponseFormat: unknown;
    const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };
    const mock = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seenResponseFormat = options.responseFormat;
        return {
          content: [{ type: 'text', text: '{"name":"kortix"}' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: [],
        };
      },
    });

    const args = buildAiSdkArgs(
      {
        messages: [{ role: 'user', content: 'x' }],
        response_format: { type: 'json_schema', json_schema: { name: 'person', schema } },
      },
      'openai',
    );
    await generateText({
      model: mock,
      system: args.system,
      messages: args.messages,
      output: args.output,
      providerOptions: args.providerOptions,
      maxRetries: 0,
    });

    expect(seenResponseFormat).toEqual({
      type: 'json',
      schema,
      name: 'person',
      description: undefined,
    });
  });
});

describe('buildAiSdkArgs — sampling/penalty parity (seed, stop, frequency/presence penalty)', () => {
  it('maps seed, frequency_penalty, presence_penalty to CallSettings top-level fields', () => {
    const args = buildAiSdkArgs(
      { messages: [], seed: 42, frequency_penalty: 0.4, presence_penalty: -0.2 },
      'openai',
    );
    expect(args.seed).toBe(42);
    expect(args.frequencyPenalty).toBe(0.4);
    expect(args.presencePenalty).toBe(-0.2);
  });

  it('maps a single stop string and an array of stop sequences the same way native does', () => {
    expect(buildAiSdkArgs({ messages: [], stop: 'STOP' }, 'openai').stopSequences).toEqual([
      'STOP',
    ]);
    expect(buildAiSdkArgs({ messages: [], stop: ['A', 'B'] }, 'openai').stopSequences).toEqual([
      'A',
      'B',
    ]);
  });

  it('leaves seed/penalties undefined when absent from the body (never invents a value)', () => {
    const args = buildAiSdkArgs({ messages: [] }, 'openai');
    expect(args.seed).toBeUndefined();
    expect(args.frequencyPenalty).toBeUndefined();
    expect(args.presencePenalty).toBeUndefined();
  });
});

describe('buildAiSdkArgs — extra OpenAI-only fields via providerOptions (logit_bias, logprobs, parallel_tool_calls, user, service_tier, metadata, prediction)', () => {
  const body = {
    messages: [],
    logit_bias: { '123': -100 },
    logprobs: true,
    top_logprobs: 3,
    parallel_tool_calls: false,
    user: 'user-1',
    service_tier: 'flex',
    metadata: { k: 'v' },
    prediction: { type: 'content', content: 'hi' },
  };

  it("maps to camelCase keys under providerOptions.openai for the openai family (matches @ai-sdk/openai's own schema)", () => {
    const args = buildAiSdkArgs(body, 'openai');
    expect(args.providerOptions).toEqual({
      openai: {
        logitBias: { '123': -100 },
        // top_logprobs count wins over the bare `logprobs:true` boolean —
        // @ai-sdk/openai encodes both OpenAI wire fields as one option.
        logprobs: 3,
        parallelToolCalls: false,
        user: 'user-1',
        serviceTier: 'flex',
        metadata: { k: 'v' },
        prediction: { type: 'content', content: 'hi' },
      },
    });
  });

  it('maps to raw wire (snake_case) keys under providerOptions[<configured provider name>] for openai-compatible, since that package spreads any key outside its own small schema verbatim onto the wire request', () => {
    const args = buildAiSdkArgs(body, 'openai-compatible', { providerName: 'openrouter' });
    expect(args.providerOptions).toEqual({
      openrouter: {
        logit_bias: { '123': -100 },
        logprobs: true,
        top_logprobs: 3,
        parallel_tool_calls: false,
        user: 'user-1',
        service_tier: 'flex',
        metadata: { k: 'v' },
        prediction: { type: 'content', content: 'hi' },
      },
    });
  });

  it('never maps these OpenAI-only fields for anthropic/bedrock — matches native, which has no equivalent for either transport', () => {
    expect(buildAiSdkArgs(body, 'anthropic').providerOptions).toBeUndefined();
    expect(buildAiSdkArgs(body, 'bedrock').providerOptions).toBeUndefined();
  });

  it('omits every key that the body did not set (no false/0/empty invented values)', () => {
    const args = buildAiSdkArgs({ messages: [] }, 'openai');
    expect(args.providerOptions).toBeUndefined();
  });
});

// Defect 5 (2026-07-17, found auditing this parity piece): buildAiSdkArgs
// previously keyed reasoning_effort's providerOptions entry as
// `providerOptions.openai` for EVERY family including 'openai-compatible' —
// but @ai-sdk/openai-compatible's chat model never reads a bare 'openai'
// key back out (its `providerOptionsName` getter resolves to whatever
// `name` model.ts passed to `createOpenAICompatible`, i.e.
// `descriptor.provider`, e.g. 'openrouter' — confirmed by reading
// @ai-sdk/openai-compatible's chat-language-model.js getArgs, which parses
// only `providerOptions['openai-compatible']`, `['openaiCompatible']`,
// `[this.providerOptionsName]`, and the camelCase of the last one — never a
// literal `'openai'`). reasoning_effort was therefore silently dropped for
// every OpenRouter-class request that set one — undetected because the only
// prior reasoning_effort test drove family:'openai'.
describe("buildAiSdkArgs — defect 5 (reasoning_effort keyed under the wrong providerOptions entry for 'openai-compatible')", () => {
  it('keys reasoningEffort under providerOptions[<configured provider name>], not the literal "openai"', () => {
    const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'openai-compatible', {
      providerName: 'openrouter',
    });
    expect(args.providerOptions).toEqual({ openrouter: { reasoningEffort: 'high' } });
  });

  it('falls back to the literal "openai-compatible" key when no providerName is supplied, matching model.ts\'s own createOpenAICompatible default', () => {
    const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'openai-compatible');
    expect(args.providerOptions).toEqual({ 'openai-compatible': { reasoningEffort: 'high' } });
  });

  it('still keys genuine openai family calls under providerOptions.openai (unchanged behavior)', () => {
    const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'openai');
    expect(args.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
  });
});
