import { describe, expect, test } from 'bun:test';

import type { Catalog } from '@kortix/llm-catalog';
import { createRuntimeModelCatalog } from './runtime-catalog';

const seed: Catalog = {
  source: 'bundled-test',
  fetched_at: '2026-01-01T00:00:00.000Z',
  provider_count: 1,
  model_count: 1,
  providers: [{
    id: 'seed-provider',
    name: 'Seed Provider',
    env: ['SEED_API_KEY'],
    api: 'https://seed.test/v1',
    npm: '@ai-sdk/openai-compatible',
    models: [{ id: 'seed-model', name: 'Seed Model' }],
  }],
};

describe('runtime model catalog', () => {
  test('refreshes the catalog from the configured API and atomically replaces the seed', async () => {
    const catalog = createRuntimeModelCatalog({
      seed,
      sourceUrl: 'https://catalog.test/api.json',
      fetchImpl: async () => new Response(JSON.stringify({
        live: {
          id: 'live',
          name: 'Live Provider',
          env: ['LIVE_API_KEY'],
          api: 'https://live.test/v1',
          npm: '@ai-sdk/openai-compatible',
          models: {
            'live-model': {
              id: 'live-model',
              name: 'Live Model',
              release_date: '2026-07-01',
              reasoning: true,
              tool_call: true,
              attachment: false,
              temperature: true,
              limit: { context: 128_000, output: 16_000 },
            },
          },
        },
      }), { status: 200 }),
    });

    expect(catalog.status().source).toBe('seed');
    expect(await catalog.refresh()).toBe(true);
    expect(catalog.status()).toMatchObject({
      source: 'api',
      sourceUrl: 'https://catalog.test/api.json',
      providerCount: 1,
      modelCount: 1,
    });
    expect(catalog.snapshot().providers[0]?.models[0]).toMatchObject({
      id: 'live-model',
      released: '2026-07-01',
      reasoning: true,
      limit: { context: 128_000, output: 16_000 },
    });
  });

  // The live refresh path (normalizeCatalog) must mirror the SAME field set as
  // the baked-snapshot enrich script (apps/web/scripts/
  // enrich-llm-catalog-capabilities.ts) — a live/baked shape drift silently
  // loses data for whichever path a deployment happens to be serving from.
  test('mirrors the full enriched field set from a live models.dev-shaped response', async () => {
    const catalog = createRuntimeModelCatalog({
      seed,
      sourceUrl: 'https://catalog.test/api.json',
      fetchImpl: async () => new Response(JSON.stringify({
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic',
          env: ['ANTHROPIC_API_KEY'],
          api: 'https://api.anthropic.com/v1',
          npm: '@ai-sdk/anthropic',
          models: {
            'claude-opus-4-8': {
              id: 'claude-opus-4-8',
              name: 'Claude Opus 4.8',
              description: 'Top Claude Opus tier',
              release_date: '2026-05-28',
              last_updated: '2026-05-28',
              reasoning: true,
              reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
              tool_call: true,
              attachment: true,
              temperature: false,
              structured_output: true,
              interleaved: true,
              open_weights: false,
              knowledge: '2026-01',
              family: 'claude-opus',
              modalities: { input: ['text', 'image'], output: ['text'] },
              limit: { context: 1_000_000, input: 900_000, output: 128_000 },
              cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
            },
          },
        },
      }), { status: 200 }),
    });

    expect(await catalog.refresh()).toBe(true);
    const model = catalog.snapshot().providers[0]?.models[0];
    expect(model).toMatchObject({
      id: 'claude-opus-4-8',
      description: 'Top Claude Opus tier',
      last_updated: '2026-05-28',
      structured_output: true,
      interleaved: true,
      open_weights: false,
      knowledge: '2026-01',
      family: 'claude-opus',
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 1_000_000, input: 900_000, output: 128_000 },
      cost: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 },
      reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
    });
  });

  // MUST-FIX regression (adversarial review of PR #5010): this file's header
  // comment promises the live refresh path and the baked-snapshot enrich
  // script (apps/web/scripts/enrich-llm-catalog-capabilities.ts)
  // "must never diverge in SHAPE, only in freshness". Before this fix, the
  // live path passed `reasoning_options` through RAW/unfiltered while the
  // baked path's `normalizeReasoningOptions` silently dropped any entry
  // without `values` (the `budget_tokens`/`toggle` shapes) — so a
  // budget_tokens model (mainline Claude's ONLY shape) came out
  // `[{type:'budget_tokens', min:1024}]` live but `undefined` baked: same
  // model, two different shapes depending on which path served it. Assert
  // the live path's raw passthrough matches EXACTLY what the enrich script
  // would normalize the same input to for a budget_tokens entry — i.e. the
  // object survives verbatim on both paths, not just on live.
  test('a budget_tokens reasoning_options entry survives the live path in the SAME shape the baked enrich script normalizes it to', async () => {
    const rawBudgetTokensOption = { type: 'budget_tokens', min: 1024 };
    const catalog = createRuntimeModelCatalog({
      seed,
      sourceUrl: 'https://catalog.test/api.json',
      fetchImpl: async () => new Response(JSON.stringify({
        anthropic: {
          id: 'anthropic',
          name: 'Anthropic',
          env: ['ANTHROPIC_API_KEY'],
          models: {
            'claude-haiku-4-5': {
              id: 'claude-haiku-4-5',
              name: 'Claude Haiku 4.5',
              reasoning: true,
              reasoning_options: [rawBudgetTokensOption],
              temperature: true,
            },
          },
        },
      }), { status: 200 }),
    });

    expect(await catalog.refresh()).toBe(true);
    const model = catalog.snapshot().providers[0]?.models[0];
    // The live path's raw passthrough (no `values` filtering).
    expect(model?.reasoning_options).toEqual([{ type: 'budget_tokens', min: 1024 }]);

    // What the baked-snapshot enrich script's normalizeReasoningOptions
    // produces for the IDENTICAL raw input — mirrors that function's field
    // selection exactly (type, then values/min/max only when present) so a
    // divergence in either implementation fails this test.
    const bakedShapeForSameInput = [rawBudgetTokensOption]
      .filter((option) => typeof option?.type === 'string')
      .map((option: { type: string; values?: string[]; min?: number; max?: number }) => ({
        type: option.type,
        ...(Array.isArray(option.values) ? { values: option.values } : {}),
        ...(typeof option.min === 'number' ? { min: option.min } : {}),
        ...(typeof option.max === 'number' ? { max: option.max } : {}),
      }));
    expect(model?.reasoning_options).toEqual(bakedShapeForSameInput);
  });

  test('keeps the last known catalog when the API is unavailable', async () => {
    const catalog = createRuntimeModelCatalog({
      seed,
      sourceUrl: 'https://catalog.test/api.json',
      fetchImpl: async () => new Response('down', { status: 503 }),
    });

    expect(await catalog.refresh()).toBe(false);
    expect(catalog.snapshot()).toBe(seed);
    expect(catalog.status()).toMatchObject({ source: 'seed', lastError: 'HTTP 503' });
  });
});
