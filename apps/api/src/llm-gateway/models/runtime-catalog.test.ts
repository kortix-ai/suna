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
