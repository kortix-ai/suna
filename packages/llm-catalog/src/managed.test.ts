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

  test('every managed model has explicit credit pricing and never shows an upstream brand', () => {
    for (const model of MANAGED_MODELS) {
      expect(model.pricing?.inputPerMillion).toBeGreaterThan(0);
      expect(model.pricing?.outputPerMillion).toBeGreaterThan(0);
      expect(model.providerBrand).toBeUndefined();
    }
  });

  // Morph direct is the primary upstream. The OpenRouter pool is the fallback.
  test.each([
    ['glm-5.3-flash', 'morph-glm53flash', { inputPerMillion: 0.1, cachedInputPerMillion: 0.02, outputPerMillion: 0.35 }],
    ['deepseek-v4.1-flash', 'morph-dsv41flash', { inputPerMillion: 0.15, cachedInputPerMillion: 0.0359375, outputPerMillion: 0.6 }],
    ['kimi-k3', 'morph-kimik3', { inputPerMillion: 2.5, cachedInputPerMillion: 0.29, outputPerMillion: 14 }],
  ])('%s routes to Morph first and bills Morph list prices', (id, morphModelId, pricing) => {
    expect(getManagedModel(id)).toMatchObject({ morphModelId, pricing });
  });

  test('every OpenRouter fallback is a ZDR pool with fallbacks inside the pool and a price cap', () => {
    for (const model of MANAGED_MODELS) {
      expect(model.transport).toBe('openrouter');
      const route = model.openrouterProvider as {
        only: string[]; allow_fallbacks: boolean; zdr: boolean; data_collection: string;
        max_price: { prompt: number; completion: number };
      };
      expect(route).toMatchObject({ allow_fallbacks: true, zdr: true, data_collection: 'deny' });
      expect(route.only.length, model.id).toBeGreaterThanOrEqual(5);
      expect(new Set(route.only).size, model.id).toBe(route.only.length);
      // Morph's own OpenRouter endpoint is listed first so the fallback keeps
      // the primary's weights when Morph direct fails on our key only.
      expect(route.only[0], model.id).toBe('morph');
      expect(route.max_price.prompt).toBeGreaterThanOrEqual(model.pricing!.inputPerMillion);
      expect(route.max_price.completion).toBeGreaterThanOrEqual(model.pricing!.outputPerMillion);
    }
  });

  test('fallback pools exclude endpoints that failed the 2026-09-24 residency or image probes', () => {
    const only = (id: string) => (getManagedModel(id)?.openrouterProvider as { only: string[] }).only;
    // Non-US or unknown provider location.
    for (const id of ['glm-5.3-flash', 'deepseek-v4.1-flash', 'kimi-k3']) {
      for (const tag of ['z-ai/fp8', 'siliconflow/fp8', 'inceptron/fp8', 'nextbit/fp8', 'moonshotai/mxfp4', 'dekallm', 'relace', 'near-ai/fp8', 'digitalocean', 'reka/fp8', 'makora']) {
        expect(only(id), `${id} ${tag}`).not.toContain(tag);
      }
    }
    // HTTP 200 with the image ignored.
    expect(only('deepseek-v4.1-flash')).not.toContain('coreweave/fp8');
    expect(only('deepseek-v4.1-flash')).not.toContain('novita/fp8');
    // HTTP 400 on image input.
    expect(only('glm-5.3-flash')).not.toContain('venice');
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
