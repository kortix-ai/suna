import { describe, expect, test } from 'bun:test';

import { type UsageAccumulator, accumulateUsageChunk, calculateCost } from './llm';

// Characterization tests for the SSE usage settlement shared by the LLM router
// (`extractUsageFromStream`) and the proxy handlers
// (`extractUsageFromKortixProxyStream`). They pin the settled usage and cost
// for an OpenAI-shaped and an Anthropic-shaped stream before the two
// implementations are deduplicated, and must pass unchanged after.

const markup = 1.2; // KORTIX_MARKUP, as passed by both settlement call sites

const modelConfig = {
  openrouterId: 'sse-settlement-model',
  inputPer1M: 1,
  outputPer1M: 4,
  contextWindow: 128_000,
  tier: 'paid' as const,
  cacheReadPer1M: 0.1,
  cacheWritePer1M: 0.5,
};

function accumulate(
  state: UsageAccumulator | null,
  chunks: unknown[],
  provider: 'openai' | 'anthropic' = 'openai',
): UsageAccumulator | null {
  return chunks.reduce<UsageAccumulator | null>(
    (acc, chunk) => accumulateUsageChunk(acc, chunk, provider),
    state,
  );
}

describe('SSE stream settlement characterization', () => {
  test('settles an OpenAI-shaped SSE stream with cached, cache-write, and upstream cost', () => {
    const state = accumulate(null, [
      { model: 'gpt-test', choices: [{ delta: { content: 'hi' } }] },
      {
        model: 'gpt-test',
        choices: [],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
          cost: 0.00042,
        },
      },
    ]);

    expect(state?.model).toBe('gpt-test');
    const usage = state?.usage;
    if (!usage) throw new Error('the OpenAI-shaped stream settled without usage');
    expect(usage).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      cachedTokens: 80,
      cacheWriteTokens: 20,
      upstreamCost: 0.00042,
    });

    // An exact upstream cost bypasses token pricing (calculateCost contract).
    const cost = calculateCost(
      modelConfig,
      usage.promptTokens,
      usage.completionTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
      markup,
      usage.upstreamCost,
    );
    expect(cost).toBe(0.00042 * markup);
  });

  test('settles an Anthropic-shaped SSE stream with cached, cache-write usage identically', () => {
    const state = accumulate(
      null,
      [
        {
          type: 'message_start',
          message: {
            model: 'claude-test',
            usage: {
              input_tokens: 20,
              cache_read_input_tokens: 80,
              cache_creation_input_tokens: 40,
            },
          },
        },
        { type: 'message_delta', usage: { output_tokens: 30 } },
      ],
      'anthropic',
    );

    expect(state?.model).toBe('claude-test');
    const usage = state?.usage;
    if (!usage) throw new Error('the Anthropic-shaped stream settled without usage');
    expect(usage).toEqual({
      promptTokens: 140,
      completionTokens: 30,
      cachedTokens: 80,
      cacheWriteTokens: 40,
      upstreamCost: undefined,
    });

    // Without an upstream cost, cache categories price differentially and the
    // plain-input remainder is what is left of the prompt total.
    const cost = calculateCost(
      modelConfig,
      usage.promptTokens,
      usage.completionTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
      markup,
      usage.upstreamCost,
    );
    const regularInput = 140 - 80 - 40;
    expect(cost).toBe(
      ((regularInput / 1_000_000) * 1 +
        (80 / 1_000_000) * 0.1 +
        (40 / 1_000_000) * 0.5 +
        (30 / 1_000_000) * 4) *
        markup,
    );
  });
});
