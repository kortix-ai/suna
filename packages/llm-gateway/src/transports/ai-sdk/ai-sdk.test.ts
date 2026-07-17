import { describe, expect, it } from 'bun:test';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { streamText } from 'ai';
import { calculateCost, extractUsageFromSseBuffer } from '../../usage';
import { sseErrorFrame, sseHasContent } from '../../usage/completion-guard';
import type { UpstreamDescriptor } from '../../domain';
import { aiSdkFamilyFor } from './model';
import { buildAiSdkArgs, toModelMessages } from './request';
import { openAiJsonFromResult, openAiSseFromFullStream } from './sse';

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
