import { afterEach, describe, expect, it } from 'bun:test';
import type { CatalogModel } from '@kortix/llm-catalog';
import { generateText, streamText } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { UpstreamDescriptor } from '../../domain';
import { NetworkError, UpstreamHttpError } from '../../errors';
import { IncrementalSseScanner, calculateCost } from '../../usage';
import { callUpstreamViaAiSdk, guardAgainstUnhandledResultRejections, toTransportError } from './index';
import {
  aiSdkFamilyFor,
  clampMaxOutputTokensForBedrock,
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

// Read a relayed stream the way the gateway does (streaming.ts): the final
// usage frame, the first error frame, and the output characters served.
function scan(sse: string): IncrementalSseScanner {
  const scanner = new IncrementalSseScanner();
  scanner.push(sse);
  scanner.finish();
  return scanner;
}

// Parse `data: {...}` frames (ignoring [DONE] + heartbeats) — the same view the
// gateway's relay takes of the stream.
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
  inputTokenDetails: { cacheReadTokens: 20, cacheWriteTokens: 10 },
  outputTokenDetails: { reasoningTokens: 10 },
  ...over,
});

const CTX = { model: 'openai/gpt-5.6', provider: 'openai' };

// A Bedrock family covers Claude AND non-Claude (global.openai.*, Nova, Meta)
// models; only Claude accepts the Converse-only primitives (cachePoint,
// reasoningConfig:adaptive), gated on the resolved model id (isBedrockClaudeModel).
// Bedrock tests that assert those primitives pass a Claude resolvedModel.
const BEDROCK_CLAUDE = 'us.anthropic.claude-fable-5';
// A non-Claude Bedrock upstream (OpenAI on Bedrock) — must get NEITHER primitive.
const BEDROCK_OPENAI = 'global.openai.gpt-5.6-sol';

describe('ai-sdk SSE adapter — /v1/llm contract fidelity', () => {
  it('maps cache-write usage when the provider reports no cache reads', () => {
    const mapped = mapUsage(
      usage({ inputTokenDetails: { cacheReadTokens: 0, cacheWriteTokens: 10 } }) as any,
    );

    expect(mapped.prompt_tokens_details).toEqual({ cache_write_tokens: 10 });
  });

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
    expect(scan(sse).outputChars).toBeGreaterThan(0);

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
    expect((usageChunk as any).usage.prompt_tokens_details.cache_write_tokens).toBe(10);
    expect(scan(sse).usage?.cacheWriteTokens).toBe(10);
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
    expect(scan(sse).outputChars).toBeGreaterThan(0);
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
    const frame = scan(sse).error;
    expect(frame?.message).toBe('overloaded');
    expect(frame?.code).toBe(529);
  });

  it('classifies a fetch headers TimeoutError with a stable gateway code', async () => {
    const timeout = new DOMException('Provider response headers timed out', 'TimeoutError');
    const sse = await readAll(openAiSseFromFullStream(parts({ type: 'error', error: timeout }), CTX));

    expect(scan(sse).error).toMatchObject({
      message: 'Provider response headers timed out',
      code: 'upstream_timeout',
    });
  });

  it('maps reasoning text to both OpenCode-compatible reasoning fields', async () => {
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
    expect(scan(sse).outputChars).toBeGreaterThan(0);
    const reasoning = frames(sse)
      .map((c: any) => c.choices?.[0]?.delta?.reasoning ?? '')
      .join('');
    expect(reasoning).toBe('thinking...');
    const reasoningContent = frames(sse)
      .map((c: any) => c.choices?.[0]?.delta?.reasoning_content ?? '')
      .join('');
    expect(reasoningContent).toBe('thinking...');
    expect(frames(sse).some((c: any) => c.choices?.[0]?.delta?.reasoning_details)).toBe(false);
  });
});

describe('ai-sdk billing: the relayed usage frame prices like a native one', () => {
  const pricing = { inputPerMillion: 3, outputPerMillion: 15, cachedInputPerMillion: 0.3 };

  it('the AI SDK usage chunk carries the counts and cost the gateway bills', async () => {
    const sse = await readAll(
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
    const read = scan(sse).usage!;
    expect(read).toMatchObject({ promptTokens: 1000, completionTokens: 400, cachedTokens: 250 });
    const cost = calculateCost('gpt', read, 1.1, read.upstreamCostHint, pricing);
    // 750 plain × $3 + 250 cached × $0.30 + 400 output × $15, per million.
    expect(cost.upstreamCost).toBeCloseTo(0.008325, 10);
    expect(cost.finalCost).toBeCloseTo(0.0091575, 10);
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

  it('backfills empty-content messages so Bedrock never sees an empty content field', () => {
    // An assistant turn with no text and no tool_calls (e.g. persisted from an
    // earlier empty upstream completion), an empty user turn, and a blank tool
    // result would each serialize to an empty content field that the Bedrock
    // Converse API rejects. All three must round-trip with non-empty content.
    const { messages } = toModelMessages([
      { role: 'user', content: '' },
      { role: 'assistant', content: '' },
      { role: 'user', content: [{ type: 'text', text: '   ' }] },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'wx', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'wx', content: '' },
    ]);
    expect(messages[0]).toEqual({ role: 'user', content: '(no content)' });
    expect(messages[1]).toEqual({ role: 'assistant', content: '(no content)' });
    expect(messages[2]).toEqual({ role: 'user', content: '(no content)' });
    // messages[3] is the assistant tool-call; messages[4] is its (empty) result.
    expect(messages[4]).toMatchObject({
      role: 'tool',
      content: [{ type: 'tool-result', output: { type: 'text', value: '(no content)' } }],
    });
    // Sanity: nothing emitted an empty string / empty array content.
    for (const m of messages) {
      if (typeof m.content === 'string') expect(m.content.trim().length).toBeGreaterThan(0);
      else expect(m.content.length).toBeGreaterThan(0);
    }
  });

  it('drops an orphaned tool_call (cancelled mid-tool turn) so strict providers accept it', () => {
    // Assistant asked for two tools but only one result came back (turn was
    // cancelled). Bedrock/Anthropic reject the unmatched tool_use; the matched
    // one must survive.
    const { messages } = toModelMessages([
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: 'working',
        tool_calls: [
          { id: 'ok', function: { name: 'a', arguments: '{}' } },
          { id: 'orphan', function: { name: 'b', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'ok', name: 'a', content: 'done' },
    ]);
    const assistant = messages.find((m) => m.role === 'assistant');
    const toolCalls = (assistant?.content as Array<{ type: string; toolCallId?: string }>).filter(
      (p) => p.type === 'tool-call',
    );
    expect(toolCalls.map((p) => p.toolCallId)).toEqual(['ok']);
  });

  it('drops an orphaned tool result (no matching tool_call) entirely', () => {
    const { messages } = toModelMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'ok' },
      { role: 'tool', tool_call_id: 'ghost', name: 'x', content: 'stray' },
    ]);
    expect(messages.some((m) => m.role === 'tool')).toBe(false);
  });

  it('keeps well-formed tool pairs untouched', () => {
    const { messages } = toModelMessages([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', function: { name: 'wx', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'wx', content: 'sunny' },
    ]);
    expect(messages.some((m) => m.role === 'tool')).toBe(true);
    const assistant = messages.find((m) => m.role === 'assistant');
    expect((assistant?.content as Array<{ type: string }>).some((p) => p.type === 'tool-call')).toBe(
      true,
    );
  });

  it('translates a data: image_url into a file part that carries the base64 untouched', () => {
    const { messages } = toModelMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
    const filePart = (
      messages[0]?.content as Array<{ type: string; data: unknown; mediaType?: string }>
    ).find((p) => p.type === 'file');
    expect(filePart).toBeDefined();
    // Tagged inline data: the AI SDK returns it as-is and both the anthropic
    // and bedrock providers serialize a base64 STRING through the identity
    // `convertToBase64`, so no decode and no re-encode happens anywhere.
    expect(filePart!.data).toEqual({ type: 'data', data: 'AAAA' });
    expect(filePart!.mediaType).toBe('image/png');
  });

  it('keeps an http(s) image_url as a URL reference and defaults the media type', () => {
    const { messages } = toModelMessages([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'https://img.example/a.png' } }],
      },
    ]);
    const filePart = (
      messages[0]?.content as Array<{ type: string; data: { type: string; url?: URL }; mediaType?: string }>
    ).find((p) => p.type === 'file');
    expect(filePart!.data.type).toBe('url');
    expect(filePart!.data.url?.toString()).toBe('https://img.example/a.png');
    expect(filePart!.mediaType).toBe('image');
  });

  it('data: URL without a media type falls back to the top-level image type', () => {
    const { messages } = toModelMessages([
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:;base64,AAAA' } }],
      },
    ]);
    const filePart = (
      messages[0]?.content as Array<{ type: string; data: unknown; mediaType?: string }>
    ).find((p) => p.type === 'file');
    expect(filePart!.data).toEqual({ type: 'data', data: 'AAAA' });
    expect(filePart!.mediaType).toBe('image');
  });

  it('maps tool_choice and builds the tool set', () => {
    const anthropic = buildAiSdkArgs(
      {
        messages: [],
        tools: [{ function: { name: 't', parameters: {} } }],
        tool_choice: 'required',
      },
      'anthropic',
    );
    expect(anthropic.toolChoice).toBe('required');
    expect(anthropic.tools).toBeTruthy();
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
    // resolveThinkingRequest never turns extended thinking on. With no thinking
    // AND a resolved model, defaultMaxTokens is the model's real ceiling
    // (limit.output = 8000 here), not the 4096 unresolved-model fallback.
    const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'anthropic', {
      model: effortModel({ reasoning: false, reasoning_options: undefined }),
    });
    expect(args.providerOptions).toBeUndefined();
    expect(args.maxOutputTokens).toBe(8000);
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
      anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'high' },
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
        thinking: { type: 'adaptive', display: 'summarized' },
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
      thinking: { type: 'adaptive', display: 'summarized' },
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
      anthropic: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'medium' },
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

  it('bedrock: reasoning_effort maps to adaptive reasoningConfig + effort (never enabled/budgetTokens), never providerOptions.anthropic', () => {
    const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'medium' }, 'bedrock', {
      resolvedModel: BEDROCK_CLAUDE,
    });
    expect(args.providerOptions).toMatchObject({
      bedrock: {
        reasoningConfig: {
          type: 'adaptive',
          maxReasoningEffort: 'medium',
          display: 'summarized',
        },
      },
    });
    // Current-gen Bedrock Claude (Sonnet 5, Opus 4.5+) 400s on the legacy
    // enabled/budgetTokens shape — it must NEVER be sent (verified against real
    // Bedrock us-east-1). Adaptive carries no budget to clamp.
    expect((args.providerOptions as any)?.bedrock?.reasoningConfig?.type).not.toBe('enabled');
    expect((args.providerOptions as any)?.bedrock?.reasoningConfig?.budgetTokens).toBeUndefined();
    expect(args.providerOptions).not.toHaveProperty('anthropic');
    expect(args.maxOutputTokens).toBe(32000);
  });

  it('bedrock: every reasoning_effort level maps to an adaptive effort tier and NEVER emits type:"enabled" (minimal folds to low)', () => {
    const cases: Array<[string, string]> = [
      ['minimal', 'low'],
      ['low', 'low'],
      ['medium', 'medium'],
      ['high', 'high'],
      ['xhigh', 'xhigh'],
      ['max', 'max'],
    ];
    for (const [effort, tier] of cases) {
      const args = buildAiSdkArgs({ messages: [], reasoning_effort: effort }, 'bedrock', {
        resolvedModel: BEDROCK_CLAUDE,
      });
      expect((args.providerOptions as any)?.bedrock?.reasoningConfig).toEqual({
        type: 'adaptive',
        maxReasoningEffort: tier,
        display: 'summarized',
      });
    }
  });

  const BEDROCK_OPENAI = 'global.openai.gpt-5.6-sol';

  it('bedrock: OpenAI-on-Bedrock forwards every published effort tier as additionalModelRequestFields.reasoning.effort (the shape real Bedrock accepts; flat reasoning_effort is 400 unknown_parameter) — never the Claude reasoningConfig/cachePoint', () => {
    for (const effort of ['none', 'low', 'medium', 'high', 'xhigh', 'max']) {
      const args = buildAiSdkArgs({ messages: [], reasoning_effort: effort }, 'bedrock', {
        resolvedModel: BEDROCK_OPENAI,
      });
      expect((args.providerOptions as any)?.bedrock).toEqual({
        additionalModelRequestFields: { reasoning: { effort, summary: 'auto' } },
      });
      expect((args.providerOptions as any)?.bedrock?.additionalModelRequestFields?.reasoning_effort).toBeUndefined();
      expect((args.providerOptions as any)?.bedrock?.reasoningConfig).toBeUndefined();
      expect(args.providerOptions).not.toHaveProperty('anthropic');
    }
  });

  it('bedrock: a model that once answered unknown_parameter for the reasoning field never receives it again', async () => {
    // The memory is process-wide, so this row uses a model id no other test uses.
    const { noteBedrockOpenAiRejectsReasoningEffort } = await import('./request');
    const refusing = 'global.openai.effort-memory-probe';
    noteBedrockOpenAiRejectsReasoningEffort(refusing);
    const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'max' }, 'bedrock', {
      resolvedModel: refusing,
    });
    expect((args.providerOptions as any)?.bedrock?.additionalModelRequestFields).toBeUndefined();
    const other = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'bedrock', {
      resolvedModel: 'openai.gpt-oss-120b',
    });
    expect((other.providerOptions as any)?.bedrock?.additionalModelRequestFields).toEqual({
      reasoning: { effort: 'high', summary: 'auto' },
    });
  });

  it('bedrock: OpenAI-on-Bedrock without any effort sends no bedrock provider options at all', () => {
    const args = buildAiSdkArgs({ messages: [] }, 'bedrock', { resolvedModel: BEDROCK_OPENAI });
    expect((args.providerOptions as any)?.bedrock?.additionalModelRequestFields).toBeUndefined();
    expect((args.providerOptions as any)?.bedrock?.reasoningConfig).toBeUndefined();
  });

  it('bedrock: the in-region OpenAI ids (openai.gpt-5.6-terra, openai.gpt-oss-120b-1:0) take the same path; Nova and Grok still get nothing', () => {
    for (const id of ['openai.gpt-5.6-terra', 'openai.gpt-oss-120b-1:0', 'us.openai.gpt-5.5']) {
      const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'bedrock', {
        resolvedModel: id,
      });
      expect((args.providerOptions as any)?.bedrock?.additionalModelRequestFields).toEqual({
        reasoning: { effort: 'high', summary: 'auto' },
      });
    }
    for (const id of ['us.amazon.nova-micro-v1:0', 'xai.grok-4.6']) {
      // No verified mapping for these families yet: the effort is DROPPED and
      // the plain Converse request goes out. opencode sends a default effort
      // for every reasoning-capable model, so refusing it (as #6887 briefly
      // did) refused the model — including the managed Grok default.
      const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'bedrock', {
        resolvedModel: id,
      });
      expect((args.providerOptions as any)?.bedrock?.additionalModelRequestFields).toBeUndefined();
      expect((args.providerOptions as any)?.bedrock?.reasoningConfig).toBeUndefined();
    }
  });

  it('does not set thinking/reasoningConfig or bump maxOutputTokens for the openai family', () => {
    const openai = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'openai');
    expect(openai.providerOptions).toEqual({ openai: { reasoningEffort: 'high' } });
    expect(openai.maxOutputTokens).toBeUndefined();
  });
});

describe('trailing assistant prefill is stripped across the board (one normalization fixes both errors)', () => {
  // Reproduces two real production errors, both from a trailing assistant message
  // (a replayed partial from a cancelled turn):
  //   • Bedrock `global.anthropic.claude-sonnet-5` → HTTP 400 "This model does not
  //     support assistant message prefill. The conversation must end with a user
  //     message."
  //   • ChatGPT-Codex `gpt-5.6-sol` → empty 200 stream → empty_completion.
  // A conversation must end on a user/tool turn, so toModelMessages drops the
  // trailing assistant UNCONDITIONALLY (like repairToolPairing) — every family.
  const withTrailingAssistant = {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'partial reply the client replayed' },
    ],
  };

  // The strip runs in toModelMessages, before any family-specific mapping.
  it('strips the trailing assistant so the request ends on a user message', () => {
    const args = buildAiSdkArgs({ ...withTrailingAssistant }, 'bedrock');
    expect(args.messages).toHaveLength(1);
    expect(args.messages[args.messages.length - 1].role).toBe('user');
  });

  it('strips multiple consecutive trailing assistant turns, keeps the last user/tool turn', () => {
    const args = buildAiSdkArgs(
      {
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'a1' },
          { role: 'assistant', content: 'a2' },
        ],
      },
      'bedrock',
    );
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0].role).toBe('user');
  });

  it('a conversation already ending on a user turn is untouched', () => {
    const args = buildAiSdkArgs(
      { messages: [{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'go' }] },
      'openai',
    );
    expect(args.messages).toHaveLength(2);
    expect(args.messages[args.messages.length - 1].role).toBe('user');
  });

  it('bedrock: the prompt-cache breakpoint lands on the surviving user turn, not a removed assistant', () => {
    const args = buildAiSdkArgs({ ...withTrailingAssistant }, 'bedrock', {
      resolvedModel: BEDROCK_CLAUDE,
    });
    const last = args.messages[args.messages.length - 1] as {
      role: string;
      providerOptions?: { bedrock?: { cachePoint?: unknown } };
    };
    expect(last.role).toBe('user');
    expect(last.providerOptions?.bedrock?.cachePoint).toEqual({ type: 'default' });
  });

  it('never strips down to an empty conversation (all-assistant history is left for the upstream)', () => {
    const args = buildAiSdkArgs(
      { messages: [{ role: 'assistant', content: 'only' }] },
      'bedrock',
    );
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0].role).toBe('assistant');
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
      { resolvedModel: BEDROCK_CLAUDE },
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
      { resolvedModel: BEDROCK_CLAUDE },
    );
    expect(withSystem.system).toEqual({
      role: 'system',
      content: 'ctx',
      providerOptions: { bedrock: { cachePoint: { type: 'default' } } },
    });
  });

  it('never attaches cacheControl/cachePoint providerOptions for the openai family', () => {
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

// FIX B2 — a no-max_tokens request must default to the model's REAL output
// ceiling (limit.output, e.g. 128000), not the fixed 32000/4096. A fixed cap
// far below the ceiling truncated Claude mid-answer (finish_reason=length) once
// adaptive thinking ate the budget. The client's own explicit max_tokens still
// always wins; the fixed 32000/4096 remain the fallback for an unresolved model.
describe('ai-sdk default max_tokens follows the model output ceiling (FIX B2)', () => {
  // A high real output ceiling — far above the old fixed 32000/4096 defaults.
  const claudeModel = (over: Partial<CatalogModel> = {}): CatalogModel => ({
    id: 'claude-fable-5',
    name: 'Claude Fable 5',
    reasoning: true,
    reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    limit: { context: 1_000_000, output: 128_000 },
    ...over,
  });

  it('anthropic (non-thinking, no max_tokens): defaults to limit.output, not 4096', () => {
    const args = buildAiSdkArgs({ messages: [] }, 'anthropic', { model: claudeModel() });
    expect(args.maxOutputTokens).toBe(128_000);
  });

  it('anthropic (thinking active, no max_tokens): defaults to limit.output, not 32000', () => {
    const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'anthropic', {
      model: claudeModel(),
    });
    // Thinking is on (adaptive), yet the ceiling — not the 32000 thinking
    // default — sizes the budget, so a long Claude answer is never truncated.
    expect((args.providerOptions as any)?.anthropic?.thinking?.type).toBe('adaptive');
    expect(args.maxOutputTokens).toBe(128_000);
  });

  it('bedrock (Claude, no max_tokens): defaults to limit.output, not 4096/32000', () => {
    const args = buildAiSdkArgs({ messages: [] }, 'bedrock', {
      model: claudeModel(),
      resolvedModel: BEDROCK_CLAUDE,
    });
    expect(args.maxOutputTokens).toBe(128_000);
  });

  it('an explicit client max_tokens still wins over the model ceiling', () => {
    const args = buildAiSdkArgs({ messages: [], max_tokens: 2000 }, 'anthropic', {
      model: claudeModel(),
    });
    expect(args.maxOutputTokens).toBe(2000);
  });

  it('an unresolved model (no model) keeps the fixed 4096/32000 fallback', () => {
    const plain = buildAiSdkArgs({ messages: [] }, 'anthropic');
    expect(plain.maxOutputTokens).toBe(4096);
    const thinking = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'anthropic');
    expect(thinking.maxOutputTokens).toBe(32_000);
  });

  it('a model with no limit.output falls back to the fixed 4096 default', () => {
    const args = buildAiSdkArgs({ messages: [] }, 'anthropic', {
      model: claudeModel({ limit: undefined }),
    });
    expect(args.maxOutputTokens).toBe(4096);
  });
});

// 403-fix regression (isBedrockClaudeModel gate): a single Bedrock family serves
// Claude AND non-Claude (global.openai.*, Nova, Meta) models, but only Claude
// accepts the Converse-only primitives. Non-Claude Bedrock 403s ("You invoked an
// unsupported model or your request did not allow prompt caching.") on cachePoint
// / reasoningConfig — so those must be gated on the resolved model id.
describe('bedrock Converse primitives are gated on the resolved Claude model id (403 fix)', () => {
  const body = {
    messages: [
      { role: 'system', content: 'ctx' },
      { role: 'user', content: 'hi' },
    ],
    reasoning_effort: 'high',
  };

  it('non-Claude Bedrock (global.openai.*): emits NEITHER cachePoint NOR reasoningConfig', () => {
    const args = buildAiSdkArgs({ ...body }, 'bedrock', { resolvedModel: BEDROCK_OPENAI });
    // No reasoningConfig (adaptive thinking) in providerOptions.
    expect((args.providerOptions as any)?.bedrock?.reasoningConfig).toBeUndefined();
    // No cachePoint on the system prompt…
    expect(args.system).toBe('ctx');
    // …nor on the last message.
    expect(args.messages[args.messages.length - 1]).not.toHaveProperty('providerOptions');
  });

  it('absent resolvedModel is treated as non-Claude (no Claude primitives)', () => {
    const args = buildAiSdkArgs({ ...body }, 'bedrock');
    expect((args.providerOptions as any)?.bedrock?.reasoningConfig).toBeUndefined();
    expect(args.system).toBe('ctx');
    expect(args.messages[args.messages.length - 1]).not.toHaveProperty('providerOptions');
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

    expect(scan(sse).outputChars).toBeGreaterThan(0);
    const text = frames(sse)
      .map((c: any) => c.choices?.[0]?.delta?.content ?? '')
      .join('');
    expect(text).toBe('Hi there');
    const u = scan(sse).usage;
    expect(u!.promptTokens).toBe(12);
    expect(u!.completionTokens).toBe(3);
  });
});

describe('ai-sdk non-streaming JSON adapter', () => {
  it('produces a chat.completion with tool_calls and usage', () => {
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

    const frame = scan(sse).error;
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

  it('aiSdkFamilyFor resolves a Codex descriptor to the openai family (Responses-capable)', () => {
    expect(aiSdkFamilyFor(codex)).toBe('openai');
  });

  describe('resolveAiModel — the Responses model selection', () => {
    // `LanguageModel` (the return type) is a union that also admits a bare
    // model-id string (a global-registry reference) — narrow to the object
    // shape resolveAiModel actually returns to read `.provider` off it.
    const providerOf = (model: ReturnType<typeof resolveAiModel>): string =>
      (model as { provider: string }).provider;

    // Every openai-family call reaches the AI SDK only when it needs the
    // Responses API (a genuine OpenAI reasoning model with tools and a live
    // effort, or Codex); a plain chat request goes to the provider directly.
    it.each([
      ['a genuine OpenAI reasoning upstream', genuineOpenAiReasoning],
      ['Codex', codex],
    ])('builds a .responses() model for %s', (_name, descriptor) => {
      expect(providerOf(resolveAiModel(descriptor))).toBe('openai.responses');
    });

    it('refuses an OpenAI-compatible upstream: those are called directly', () => {
      expect(() =>
        resolveAiModel({ ...genuineOpenAiReasoning, provider: 'openrouter', npm: undefined, baseUrl: 'https://openrouter.example/v1' }),
      ).toThrow('OpenAI-compatible upstreams are called directly');
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

    it('does NOT set store for plain OpenAI — the platform API defaults it itself', () => {
      const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'openai', {
        providerName: 'openai',
      });
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

  // Every Codex model reasons. @ai-sdk/openai 4.0.16 decides by id prefix
  // (o1/o3/o4-mini/gpt-5), so `gpt-6-*` counted as a non-reasoning model: the
  // SDK dropped reasoningEffort with a warning and sent system prompts in the
  // wrong role. `forceReasoning` overrides that detection.
  describe('buildAiSdkArgs — Codex models are reasoning models', () => {
    it('sets forceReasoning for openai-codex', () => {
      const args = buildAiSdkArgs({ messages: [], reasoning_effort: 'high' }, 'openai', {
        providerName: 'openai-codex',
      });
      expect(args.providerOptions?.openai).toMatchObject({ forceReasoning: true, reasoningEffort: 'high' });
    });

    it('leaves plain OpenAI to the SDK detection', () => {
      const args = buildAiSdkArgs({ messages: [] }, 'openai', { providerName: 'openai' });
      expect(args.providerOptions?.openai ?? {}).not.toHaveProperty('forceReasoning');
    });
  });

  // The ChatGPT backend rejects a Responses body that carries `metadata`
  // (bare 400). Claude Code always sends Anthropic `metadata.user_id`.
  describe('buildAiSdkArgs — Codex never receives metadata', () => {
    it('drops client metadata for openai-codex', () => {
      const args = buildAiSdkArgs({ messages: [], metadata: { user_id: 'u' } }, 'openai', {
        providerName: 'openai-codex',
      });
      expect(args.providerOptions?.openai ?? {}).not.toHaveProperty('metadata');
    });

    it('still forwards metadata to plain OpenAI', () => {
      const args = buildAiSdkArgs({ messages: [], metadata: { user_id: 'u' } }, 'openai', {
        providerName: 'openai',
      });
      expect(args.providerOptions?.openai).toMatchObject({ metadata: { user_id: 'u' } });
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

    it('STILL forwards max_tokens for plain OpenAI (the platform API accepts it)', () => {
      const args = buildAiSdkArgs({ messages: [], max_tokens: 1024 }, 'openai', {
        providerName: 'openai',
      });
      expect(args.maxOutputTokens).toBe(1024);
    });
  });

  // Codex's backend is stream-only (`stream:false` 400s). The AI SDK's
  // non-streaming `doGenerate` always sends `stream:false`, so
  // callUpstreamViaAiSdk drives Codex through `streamText` even for a client
  // that asked for a non-streaming completion, then collapses the settled
  // result into one JSON response. These rows run that path end to end against
  // a Responses-API event stream on a fake fetch.
  describe('Codex non-streaming client request over a stream-only upstream (collapse path)', () => {
    const responsesStream = (events: Array<Record<string, unknown>>) =>
      new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    const created = { type: 'response.created', response: { id: 'resp_1', created_at: 1, model: 'gpt-5-codex' } };
    const completed = (input: number, output: number) => ({
      type: 'response.completed',
      response: { usage: { input_tokens: input, output_tokens: output } },
    });
    const collapse = async (events: Array<Record<string, unknown>>, body: Record<string, unknown>) => {
      const sentBodies: Array<Record<string, unknown>> = [];
      const response = await callUpstreamViaAiSdk({ stream: false, ...body }, codex, {
        fetch: async (_input, init) => {
          sentBodies.push(JSON.parse(String(init?.body)));
          return responsesStream(events);
        },
      });
      return { json: (await response.json()) as any, sentBodies };
    };

    it('collapses a streamed tool call into the same JSON shape generateText would produce', async () => {
      const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather' };
      const { json, sentBodies } = await collapse(
        [
          created,
          { type: 'response.output_item.added', output_index: 0, item: { ...call, arguments: '' } },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"city":"sf"}' },
          {
            type: 'response.output_item.done',
            output_index: 0,
            item: { ...call, arguments: '{"city":"sf"}', status: 'completed' },
          },
          completed(4, 6),
        ],
        { messages: [{ role: 'user', content: 'weather?' }], tools: [reasoningTool] },
      );

      expect(sentBodies[0]?.stream).toBe(true);
      expect(json.object).toBe('chat.completion');
      expect(json.choices[0].finish_reason).toBe('tool_calls');
      expect(json.choices[0].message.tool_calls[0]).toMatchObject({
        id: 'call_1',
        function: { name: 'get_weather', arguments: '{"city":"sf"}' },
      });
      expect(json.usage.prompt_tokens).toBe(4);
      expect(json.usage.completion_tokens).toBe(6);
    });

    it('collapses a streamed plain-text answer the same way, with no tool_calls key', async () => {
      const { json } = await collapse(
        [
          created,
          { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
          { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'low-effort answer' },
          { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
          completed(3, 2),
        ],
        { messages: [{ role: 'user', content: 'hi' }] },
      );

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

    const serverError = toTransportError(Object.assign(new Error('internal error'), { statusCode: 500 }), 'openai');
    expect(serverError).toBeInstanceOf(UpstreamHttpError);
    expect((serverError as UpstreamHttpError).status).toBe(500);
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
  });

  it('still falls back to a retryable NetworkError for a genuine statusCode-less transient failure', () => {
    const err = new Error('socket hang up');
    const mapped = toTransportError(err, 'openai');
    expect(mapped).toBeInstanceOf(NetworkError);
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
    const frame = scan(sse).error;
    expect(frame?.message).toBe('Incorrect API key provided');
    expect(frame?.code).toBe(401);
    // No content was ever produced — a same-candidate empty-completion retry
    // would otherwise be indistinguishable from this terminal failure.
    expect(scan(sse).outputChars).toBe(0);
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
    const frame = scan(sse).error;
    expect(frame?.code).toBe(401);
  });

  // Defect (2026-08-01, live-reported): an upstream 400 "context length
  // exceeded from messages" surfaced to the user as a generic "Bad Gateway"
  // instead of the real error + real status. The AI SDK wraps a non-2xx HTTP
  // response in an APICallError whose `.message` is the generic HTTP status
  // text ("Bad Request") — the actionable message ("context length exceeded
  // from messages") lives in `.responseBody` (the raw upstream JSON), and the
  // numeric status in `.statusCode`. The streaming adapter (sse.ts) threaded
  // `.responseBody` into the frame's `detail` but used the generic
  // `.message` as the client-facing message, AND only emitted a numeric
  // `code` for terminal-auth failures — so a 400 reached the pipeline's
  // statusForErrorFrame as `code: undefined`, which falls through to a blanket
  // 502 "Bad Gateway". Both the real message and the real status were lost.
  // This test pins the defect at the SSE-frame layer.
  it('an APICallError with a generic message + real responseBody surfaces the real upstream message and status', async () => {
    const sse = await readAll(
      openAiSseFromFullStream(
        parts({
          type: 'error',
          error: Object.assign(new Error('Bad Request'), {
            statusCode: 400,
            responseBody:
              '{"error":{"message":"context length exceeded from messages","type":"invalid_request_error","code":"context_length_exceeded"}}',
          }),
        }),
        CTX,
      ),
    );
    const frame = scan(sse).error;
    // REAL upstream message must reach the client, not the generic "Bad Request".
    expect(frame?.message).toBe('context length exceeded from messages');
    // The numeric upstream status must be carried so the pipeline classifies
    // it as 400, not a blanket 502.
    expect(frame?.code).toBe(400);
    expect(scan(sse).outputChars).toBe(0);
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

  // @ai-sdk/openai defaults
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

  const schema = { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] };

  it.each([
    ['a json_object request', { type: 'json_object' }, { type: 'json' }, '{"ok":true}'],
    [
      'a json_schema request',
      { type: 'json_schema', json_schema: { name: 'person', schema } },
      { type: 'json', schema, name: 'person', description: undefined },
      '{"name":"kortix"}',
    ],
  ] as const)('%s reaches doGenerate with its responseFormat and the model text is valid JSON', async (_name, responseFormat, expected, text) => {
    let seenResponseFormat: unknown;
    const mock = new MockLanguageModelV4({
      doGenerate: async (options) => {
        seenResponseFormat = options.responseFormat;
        return {
          content: [{ type: 'text', text }],
          finishReason: { unified: 'stop', raw: undefined },
          usage,
          warnings: [],
        };
      },
    });

    const args = buildAiSdkArgs(
      {
        messages: [{ role: 'user', content: 'give me json' }],
        response_format: responseFormat,
      },
      'openai',
    );
    const result = await generateText({
      model: mock,
      system: args.system,
      messages: args.messages,
      output: args.output,
      providerOptions: args.providerOptions,
      maxRetries: 0,
    });

    expect(seenResponseFormat).toEqual(expected);
    expect(result.text).toBe(text);
    expect(() => JSON.parse(result.text)).not.toThrow();
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

  it('never maps these OpenAI-only fields for anthropic/bedrock — matches native, which has no equivalent for either transport', () => {
    expect(buildAiSdkArgs(body, 'anthropic').providerOptions).toBeUndefined();
    expect(buildAiSdkArgs(body, 'bedrock').providerOptions).toBeUndefined();
  });
});
