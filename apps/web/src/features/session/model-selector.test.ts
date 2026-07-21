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

// Bedrock regression: models.dev's canonical provider id is `amazon-bedrock`
// and Bedrock wire ids are DOT-namespaced (`us.anthropic.claude-opus-4-8`),
// so there is no "/" to split on — the explicit `provider` field is the ONLY
// way to group them. PROVIDER_LABELS was missing the `amazon-bedrock` key, so
// the label lookup fell through to `providerName` ("Kortix") and the whole
// BYOK Bedrock group rendered as "Kortix" while showing the Bedrock icon.
describe('BYOK Bedrock grouping (dot-namespaced ids)', () => {
  const bedrockModelIDs = [
    'us.anthropic.claude-opus-4-8',
    'global.anthropic.claude-sonnet-5',
    'anthropic.claude-fable-5',
    'deepseek.v3.2',
  ];

  for (const modelID of bedrockModelIDs) {
    test(`groups ${modelID} under amazon-bedrock, labelled "Amazon Bedrock"`, () => {
      const m = model({ providerID: 'kortix', modelID, provider: 'amazon-bedrock' });
      const groupID = pickerGroupId(m);
      expect(groupID).toBe('amazon-bedrock');
      expect(pickerGroupLabel(groupID, m)).toBe('Amazon Bedrock');
    });
  }

  test('the short `bedrock` alias resolves to the same label', () => {
    const m = model({
      providerID: 'kortix',
      modelID: 'us.anthropic.claude-opus-4-8',
      provider: 'bedrock',
    });
    expect(pickerGroupLabel(pickerGroupId(m), m)).toBe('Amazon Bedrock');
  });

  test('WITHOUT the explicit provider field a dot-namespaced id degrades to kortix', () => {
    // Documents exactly why `provider` must survive the wire: there is no "/"
    // to recover the real provider from, so the label would read "Kortix".
    const m = model({ providerID: 'kortix', modelID: 'us.anthropic.claude-opus-4-8' });
    expect(pickerGroupId(m)).toBe('kortix');
  });
});
