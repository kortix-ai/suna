import { describe, expect, test } from 'bun:test';
import {
  CATALOG,
  DEFAULT_MANAGED_MODEL_IDS,
  MANAGED_FLAGSHIP_MODEL_ID,
  MANAGED_MODELS,
  PLATFORM_DEFAULT_MODEL_ID,
  catalogModelForWireModel,
  getManagedModel,
  isManagedModelId,
} from './index';

const served = [
  'deepseek-v4.1-flash',
  'glm-5.3-flash',
  'kimi-k3',
  'claude-opus-5.5',
  'gpt-6-sol',
  'gpt-6-luna',
];

// Every bundled route pins a ZDR endpoint. Vision is per model.
describe('managed catalog', () => {
  test('serves the selected managed models', () => {
    expect(DEFAULT_MANAGED_MODEL_IDS).toEqual(served);
    expect(PLATFORM_DEFAULT_MODEL_ID).toBe('deepseek-v4.1-flash');
    expect(MANAGED_FLAGSHIP_MODEL_ID).toBe('kimi-k3');
  });

  test('every managed model has explicit credit pricing and a pinned ZDR route', () => {
    for (const model of MANAGED_MODELS) {
      expect(model.pricing?.inputPerMillion).toBeGreaterThan(0);
      expect(model.pricing?.outputPerMillion).toBeGreaterThan(0);
      expect(model.providerBrand).toBeUndefined();
    }
    expect(getManagedModel('glm-5.3-flash')).toMatchObject({
      name: 'GLM 5.3 Flash',
      upstreamModelId: 'z-ai/glm-5.3-flash',
      transport: 'openrouter',
      openrouterProvider: {
        only: ['coreweave/nvfp4'],
        allow_fallbacks: false,
        zdr: true,
        data_collection: 'deny',
      },
    });
    for (const model of MANAGED_MODELS) {
      expect(model.transport).toBe('openrouter');
      expect(model.openrouterProvider).toMatchObject({
        only: [expect.any(String)], allow_fallbacks: false, zdr: true, data_collection: 'deny',
      });
    }
  });

  test('DeepSeek cache-read rate matches its pinned OpenRouter endpoint', () => {
    expect(getManagedModel('deepseek-v4.1-flash')?.pricing?.cachedInputPerMillion).toBe(0.006);
    expect(getManagedModel('kimi-k3')).toMatchObject({
      upstreamModelId: 'moonshotai/kimi-k3',
      openrouterProvider: { only: ['wafer'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
    });
    expect(getManagedModel('morph-dsv4flash')).toBeUndefined();
  });

  test('old Kortix managed IDs and BYOK refs do not resolve as managed', () => {
    for (const old of [
      'grok-4.6', 'deepseek-v4-flash', 'muse-spark-1.2',
      'deepseek-v4-flash-0731', 'deepseek-v4-pro-0813', 'kimi-k3-fast',
      'minimax-m3', 'gpt-5.6-luna', 'gpt-6-astra',
      'anthropic/claude-opus-4.8', 'nope',
    ]) {
      expect(getManagedModel(old)).toBeUndefined();
      expect(isManagedModelId(old)).toBe(false);
    }
    expect(getManagedModel('deepseek-v4.1-flash')?.name).toBe('DeepSeek V4.1 Flash');
  });
});

// GPT-6 Sol, GPT-6 Luna and Claude Opus 5.5 (released 2026-09-22). Each route is
// the model's US zero-data-retention endpoint in OpenRouter's ZDR feed, and each
// rate is that endpoint's own price, read from the feed on 2026-09-23.
describe('frontier models on pinned US ZDR endpoints', () => {
  test('GPT-6 Sol routes to Azure US with its above-272k tier', () => {
    expect(getManagedModel('gpt-6-sol')).toEqual({
      id: 'gpt-6-sol',
      name: 'GPT-6 Sol',
      upstreamModelId: 'openai/gpt-6-sol',
      transport: 'openrouter',
      pricingRef: 'openrouter/openai/gpt-6-sol',
      pricing: {
        inputPerMillion: 2.2,
        cachedInputPerMillion: 0.22,
        cacheWritePerMillion: 2.75,
        outputPerMillion: 11,
        contextOver200k: {
          contextThreshold: 272_000,
          inputPerMillion: 4.4,
          cachedInputPerMillion: 0.44,
          cacheWritePerMillion: 5.5,
          outputPerMillion: 16.5,
        },
      },
      tier: 'balanced',
      vision: true,
      limit: { context: 1_050_000, output: 128_000 },
      openrouterProvider: { only: ['azure/us'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
    });
  });

  test('GPT-6 Luna routes to Azure US with its above-272k tier', () => {
    expect(getManagedModel('gpt-6-luna')).toEqual({
      id: 'gpt-6-luna',
      name: 'GPT-6 Luna',
      upstreamModelId: 'openai/gpt-6-luna',
      transport: 'openrouter',
      pricingRef: 'openrouter/openai/gpt-6-luna',
      pricing: {
        inputPerMillion: 0.11,
        cachedInputPerMillion: 0.011,
        cacheWritePerMillion: 0.1375,
        outputPerMillion: 0.55,
        contextOver200k: {
          contextThreshold: 272_000,
          inputPerMillion: 0.22,
          cachedInputPerMillion: 0.022,
          cacheWritePerMillion: 0.275,
          outputPerMillion: 0.825,
        },
      },
      tier: 'fast',
      vision: true,
      limit: { context: 1_050_000, output: 128_000 },
      openrouterProvider: { only: ['azure/us'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
    });
  });

  test('Claude Opus 5.5 routes to Amazon Bedrock us-east-1', () => {
    expect(getManagedModel('claude-opus-5.5')).toEqual({
      id: 'claude-opus-5.5',
      name: 'Claude Opus 5.5',
      upstreamModelId: 'anthropic/claude-opus-5.5',
      transport: 'openrouter',
      pricingRef: 'openrouter/anthropic/claude-opus-5.5',
      pricing: {
        inputPerMillion: 4.4,
        cachedInputPerMillion: 0.22,
        cacheWritePerMillion: 5.5,
        outputPerMillion: 22,
      },
      tier: 'flagship',
      vision: true,
      limit: { context: 1_000_000, output: 128_000 },
      openrouterProvider: {
        only: ['amazon-bedrock/us-east-1'], allow_fallbacks: false, zdr: true, data_collection: 'deny',
      },
    });
  });

  test('adding them keeps the default and the flagship fallback unchanged', () => {
    expect(PLATFORM_DEFAULT_MODEL_ID).toBe('deepseek-v4.1-flash');
    expect(MANAGED_FLAGSHIP_MODEL_ID).toBe('kimi-k3');
  });

  // The served catalog takes temperature and reasoning_options from these
  // records. Without them a managed id falls back to a synthetic record that
  // claims temperature support, and these models reject a client temperature.
  test.each([
    ['gpt-6-sol', 'GPT-6 Sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['gpt-6-luna', 'GPT-6 Luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['codex/gpt-6-sol', 'GPT-6 Sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['codex/gpt-6-luna', 'GPT-6 Luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['claude-opus-5.5', 'Claude Opus 5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
    ['anthropic/claude-opus-5-5', 'Claude Opus 5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ])('%s resolves to its bundled catalog record', (wireId, name, efforts) => {
    const record = catalogModelForWireModel(wireId, CATALOG);
    expect(record?.name).toBe(name);
    expect(record?.modalities?.input).toContain('image');
    expect(record?.tool_call).toBe(true);
    expect(record?.reasoning_options).toContainEqual({ type: 'effort', values: efforts });
  });

  test('the GPT-6 records reject a client temperature', () => {
    for (const wireId of ['gpt-6-sol', 'gpt-6-luna', 'codex/gpt-6-sol', 'codex/gpt-6-luna']) {
      expect(catalogModelForWireModel(wireId, CATALOG)?.temperature).toBe(false);
    }
  });
});
