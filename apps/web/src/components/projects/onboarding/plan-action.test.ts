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

  // Gateway projects serve every model under ONE provider, `kortix`; the real
  // vendor is the model's own `provider`. Reading only `providerID` counted an
  // own Anthropic key as Kortix models, so "Add a key" never went away.
  test('reads the vendor from a gateway model, not the gateway provider id', () => {
    expect(
      hasModelsFrom([
        { providerID: 'kortix', provider: 'kortix', enabled: true },
        { providerID: 'kortix', provider: 'anthropic', enabled: true },
      ]),
    ).toEqual({ hasKortixModels: true, hasOwnKey: true });
    expect(hasModelsFrom([{ providerID: 'kortix', provider: 'kortix' }])).toEqual({
      hasKortixModels: true,
      hasOwnKey: false,
    });
  });
});

describe('planAction with the account billing state', () => {
  // A plan with a $0 wallet still lists Kortix models. The upgrade dialog, not
  // "Open workspace", is the next step for that account.
  test('Kortix models on an account that cannot run lead to plans', () => {
    expect(
      planAction('kortix', { hasOwnKey: false, hasKortixModels: true, kortixRunnable: false }),
    ).toBe('seePlans');
  });

  test('Kortix models on a runnable account open the project', () => {
    expect(
      planAction('kortix', { hasOwnKey: false, hasKortixModels: true, kortixRunnable: true }),
    ).toBe('open');
  });

  // An own key is never wallet-gated.
  test('an own key opens the project whatever the wallet says', () => {
    expect(
      planAction('byok', { hasOwnKey: true, hasKortixModels: true, kortixRunnable: false }),
    ).toBe('open');
  });
});
