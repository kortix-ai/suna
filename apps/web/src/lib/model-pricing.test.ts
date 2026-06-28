import { describe, expect, test } from 'bun:test';

import type { ProviderListResponse } from '@/hooks/opencode/use-opencode-sessions';

import { buildModelsDevPricingMap, createModelPricingLookup } from './model-pricing';

describe('buildModelsDevPricingMap', () => {
  test('indexes models by id and provider-qualified id', () => {
    const map = buildModelsDevPricingMap({
      deepseek: {
        models: {
          'deepseek-v4-pro': {
            id: 'deepseek-v4-pro',
            cost: { input: 0.435, output: 0.87, cache_read: 0.003625 },
          },
        },
      },
    });

    expect(map.get('deepseek/deepseek-v4-pro')).toEqual({
      inputPer1M: 0.435,
      outputPer1M: 0.87,
      cacheReadPer1M: 0.003625,
    });
    expect(map.get('deepseek-v4-pro')).toEqual({
      inputPer1M: 0.435,
      outputPer1M: 0.87,
      cacheReadPer1M: 0.003625,
    });
  });

  test('skips models with zero or missing pricing', () => {
    const map = buildModelsDevPricingMap({
      openrouter: {
        models: {
          free: { id: 'free', cost: { input: 0, output: 0 } },
          missing: { id: 'missing' },
        },
      },
    });

    expect(map.size).toBe(0);
  });
});

describe('createModelPricingLookup', () => {
  test('prefers provider model cost from the live provider list', () => {
    const providers = {
      all: [
        {
          id: 'kortix',
          name: 'Kortix',
          models: {
            'claude-opus-4.8': {
              name: 'Claude Opus 4.8',
              cost: { input: 3, output: 15 },
            },
          },
        },
      ],
      connected: ['kortix'],
    } as ProviderListResponse;

    const lookup = createModelPricingLookup(providers);
    expect(lookup('kortix', 'claude-opus-4.8')).toEqual({
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: undefined,
    });
  });

  test('resolves kortix managed models through pricingRef and cached models.dev rates', () => {
    const cached = buildModelsDevPricingMap({
      deepseek: {
        models: {
          'deepseek/deepseek-v4-pro': {
            id: 'deepseek/deepseek-v4-pro',
            cost: { input: 0.435, output: 0.87 },
          },
        },
      },
    });

    const lookup = createModelPricingLookup(undefined, cached);
    expect(lookup('kortix', 'deepseek-v4-pro')).toEqual({
      inputPer1M: 0.435,
      outputPer1M: 0.87,
      cacheReadPer1M: undefined,
    });
  });

  test('returns null when no provider or cached pricing matches', () => {
    const lookup = createModelPricingLookup(undefined, new Map());
    expect(lookup('kortix', 'unknown-model')).toBeNull();
  });

  test('resolves provider slash model ids from cached models.dev rates', () => {
    const cached = buildModelsDevPricingMap({
      deepseek: {
        models: {
          'deepseek/deepseek-v4-pro': {
            id: 'deepseek/deepseek-v4-pro',
            cost: { input: 0.435, output: 0.87 },
          },
        },
      },
    });

    const lookup = createModelPricingLookup(undefined, cached);
    expect(lookup('deepseek', 'deepseek-v4-pro')).toEqual({
      inputPer1M: 0.435,
      outputPer1M: 0.87,
      cacheReadPer1M: undefined,
    });
  });

  test('rebuilds from empty pricing to loaded cached pricing', () => {
    const emptyLookup = createModelPricingLookup(undefined, new Map());
    expect(emptyLookup('kortix', 'deepseek-v4-pro')).toBeNull();

    const cached = buildModelsDevPricingMap({
      deepseek: {
        models: {
          'deepseek/deepseek-v4-pro': {
            id: 'deepseek/deepseek-v4-pro',
            cost: { input: 0.435, output: 0.87 },
          },
        },
      },
    });

    const loadedLookup = createModelPricingLookup(undefined, cached);
    expect(loadedLookup('kortix', 'deepseek-v4-pro')).toEqual({
      inputPer1M: 0.435,
      outputPer1M: 0.87,
      cacheReadPer1M: undefined,
    });
  });
});
