import { describe, expect, test } from 'bun:test';

import { hasModelsFrom, planAction } from './plan-action';

const ready = { hasOwnKey: false, hasKortixModels: true };

describe('planAction', () => {
  test('Kortix models open the project when they are ready', () => {
    expect(planAction('kortix', ready)).toBe('open');
  });

  test('Kortix models without access lead to plans', () => {
    expect(planAction('kortix', { hasOwnKey: false, hasKortixModels: false })).toBe('seePlans');
  });

  test('own key asks for a key while none is connected', () => {
    expect(planAction('byok', ready)).toBe('addKey');
  });

  // THE reported bug: a key was added and the button still said "Add a key".
  // The label came from the radio choice alone.
  test('own key opens the project once a key is connected', () => {
    expect(planAction('byok', { hasOwnKey: true, hasKortixModels: true })).toBe('open');
  });
});

describe('hasModelsFrom', () => {
  const models = [
    { providerID: 'kortix', enabled: true },
    { providerID: 'anthropic', enabled: false },
    { providerID: 'openai' },
  ];

  test('splits offered models into Kortix and own-key', () => {
    expect(hasModelsFrom(models)).toEqual({ hasKortixModels: true, hasOwnKey: true });
  });

  test('a model the server did not offer does not count', () => {
    expect(hasModelsFrom([{ providerID: 'anthropic', enabled: false }])).toEqual({
      hasKortixModels: false,
      hasOwnKey: false,
    });
  });
});
