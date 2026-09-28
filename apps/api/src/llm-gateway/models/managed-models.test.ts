import { describe, expect, test } from 'bun:test';

import { type ManagedModel, parseManagedModels, resolvePlatformDefaultModelId } from './managed-models';

describe('runtime managed model registry', () => {
  test('accepts a complete operator-defined managed-model replacement', () => {
    const configured = parseManagedModels(JSON.stringify([{
      id: 'operator-model',
      name: 'Operator Model',
      upstreamModelId: 'morph-model-v2',
      transport: 'openrouter',
      pricingRef: 'openrouter/morph-model-v2',
      openrouterProvider: { only: ['test-endpoint'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
      tier: 'balanced',
      vision: true,
      limit: { context: 64_000, output: 8_000 },
    }]));

    expect(configured).toEqual([expect.objectContaining({
      id: 'operator-model',
      upstreamModelId: 'morph-model-v2',
      vision: true,
    })]);
  });

  test('keeps text-only models in operator overlays', () => {
    const vision = {
      id: 'vision', name: 'Vision', upstreamModelId: 'z-ai/glm-5.3-flash',
      transport: 'openrouter', pricingRef: 'openrouter/z-ai/glm-5.3-flash',
      openrouterProvider: { only: ['test-endpoint'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
      tier: 'fast', vision: true, limit: { context: 1_000, output: 100 },
    };
    expect(parseManagedModels(JSON.stringify([{ ...vision, id: 'text', vision: false }, vision])))
      .toEqual([expect.objectContaining({ id: 'text', vision: false }), expect.objectContaining({ id: 'vision' })]);
  });

  test('accepts a ZDR OpenRouter pool without a direct upstream', () => {
    const pooled = {
      id: 'pooled', name: 'Pooled', upstreamModelId: 'z-ai/glm-5.3-flash',
      transport: 'openrouter', pricingRef: 'openrouter/z-ai/glm-5.3-flash',
      tier: 'fast', vision: true, limit: { context: 1_000, output: 100 },
      openrouterProvider: {
        only: ['decart/fp4', 'coreweave/nvfp4'], allow_fallbacks: true, zdr: true, data_collection: 'deny',
        max_price: { prompt: 0.15, completion: 0.5 },
      },
    };
    expect(parseManagedModels(JSON.stringify([pooled]))).toMatchObject([pooled]);
    const withMorph = { ...pooled, morphModelId: 'morph-glm53flash',
      morphPricing: { inputPerMillion: 0.1, outputPerMillion: 0.35 } };
    expect(parseManagedModels(JSON.stringify([withMorph]))).toMatchObject([withMorph]);
    expect(() => parseManagedModels(JSON.stringify([{ ...pooled, morphModelId: 'morph-glm53flash' }]))).toThrow();
    expect(() => parseManagedModels(JSON.stringify([{ ...pooled, morphPricing: withMorph.morphPricing }]))).toThrow();
  });

  test('rejects an unrestricted, non-ZDR, or data-collecting operator route', () => {
    const model = {
      id: 'unsafe', name: 'Unsafe', upstreamModelId: 'z-ai/glm-5.3-flash',
      transport: 'openrouter', pricingRef: 'openrouter/z-ai/glm-5.3-flash',
      tier: 'fast', vision: true, limit: { context: 1_000, output: 100 },
    };
    const route = { only: ['coreweave/nvfp4'], allow_fallbacks: true, zdr: true, data_collection: 'deny' };
    expect(() => parseManagedModels(JSON.stringify([model]))).toThrow();
    for (const unsafe of [
      { ...route, only: [] },
      { allow_fallbacks: true, zdr: true, data_collection: 'deny' },
      { ...route, zdr: false },
      { ...route, data_collection: 'allow' },
    ]) {
      expect(() => parseManagedModels(JSON.stringify([{ ...model, openrouterProvider: unsafe }]))).toThrow();
    }
    expect(() => parseManagedModels(JSON.stringify([{ ...model, morphModelId: '', openrouterProvider: route }]))).toThrow();
  });

  test('rejects an unknown managed transport', () => {
    expect(() => parseManagedModels(JSON.stringify([{
      id: 'retired-model',
      name: 'Retired Model',
      upstreamModelId: 'retired-model',
      transport: 'aster',
      pricingRef: 'vendor/retired-model',
      // A valid route, so the transport is the only fault.
      openrouterProvider: { only: ['test-endpoint'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
      tier: 'balanced',
      vision: false,
      limit: { context: 1_000, output: 1_000 },
    }]))).toThrow();
  });

  test('rejects malformed and duplicate managed-model definitions', () => {
    expect(() => parseManagedModels('{broken')).toThrow('must be valid JSON');
    const duplicate = {
      id: 'same',
      name: 'Same',
      upstreamModelId: 'morph-same',
      transport: 'openrouter',
      pricingRef: 'openrouter/morph-same',
      openrouterProvider: { only: ['test-endpoint'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
      tier: 'fast',
      vision: false,
      limit: { context: 1, output: 1 },
    };
    expect(() => parseManagedModels(JSON.stringify([duplicate, duplicate]))).toThrow('duplicate');
  });
});

const managed = (
  id: string,
  transport: ManagedModel['transport'],
  tier: ManagedModel['tier'] = 'balanced',
): ManagedModel => ({
  id,
  name: id,
  upstreamModelId: id,
  transport,
  pricingRef: id,
  tier,
  vision: false,
  limit: { context: 1_000, output: 1_000 },
});

describe('resolvePlatformDefaultModelId — the platform default must always be reachable', () => {
  const lineup = [
    managed('kimi-k3', 'openrouter', 'flagship'),
    managed('morph-dsv4flash', 'openrouter', 'fast'),
  ];

  test('keeps the configured default when it is actually served', () => {
    const served = [managed('morph-glm53-744b', 'openrouter'), ...lineup];
    expect(resolvePlatformDefaultModelId('morph-glm53-744b', served)).toBe('morph-glm53-744b');
  });

  test('maps an old Morph default to the equivalent served model', () => {
    expect(resolvePlatformDefaultModelId('morph-kimik3', lineup)).toBe('kimi-k3');
    const deepseek = managed('deepseek-v4.1-flash', 'openrouter');
    expect(resolvePlatformDefaultModelId('kortix/morph-dsv41flash', [deepseek])).toBe('deepseek-v4.1-flash');
  });

  test('falls back to the served flagship when the configured default is unreachable', () => {
    expect(resolvePlatformDefaultModelId('morph-glm53-744b', lineup)).toBe('kimi-k3');
  });

  test('accepts and preserves the opencode `kortix/<id>` ref form', () => {
    expect(resolvePlatformDefaultModelId('kortix/morph-glm53-744b', lineup)).toBe('kimi-k3');
    const served = [managed('morph-glm53-744b', 'openrouter'), ...lineup];
    expect(resolvePlatformDefaultModelId('kortix/morph-glm53-744b', served)).toBe('kortix/morph-glm53-744b');
  });

  test('falls back to the first served model when no flagship is served', () => {
    const noFlagship = [managed('morph-dsv4flash', 'openrouter', 'fast')];
    expect(resolvePlatformDefaultModelId('morph-glm53-744b', noFlagship)).toBe('morph-dsv4flash');
  });

  test('leaves a BYOK default untouched — it resolves from a project key, not a managed transport', () => {
    expect(resolvePlatformDefaultModelId('anthropic/claude-opus-4-8', lineup)).toBe(
      'anthropic/claude-opus-4-8',
    );
  });

  test('leaves the configured default unchanged when nothing managed is served at all', () => {
    expect(resolvePlatformDefaultModelId('morph-glm53-744b', [])).toBe('morph-glm53-744b');
    expect(resolvePlatformDefaultModelId('', [])).toBe('');
  });
});
