import { describe, expect, test } from 'bun:test';
import { getManagedModel } from '@kortix/llm-catalog';

import { codexModelIds } from '../models/codex-models';

import {
  DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES,
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

  // The shipped default must route only to ids the platform can serve, and a
  // fallback must never be the model it backs up.
  test('the default policies route between servable models, never a model to itself', () => {
    const policies = parseFallbackPolicies(DEFAULT_LLM_GATEWAY_FALLBACK_POLICIES);
    expect(policies.length).toBeGreaterThan(0);
    const servable = (id: string) =>
      getManagedModel(id) !== undefined || (id.startsWith('codex/') && codexModelIds().includes(id.slice(6)));
    for (const policy of policies) {
      expect([...policy.models, ...policy.fallbackModels].filter((id) => !servable(id))).toEqual([]);
      expect(policy.fallbackModels.filter((id) => policy.models.includes(id))).toEqual([]);
    }
  });
});
