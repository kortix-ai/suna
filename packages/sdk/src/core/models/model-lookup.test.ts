import { expect, test } from 'bun:test';

import { createModelLookup } from './model-lookup';

test('indexes model metadata once by provider and model id', () => {
  const first = {
    providerID: 'kortix',
    providerName: 'Kortix',
    modelID: 'glm-5.3-flash',
    modelName: 'GLM 5.3 Flash',
  };
  const second = {
    providerID: 'kortix',
    providerName: 'Kortix',
    modelID: 'codex/gpt-5.6-sol',
    modelName: 'GPT-5.6 Sol',
  };
  const lookup = createModelLookup([first, second]);

  expect(lookup.get('kortix:glm-5.3-flash')).toBe(first);
  expect(lookup.get('kortix:codex/gpt-5.6-sol')).toBe(second);
  expect(lookup.get('kortix:missing')).toBeUndefined();
});
