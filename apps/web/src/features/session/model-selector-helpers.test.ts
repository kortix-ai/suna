import { describe, expect, test } from 'bun:test';

import { modelSelectorContextLine, pickerGroupId } from './model-selector-helpers';
import type { FlatModel } from './session-chat-input';

function model(overrides: Partial<FlatModel>): FlatModel {
  return {
    providerID: 'kortix',
    providerName: 'Kortix',
    modelID: 'claude-sonnet-4-6',
    modelName: 'Claude Sonnet 4.6',
    ...overrides,
  };
}

describe('pickerGroupId', () => {
  test('non-gateway models group under their own provider id', () => {
    expect(pickerGroupId(model({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' }))).toBe(
      'anthropic',
    );
  });

  test('managed default ids stay grouped under kortix even though the id has no slash', () => {
    expect(pickerGroupId(model({ providerID: 'kortix', modelID: 'auto' }))).toBe('kortix');
  });

  test('namespaced gateway BYOK ids split into their real provider group', () => {
    expect(
      pickerGroupId(model({ providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-6' })),
    ).toBe('anthropic');
  });

  test('a kortix model id with no namespace and no managed match falls back to kortix', () => {
    expect(pickerGroupId(model({ providerID: 'kortix', modelID: 'glm-5.2' }))).toBe('kortix');
  });
});

describe('modelSelectorContextLine', () => {
  test('names the sole visible group in plain words', () => {
    expect(
      modelSelectorContextLine([{ providerID: 'kortix', providerName: 'Kortix' }]),
    ).toBe('via Kortix (included)');
    expect(
      modelSelectorContextLine([{ providerID: 'anthropic', providerName: 'Anthropic' }]),
    ).toBe('via Anthropic');
  });

  test('omits the header once more than one group is visible, or none', () => {
    expect(
      modelSelectorContextLine([
        { providerID: 'kortix', providerName: 'Kortix' },
        { providerID: 'anthropic', providerName: 'Anthropic' },
      ]),
    ).toBeNull();
    expect(modelSelectorContextLine([])).toBeNull();
  });
});
