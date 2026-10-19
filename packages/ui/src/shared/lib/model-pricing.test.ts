import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { ProviderListResponse } from '@kortix/sdk/react';

import { buildCatalogPricingMap, createModelPricingLookup } from './model-pricing';

// The `/projects/:id/llm-catalog/providers` shape (arrays of providers and
// models) built from a compact provider → model → cost map.
function catalog(
  byProvider: Record<
    string,
    Record<
      string,
      { input?: number; output?: number; cache_read?: number; cache_write?: number } | undefined
    >
  >,
) {
  return {
    providers: Object.entries(byProvider).map(([id, models]) => ({
      id,
      models: Object.entries(models).map(([modelId, cost]) => ({
        id: modelId,
        name: modelId,
        ...(cost ? { cost } : {}),
      })),
    })),
  };
}

describe('buildCatalogPricingMap', () => {
  test('indexes models only under their exact provider', () => {
    const map = buildCatalogPricingMap(
      catalog({
        deepseek: { 'deepseek-v4-pro': { input: 0.435, output: 0.87, cache_read: 0.003625 } },
      }),
    );

    expect(map.get('deepseek/deepseek-v4-pro')).toEqual({
      inputPer1M: 0.435,
      outputPer1M: 0.87,
      cacheReadPer1M: 0.003625,
    });
    expect(map.get('deepseek-v4-pro')).toBeUndefined();
  });

  test('keeps the cache write rate when the catalog has one', () => {
    const map = buildCatalogPricingMap(
      catalog({
        anthropic: { 'claude-x': { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 } },
      }),
    );
    expect(map.get('anthropic/claude-x')).toEqual({
      inputPer1M: 3,
      outputPer1M: 15,
      cacheReadPer1M: 0.3,
      cacheWritePer1M: 3.75,
    });
  });

  test('skips models with zero or missing pricing', () => {
    const map = buildCatalogPricingMap(
      catalog({ openrouter: { free: { input: 0, output: 0 }, missing: undefined } }),
    );

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
    const cached = buildCatalogPricingMap(
      catalog({ openrouter: { 'z-ai/glm-5.3-flash': { input: 0.435, output: 0.87 } } }),
    );

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

  test('does not use the catalog as a fallback for a managed model', () => {
    const cached = buildCatalogPricingMap(
      catalog({ openrouter: { 'z-ai/glm-5.3-flash': { input: 0.435, output: 0.87 } } }),
    );

    const lookup = createModelPricingLookup(undefined, cached);
    expect(lookup('kortix', 'glm-5.3-flash')).toBeNull();
  });

  test('returns null when no provider or cached pricing matches', () => {
    const lookup = createModelPricingLookup(undefined, new Map());
    expect(lookup('kortix', 'unknown-model')).toBeNull();
  });

  test('resolves provider slash model ids from cached catalog rates', () => {
    const cached = buildCatalogPricingMap(
      catalog({ deepseek: { 'deepseek/deepseek-v4-pro': { input: 0.435, output: 0.87 } } }),
    );

    const lookup = createModelPricingLookup(undefined, cached);
    expect(lookup('deepseek', 'deepseek-v4-pro')).toEqual({
      inputPer1M: 0.435,
      outputPer1M: 0.87,
      cacheReadPer1M: undefined,
    });
  });

  test('reports a BYO provider miss so the caller can load the catalog', () => {
    const misses: string[] = [];
    const lookup = createModelPricingLookup(undefined, undefined, (p, m) =>
      misses.push(`${p}/${m}`),
    );
    expect(lookup('anthropic', 'claude-x')).toBeNull();
    expect(lookup('kortix', 'glm-5.3-flash')).toBeNull();
    expect(misses).toEqual(['anthropic/claude-x']);
  });

  test('does not report a miss once the catalog map is loaded', () => {
    const misses: string[] = [];
    const lookup = createModelPricingLookup(undefined, new Map(), (p, m) =>
      misses.push(`${p}/${m}`),
    );
    expect(lookup('anthropic', 'claude-x')).toBeNull();
    expect(misses).toEqual([]);
  });

  test('keeps managed pricing unavailable until the managed catalog loads', () => {
    const emptyLookup = createModelPricingLookup(undefined, new Map());
    expect(emptyLookup('kortix', 'glm-5.3-flash')).toBeNull();

    const cached = buildCatalogPricingMap(
      catalog({ 'z-ai': { 'z-ai/glm-5.3-flash': { input: 0.435, output: 0.87 } } }),
    );

    const loadedLookup = createModelPricingLookup(undefined, cached);
    expect(loadedLookup('kortix', 'glm-5.3-flash')).toBeNull();
  });
});

describe('model pricing source', () => {
  test('the browser never fetches models.dev', () => {
    const source = readFileSync(new URL('./model-pricing.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('models.dev/api.json');
  });
});
