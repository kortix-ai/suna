import { describe, expect, test } from 'bun:test';

import { buildModelPricingIndex, lookupModelPricing } from './model-pricing';

describe('provider-qualified models.dev pricing', () => {
  const index = buildModelPricingIndex({
    crossmodel: {
      id: 'crossmodel',
      models: {
        'deepseek/deepseek-v4-flash': {
          id: 'deepseek/deepseek-v4-flash',
          cost: { input: 0.16, output: 0.32, cache_read: 0.004, cache_write: 0.16 },
        },
      },
    },
    openrouter: {
      id: 'openrouter',
      models: {
        'deepseek/deepseek-v4-flash': {
          id: 'deepseek/deepseek-v4-flash',
          cost: { input: 0.098, output: 0.196, cache_read: 0.0196 },
        },
      },
    },
  });

  test('keeps duplicate model ids separate by provider', () => {
    expect(lookupModelPricing(index, 'openrouter', 'deepseek/deepseek-v4-flash')).toEqual({
      inputPer1M: 0.098,
      outputPer1M: 0.196,
      cacheReadPer1M: 0.0196,
    });
    expect(lookupModelPricing(index, 'crossmodel', 'deepseek/deepseek-v4-flash')).toEqual({
      inputPer1M: 0.16,
      outputPer1M: 0.32,
      cacheReadPer1M: 0.004,
      cacheWritePer1M: 0.16,
    });
  });

  test('does not use another provider or a prefix match', () => {
    expect(lookupModelPricing(index, 'missing-provider', 'deepseek/deepseek-v4-flash')).toBeNull();
    expect(
      lookupModelPricing(index, 'openrouter', 'deepseek/deepseek-v4-flash-preview'),
    ).toBeNull();
  });

  test('preserves context tiers and the context_over_200k compatibility tier', () => {
    const tiered = buildModelPricingIndex({
      openrouter: {
        id: 'openrouter',
        models: {
          'provider/tiered': {
            id: 'provider/tiered',
            cost: {
              input: 1,
              output: 2,
              cache_read: 0.1,
              cache_write: 1,
              tiers: [
                {
                  input: 3,
                  output: 6,
                  cache_read: 0.3,
                  cache_write: 3,
                  tier: { type: 'context', size: 32_000 },
                },
              ],
              context_over_200k: {
                input: 4,
                output: 8,
                cache_read: 0.4,
                cache_write: 4,
              },
            },
          },
        },
      },
    });

    expect(lookupModelPricing(tiered, 'openrouter', 'provider/tiered')).toMatchObject({
      tiers: [
        {
          inputPer1M: 3,
          outputPer1M: 6,
          cacheReadPer1M: 0.3,
          cacheWritePer1M: 3,
          contextThreshold: 32_000,
        },
      ],
      contextOver200k: {
        inputPer1M: 4,
        outputPer1M: 8,
        cacheReadPer1M: 0.4,
        cacheWritePer1M: 4,
        contextThreshold: 200_000,
      },
    });
  });
});
