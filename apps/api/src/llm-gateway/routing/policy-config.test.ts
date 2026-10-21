import { describe, expect, test } from 'bun:test';
import { TEST_MANAGED_LINEUP } from '../../__tests__/fixtures/managed-lineup';

import { CODEX_SEED_MODEL_IDS } from '../models/codex-models';

import {
  CODEX_DEFAULT_MODEL,
  DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES,
  effectiveFallbackPolicies,
  parseFallbackPolicies,
} from './policy-config';

describe('gateway fallback policy configuration', () => {
  test('accepts arbitrary operator-defined model ids and ordered fallbacks', () => {
    expect(parseFallbackPolicies(JSON.stringify([{
      id: 'operator-policy',
      models: ['vendor/model-a', 'vendor/model-b'],
      fallbackModels: ['other/model-c', 'last/model-d'],
      fallbackOn: 'any-error',
    }]))).toEqual([{
      id: 'operator-policy',
      models: ['vendor/model-a', 'vendor/model-b'],
      fallbackModels: ['other/model-c', 'last/model-d'],
      fallbackOn: 'any-error',
    }]);
  });

  test('rejects malformed JSON', () => {
    expect(() => parseFallbackPolicies('{not json')).toThrow('must be valid JSON');
  });

  // One fault per row, from a valid base, so each rule is proven on its own.
  const valid = { id: 'policy', models: ['vendor/model-a'], fallbackModels: ['vendor/model-b'], fallbackOn: 'transient' };
  test.each([
    ['an empty id', { id: '' }, 'id'],
    ['no owned model', { models: [] }, 'models'],
    ['an empty owned model id', { models: [''] }, 'models'],
    ['an empty fallback model id', { fallbackModels: [''] }, 'fallbackModels'],
    ['an unknown fallbackOn', { fallbackOn: 'sometimes' }, 'fallbackOn'],
  ])('rejects %s', (_name, fault, field) => {
    let issues: Array<{ path: Array<string | number> }> = [];
    try {
      parseFallbackPolicies(JSON.stringify([{ ...valid, ...fault }]));
    } catch (err) {
      issues = JSON.parse((err as Error).message);
    }
    expect(issues.map((issue) => issue.path[1])).toEqual([field]);
  });

  test('rejects ambiguous ownership of one model by multiple policies', () => {
    expect(() => parseFallbackPolicies(JSON.stringify([
      {
        id: 'first',
        models: ['shared/model'],
        fallbackModels: [],
        fallbackOn: 'transient',
      },
      {
        id: 'second',
        models: ['shared/model'],
        fallbackModels: [],
        fallbackOn: 'any-error',
      },
    ]))).toThrow('shared/model');
  });

  test('no operator policy ships by default: managed fallbacks are derived', () => {
    expect(parseFallbackPolicies(DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES)).toEqual([]);
  });

  // Derived from the lineup Platinum lists, never from hardcoded ids.
  test('each served model falls back to the others, in Platinum order, never to itself', () => {
    const ids = TEST_MANAGED_LINEUP.map((m) => m.id);
    const policies = effectiveFallbackPolicies([], ids);
    for (const id of ids) {
      const policy = policies.find((p) => p.models.includes(id))!;
      expect(policy.fallbackModels).toEqual(ids.filter((other) => other !== id));
      expect(policy.fallbackOn).toBe('transient');
    }
    expect(CODEX_SEED_MODEL_IDS).toContain(CODEX_DEFAULT_MODEL.slice('codex/'.length));
    expect(policies.find((p) => p.models.includes(CODEX_DEFAULT_MODEL))).toMatchObject({ fallbackModels: ids, fallbackOn: 'any-error' });
  });

  test('a model Platinum adds gets a fallback with no code change; one served model has no peer fallback', () => {
    expect(effectiveFallbackPolicies([], ['a', 'b', 'qwen-x']).find((p) => p.models.includes('qwen-x'))?.fallbackModels).toEqual(['a', 'b']);
    expect(effectiveFallbackPolicies([], ['a']).filter((p) => p.models.includes('a'))).toEqual([]);
    expect(effectiveFallbackPolicies([], [])).toEqual([]);
  });

  test('an operator policy that owns a model wins over the derived one', () => {
    const operator = [{ id: 'op', models: ['a'], fallbackModels: ['x/y'], fallbackOn: 'any-error' as const }];
    const policies = effectiveFallbackPolicies(operator, ['a', 'b']);
    expect(policies.filter((p) => p.models.includes('a'))).toEqual(operator);
    expect(policies.find((p) => p.models.includes('b'))?.fallbackModels).toEqual(['a']);
  });
});
