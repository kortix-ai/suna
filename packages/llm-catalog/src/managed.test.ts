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
      'claude-opus-5.5', 'gpt-6-sol', 'gpt-6-luna',
      'anthropic/claude-opus-4.8', 'nope',
    ]) {
      expect(getManagedModel(old)).toBeUndefined();
      expect(isManagedModelId(old)).toBe(false);
    }
    expect(getManagedModel('deepseek-v4.1-flash')?.name).toBe('DeepSeek V4.1 Flash');
  });
});

// Product rule: Kortix-managed models are open-weight models only. OpenAI and
// Anthropic models reach members through BYOK (`openai/…`, `anthropic/…`) or a
// ChatGPT plan (`codex/…`), never through Kortix credits. Claude Opus 5.5,
// GPT-6 Sol, GPT-6 Luna and GPT-6 Astra were each added as managed and removed.
describe('OpenAI and Anthropic models are never Kortix-managed', () => {
  test('no managed model routes to an OpenAI or Anthropic upstream', () => {
    for (const model of MANAGED_MODELS) {
      expect(model.upstreamModelId, model.id).not.toMatch(/^(openai|anthropic)\//);
      expect(model.id, model.id).not.toMatch(/^(gpt|claude|o\d)/);
    }
  });
});

// The BYOK and ChatGPT routes read these bundled records for temperature and
// reasoning_options (released 2026-09-22).
describe('GPT-6 Sol, GPT-6 Luna and Claude Opus 5.5 BYOK and ChatGPT records', () => {
  test.each([
    ['codex/gpt-6-sol', 'GPT-6 Sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['codex/gpt-6-luna', 'GPT-6 Luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max']],
    ['anthropic/claude-opus-5-5', 'Claude Opus 5.5', ['low', 'medium', 'high', 'xhigh', 'max']],
  ])('%s resolves to its bundled catalog record', (wireId, name, efforts) => {
    const record = catalogModelForWireModel(wireId, CATALOG);
    expect(record?.name).toBe(name);
    expect(record?.modalities?.input).toContain('image');
    expect(record?.tool_call).toBe(true);
    expect(record?.reasoning_options).toContainEqual({ type: 'effort', values: efforts });
  });

  test('the GPT-6 records reject a client temperature', () => {
    for (const wireId of ['codex/gpt-6-sol', 'codex/gpt-6-luna']) {
      expect(catalogModelForWireModel(wireId, CATALOG)?.temperature).toBe(false);
    }
  });
});
