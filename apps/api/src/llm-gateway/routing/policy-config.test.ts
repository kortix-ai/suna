import { describe, expect, test } from 'bun:test';

import { parseFallbackPolicies } from './policy-config';

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

  test('rejects malformed JSON and malformed policy shapes', () => {
    expect(() => parseFallbackPolicies('{not json')).toThrow('must be valid JSON');
    expect(() => parseFallbackPolicies(JSON.stringify([{
      id: '',
      models: [],
      fallbackModels: ['ok'],
      fallbackOn: 'sometimes',
    }]))).toThrow();
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
});
