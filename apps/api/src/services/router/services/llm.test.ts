import { describe, expect, test } from 'bun:test';

import { accumulateUsageChunk, calculateCost, extractUsage } from './llm';

describe('canonical LLM usage extraction', () => {
  test('extracts OpenAI cache reads, cache writes, and exact upstream cost', () => {
    expect(
      extractUsage({
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 20 },
          cost: 0.00042,
        },
      }),
    ).toEqual({
      promptTokens: 120,
      completionTokens: 30,
      cachedTokens: 80,
      cacheWriteTokens: 20,
      upstreamCost: 0.00042,
    });
  });

  test('adds Anthropic cache reads and writes to the full prompt total', () => {
    expect(
      extractUsage(
        {
          usage: {
            input_tokens: 20,
            output_tokens: 30,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 40,
          },
        },
        'anthropic',
      ),
    ).toEqual({
      promptTokens: 140,
      completionTokens: 30,
      cachedTokens: 80,
      cacheWriteTokens: 40,
      upstreamCost: undefined,
    });
  });

  test('accumulates Anthropic streaming usage without dropping cache tokens', () => {
    let state = accumulateUsageChunk(
      null,
      {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-4-6',
          usage: {
            input_tokens: 20,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 40,
          },
        },
      },
      'anthropic',
    );
    state = accumulateUsageChunk(
      state,
      { type: 'message_delta', usage: { output_tokens: 30 } },
      'anthropic',
    );

    expect(state).toEqual({
      model: 'claude-sonnet-4-6',
      usage: {
        promptTokens: 140,
        completionTokens: 30,
        cachedTokens: 80,
        cacheWriteTokens: 40,
        upstreamCost: undefined,
      },
    });
  });
});

describe('canonical LLM pricing', () => {
  test('uses an exact zero upstream cost instead of the fallback price', () => {
    expect(
      calculateCost(
        {
          openrouterId: 'free-model',
          inputPer1M: 1,
          outputPer1M: 4,
          contextWindow: 128_000,
          tier: 'paid',
        },
        1_000_000,
        1_000_000,
        0,
        0,
        1.2,
        0,
      ),
    ).toBe(0);
  });

  test('uses an explicit cache-write rate without requiring a cache-read rate', () => {
    expect(
      calculateCost(
        {
          openrouterId: 'write-only-cache-model',
          inputPer1M: 1,
          outputPer1M: 4,
          contextWindow: 128_000,
          tier: 'paid',
          cacheWritePer1M: 0.5,
        },
        100,
        0,
        0,
        100,
        1,
      ),
    ).toBe(0.00005);
  });
});
