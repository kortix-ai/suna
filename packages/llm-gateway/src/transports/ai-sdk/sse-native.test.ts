import { describe, expect, it } from 'bun:test';
import {
  type NativeBillingUsage,
  aiGatewaySseFromFullStream,
  billingUsageFromWire,
  wireUsageFromLanguageModelUsage,
} from './sse-native';

// A fullStream is an async iterable of streamText TextStreamPart-shaped objects
// — feed the native serializer the exact parts streamText emits and assert the
// AI-gateway SSE frames.
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

const CTX = { model: 'anthropic/claude-fable-5', provider: 'anthropic' };

const fullUsage = {
  inputTokens: 100,
  outputTokens: 50,
  totalTokens: 150,
  inputTokenDetails: { noCacheTokens: 70, cacheReadTokens: 20, cacheWriteTokens: 10 },
  outputTokenDetails: { textTokens: 40, reasoningTokens: 10 },
};

describe('aiGatewaySseFromFullStream — AI-gateway wire contract', () => {
  it('serializes text/reasoning/tool-call/finish and PRESERVES the reasoning signature', async () => {
    let billed: NativeBillingUsage | undefined;
    const stream = aiGatewaySseFromFullStream(
      parts(
        { type: 'start' },
        { type: 'start-step', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', text: 'Hello' },
        { type: 'text-end', id: 't1' },
        { type: 'reasoning-start', id: 'r1' },
        {
          type: 'reasoning-delta',
          id: 'r1',
          text: 'thinking...',
          // The Anthropic signature rides under providerMetadata.anthropic — the
          // whole reason this serializer exists.
          providerMetadata: { anthropic: { signature: 'SIG-abc123' } },
        },
        { type: 'reasoning-end', id: 'r1' },
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'get_weather',
          input: { city: 'SF' },
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          rawFinishReason: 'tool_use',
          totalUsage: fullUsage,
        },
      ),
      CTX,
      { onUsage: (u) => { billed = u; } },
    );

    const all = frames(await readAll(stream));

    // First frame is always stream-start with a warnings array.
    expect(all[0]).toEqual({ type: 'stream-start', warnings: [] });

    // text-delta uses `delta`, never `textDelta`.
    const textDelta = all.find((f) => f.type === 'text-delta');
    expect(textDelta).toEqual({ type: 'text-delta', id: 't1', delta: 'Hello' });

    // reasoning-delta carries providerMetadata verbatim — signature survives.
    const reasoningDelta = all.find((f) => f.type === 'reasoning-delta') as Record<string, unknown>;
    expect(reasoningDelta.type).toBe('reasoning-delta');
    expect(reasoningDelta.delta).toBe('thinking...');
    expect(reasoningDelta.providerMetadata).toEqual({ anthropic: { signature: 'SIG-abc123' } });

    // tool-call: input is a JSON STRING; ids/name present.
    const toolCall = all.find((f) => f.type === 'tool-call') as Record<string, unknown>;
    expect(toolCall.toolCallId).toBe('call_1');
    expect(toolCall.toolName).toBe('get_weather');
    expect(toolCall.input).toBe(JSON.stringify({ city: 'SF' }));

    // finish carries the unified/raw reason + the full usage tree.
    const finish = all.find((f) => f.type === 'finish') as Record<string, unknown>;
    expect(finish.finishReason).toEqual({ unified: 'tool-calls', raw: 'tool-calls' });
    expect(finish.usage).toEqual({
      inputTokens: { total: 100, noCache: 70, cacheRead: 20, cacheWrite: 10 },
      outputTokens: { total: 50, text: 40, reasoning: 10 },
    });

    // Billing sees the same totals the finish frame carries.
    expect(billed).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      cachedTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 150,
    });

    // NEVER emit v4-only custom/reasoning-file, and stream-start appears once.
    expect(all.filter((f) => f.type === 'custom')).toHaveLength(0);
    expect(all.filter((f) => f.type === 'reasoning-file')).toHaveLength(0);
    expect(all.filter((f) => f.type === 'stream-start')).toHaveLength(1);
  });

  it('emits an error frame for an in-stream error part', async () => {
    const stream = aiGatewaySseFromFullStream(
      parts({ type: 'error', error: { message: 'overloaded', statusCode: 529 } }),
      CTX,
    );
    const all = frames(await readAll(stream));
    const err = all.find((f) => f.type === 'error') as Record<string, unknown>;
    expect(err.error).toEqual({ message: 'overloaded', code: 529 });
  });

  it('drops v4-only custom/reasoning-file parts', async () => {
    const stream = aiGatewaySseFromFullStream(
      parts(
        { type: 'custom', value: 'x' },
        { type: 'reasoning-file', data: 'x' },
        { type: 'text-delta', id: 't', text: 'ok' },
        { type: 'finish', finishReason: 'stop', totalUsage: fullUsage },
      ),
      CTX,
    );
    const all = frames(await readAll(stream));
    expect(all.some((f) => f.type === 'custom')).toBe(false);
    expect(all.some((f) => f.type === 'reasoning-file')).toBe(false);
    expect(all.some((f) => f.type === 'text-delta')).toBe(true);
  });
});

describe('usage mapping helpers', () => {
  it('wireUsageFromLanguageModelUsage derives noCache/text when details are absent', () => {
    const wire = wireUsageFromLanguageModelUsage({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: 20, cacheWriteTokens: 10 },
      outputTokenDetails: { textTokens: undefined, reasoningTokens: 10 },
    } as never);
    expect(wire.inputTokens).toEqual({ total: 100, noCache: 70, cacheRead: 20, cacheWrite: 10 });
    expect(wire.outputTokens).toEqual({ total: 50, text: 40, reasoning: 10 });
  });

  it('billingUsageFromWire reads inputTokens.total + outputTokens.total', () => {
    const counts = billingUsageFromWire({
      inputTokens: { total: 100, noCache: 70, cacheRead: 20, cacheWrite: 10 },
      outputTokens: { total: 50, text: 40, reasoning: 10 },
    });
    expect(counts).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      cachedTokens: 20,
      cacheWriteTokens: 10,
      totalTokens: 150,
    });
  });
});
