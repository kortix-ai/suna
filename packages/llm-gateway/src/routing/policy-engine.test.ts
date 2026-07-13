import { describe, expect, test } from 'bun:test';

import { createModelFallbackPolicyEngine } from './policy-engine';

describe('createModelFallbackPolicyEngine', () => {
  test('matches declarative policies without knowing any product model ids', () => {
    const engine = createModelFallbackPolicyEngine([
      {
        id: 'premium-degrade',
        models: ['model-a', 'model-b'],
        fallbackModels: ['model-c', 'model-d'],
        fallbackOn: 'any-error',
      },
    ]);

    expect(engine.route('model-b')).toEqual({
      policyId: 'premium-degrade',
      fallbackModels: ['model-c', 'model-d'],
      fallbackOn: 'any-error',
    });
    expect(engine.route('unconfigured')).toBeNull();
  });

  test('rejects duplicate policy ownership for one model', () => {
    expect(() => createModelFallbackPolicyEngine([
      {
        id: 'first',
        models: ['model-a'],
        fallbackModels: ['model-b'],
        fallbackOn: 'transient',
      },
      {
        id: 'second',
        models: ['model-a'],
        fallbackModels: ['model-c'],
        fallbackOn: 'any-error',
      },
    ])).toThrow('model-a');
  });
});
