import { describe, expect, test } from 'bun:test';

import { pickerGroupId, pickerGroupLabel } from './model-selector';
import type { FlatModel } from './session-chat-input';

// Regression coverage for the "every provider shows as Kortix" picker bug.
//
// Root cause: the gateway exposes its ENTIRE catalog under one synthetic
// `kortix` opencode provider. `pickerGroupId` always correctly split the
// grouping KEY out of the wire model id, but the group's DISPLAY LABEL was
// built from `model.providerName` — which is opencode's raw provider name,
// ALWAYS "Kortix" for every model, since there is only one registered
// provider. So the icon rendered under the right provider but every group's
// text label still read "Kortix". The fix is two-fold: prefer the explicit
// `provider` field the gateway now serves (never string-split when it's
// present) for the grouping key, AND resolve the display label from
// PROVIDER_LABELS keyed by that REAL id — never from the raw providerName.
function model(partial: Partial<FlatModel> & Pick<FlatModel, 'providerID' | 'modelID'>): FlatModel {
  return {
    providerName: 'Kortix',
    modelName: partial.modelID,
    ...partial,
  };
}

describe('pickerGroupId', () => {
  test('prefers the explicit `provider` field over string-splitting the wire id', () => {
    const m = model({
      providerID: 'kortix',
      modelID: 'anthropic/claude-opus-4-8',
      provider: 'anthropic',
    });
    expect(pickerGroupId(m)).toBe('anthropic');
  });

  test('falls back to splitting modelID on "/" when `provider` is absent (stale catalog)', () => {
    const m = model({ providerID: 'kortix', modelID: 'openai/gpt-5.6-sol' });
    expect(pickerGroupId(m)).toBe('openai');
  });

  test('a managed bare-id model (no slash, no explicit provider) groups under kortix', () => {
    const m = model({ providerID: 'kortix', modelID: 'claude-opus-4.8' });
    expect(pickerGroupId(m)).toBe('kortix');
  });

  test('AUTO groups under kortix even though its own explicit provider is "kortix"', () => {
    const m = model({ providerID: 'kortix', modelID: 'auto', provider: 'kortix' });
    expect(pickerGroupId(m)).toBe('kortix');
  });

  test('a codex/<id> model groups under its own `codex` provider, distinct from `openai`', () => {
    const m = model({ providerID: 'kortix', modelID: 'codex/gpt-5.6-sol', provider: 'codex' });
    expect(pickerGroupId(m)).toBe('codex');
  });

  test('a non-gateway (native) provider model groups under its own providerID unchanged', () => {
    const m = model({ providerID: 'anthropic', modelID: 'claude-opus-4-8', providerName: 'Anthropic' });
    expect(pickerGroupId(m)).toBe('anthropic');
  });
});

describe('pickerGroupLabel — THE actual display-name bug fix', () => {
  test('labels an Anthropic BYOK group "Anthropic", never the raw (always-"Kortix") providerName', () => {
    const m = model({
      providerID: 'kortix',
      modelID: 'anthropic/claude-opus-4-8',
      provider: 'anthropic',
      providerName: 'Kortix', // what opencode's raw provider object always reports
    });
    const groupID = pickerGroupId(m);
    expect(pickerGroupLabel(groupID, m)).toBe('Anthropic');
    expect(pickerGroupLabel(groupID, m)).not.toBe('Kortix');
  });

  test('labels an OpenAI BYOK group "OpenAI"', () => {
    const m = model({ providerID: 'kortix', modelID: 'openai/gpt-5.6-sol', provider: 'openai' });
    expect(pickerGroupLabel(pickerGroupId(m), m)).toBe('OpenAI');
  });

  test('labels the managed group "Kortix" (correctly, since it really is Kortix)', () => {
    const m = model({ providerID: 'kortix', modelID: 'claude-opus-4.8' });
    expect(pickerGroupLabel(pickerGroupId(m), m)).toBe('Kortix');
  });

  test('falls back to the raw providerName for a truly unrecognized provider id', () => {
    const m = model({
      providerID: 'kortix',
      modelID: 'some-new-provider/some-model',
      providerName: 'Kortix',
    });
    // No PROVIDER_LABELS entry for "some-new-provider" -> falls back to
    // model.providerName rather than showing an ugly raw id.
    expect(pickerGroupLabel(pickerGroupId(m), m)).toBe('Kortix');
  });
});
