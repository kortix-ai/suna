import { describe, expect, test } from 'bun:test';

import type { ProviderListResponse } from '@kortix/sdk/react';

import { buildModelsDevPricingMap, createModelPricingLookup } from './model-pricing';

describe('buildModelsDevPricingMap', () => {
  test('indexes models only under their exact provider', () => {
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
    expect(map.get('deepseek-v4-pro')).toBeUndefined();
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
      default: {},
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
    } as unknown as ProviderListResponse;

    const lookup = createModelPricingLookup(providers);
    expect(lookup('kortix', 'claude-opus-4.8')).toEqual({
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: undefined,
    });
  });

  test('uses the managed catalog price and ignores another provider price for GLM', () => {
    const cached = buildModelsDevPricingMap({
      openrouter: {
        models: {
          'z-ai/glm-5.3-flash': {
            id: 'z-ai/glm-5.3-flash',
            cost: { input: 0.435, output: 0.87 },
          },
        },
      },
    });

    const providers = {
      default: {},
      all: [
        {
          id: 'kortix',
          name: 'Kortix',
          models: {
            'glm-5.3-flash': {
              name: 'GLM 5.3 Flash',
              cost: { input: 1, output: 4, cache_read: 0.2, cache_write: 1 },
            },
          },
        },
      ],
      connected: ['kortix'],
    } as unknown as ProviderListResponse;

    const lookup = createModelPricingLookup(providers, cached);
    expect(lookup('kortix', 'glm-5.3-flash')).toEqual({
      inputPer1M: 1,
      outputPer1M: 4,
      cacheReadPer1M: 0.2,
      cacheWritePer1M: 1,
    });
  });

  test('does not use models.dev as a fallback for a managed model', () => {
    const cached = buildModelsDevPricingMap({
      openrouter: {
        models: {
          'z-ai/glm-5.3-flash': {
            id: 'z-ai/glm-5.3-flash',
            cost: { input: 0.435, output: 0.87 },
          },
        },
      },
    });

    const lookup = createModelPricingLookup(undefined, cached);
    expect(lookup('kortix', 'glm-5.3-flash')).toBeNull();
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

  test('keeps managed pricing unavailable until the managed catalog loads', () => {
    const emptyLookup = createModelPricingLookup(undefined, new Map());
    expect(emptyLookup('kortix', 'glm-5.3-flash')).toBeNull();

    const cached = buildModelsDevPricingMap({
      'z-ai': {
        models: {
          'z-ai/glm-5.3-flash': {
            id: 'z-ai/glm-5.3-flash',
            cost: { input: 0.435, output: 0.87 },
          },
        },
      },
    });

    const loadedLookup = createModelPricingLookup(undefined, cached);
    expect(loadedLookup('kortix', 'glm-5.3-flash')).toBeNull();
  });
});
