import { describe, expect, test } from 'bun:test';

import {
  type ManagedModel,
  RUNTIME_MANAGED_MODELS,
  getRuntimeManagedModel,
  isRuntimeManagedModelId,
  parseManagedModels,
  resolvePlatformDefaultModelId,
  servedManagedModels,
} from './managed-models';

describe('runtime managed model registry', () => {
  test('exposes the configured control-plane overlay through one lookup', () => {
    expect(RUNTIME_MANAGED_MODELS.length).toBeGreaterThan(0);
    const first = RUNTIME_MANAGED_MODELS[0]!;
    expect(getRuntimeManagedModel(first.id)).toBe(first);
    expect(isRuntimeManagedModelId(first.id)).toBe(true);
    expect(isRuntimeManagedModelId('not-managed')).toBe(false);
  });

  test('accepts a complete operator-defined managed-model replacement', () => {
    const configured = parseManagedModels(JSON.stringify([{
      id: 'operator-model',
      name: 'Operator Model',
      upstreamModelId: 'vendor/model-v2',
      transport: 'openrouter',
      pricingRef: 'vendor/model-v2',
      tier: 'balanced',
      vision: true,
      limit: { context: 64_000, output: 8_000 },
      openrouterProvider: { order: ['Vendor'] },
    }]));

    expect(configured).toEqual([expect.objectContaining({
      id: 'operator-model',
      upstreamModelId: 'vendor/model-v2',
      vision: true,
    })]);
  });

  test('rejects the retired AsterLab transport', () => {
    expect(() => parseManagedModels(JSON.stringify([{
      id: 'retired-model',
      name: 'Retired Model',
      upstreamModelId: 'retired-model',
      transport: 'aster',
      pricingRef: 'vendor/retired-model',
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
      upstreamModelId: 'vendor/same',
      transport: 'openrouter',
      pricingRef: 'vendor/same',
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

describe('servedManagedModels — never offer a managed model with no upstream credential', () => {
  const lineup = [
    managed('claude-opus-4.8', 'bedrock', 'flagship'),
    managed('glm-5.3-flash', 'openrouter'),
    managed('deepseek-v4-flash', 'openrouter', 'fast'),
  ];

  test('drops every model whose transport has no configured credential', () => {
    const served = servedManagedModels(lineup, (m) => m.id !== 'glm-5.3-flash');
    expect(served.map((m) => m.id)).toEqual(['claude-opus-4.8', 'deepseek-v4-flash']);
  });

  test('keeps the whole lineup when every transport is credentialed', () => {
    expect(servedManagedModels(lineup, () => true).map((m) => m.id)).toEqual([
      'claude-opus-4.8',
      'glm-5.3-flash',
      'deepseek-v4-flash',
    ]);
  });

  test('returns nothing when no transport is credentialed', () => {
    expect(servedManagedModels(lineup, () => false)).toEqual([]);
  });
});

describe('resolvePlatformDefaultModelId — the platform default must always be reachable', () => {
  const lineup = [
    managed('claude-opus-4.8', 'bedrock', 'flagship'),
    managed('deepseek-v4-flash', 'openrouter', 'fast'),
  ];

  test('keeps the configured default when it is actually served', () => {
    const served = [managed('glm-5.2', 'openrouter'), ...lineup];
    expect(resolvePlatformDefaultModelId('glm-5.2', served)).toBe('glm-5.2');
  });

  test('falls back to the served flagship when the configured default is unreachable', () => {
    expect(resolvePlatformDefaultModelId('glm-5.2', lineup)).toBe('claude-opus-4.8');
  });

  test('accepts and preserves the opencode `kortix/<id>` ref form', () => {
    expect(resolvePlatformDefaultModelId('kortix/glm-5.2', lineup)).toBe('claude-opus-4.8');
    const served = [managed('glm-5.2', 'openrouter'), ...lineup];
    expect(resolvePlatformDefaultModelId('kortix/glm-5.2', served)).toBe('kortix/glm-5.2');
  });

  test('falls back to the first served model when no flagship is served', () => {
    const noFlagship = [managed('deepseek-v4-flash', 'openrouter', 'fast')];
    expect(resolvePlatformDefaultModelId('glm-5.2', noFlagship)).toBe('deepseek-v4-flash');
  });

  test('leaves a BYOK default untouched — it resolves from a project key, not a managed transport', () => {
    expect(resolvePlatformDefaultModelId('anthropic/claude-opus-4-8', lineup)).toBe(
      'anthropic/claude-opus-4-8',
    );
  });

  test('leaves the configured default unchanged when nothing managed is served at all', () => {
    expect(resolvePlatformDefaultModelId('glm-5.2', [])).toBe('glm-5.2');
    expect(resolvePlatformDefaultModelId('', [])).toBe('');
  });
});
