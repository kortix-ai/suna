import { describe, expect, test } from 'bun:test';

import {
  isModelRequiredButUnavailable,
  modelRejectingAttachedImages,
  NO_MODEL_AVAILABLE_ACTION_MESSAGE,
  NO_MODEL_AVAILABLE_MESSAGE,
  resolveAvailableSelectedModel,
} from './model-availability';

describe('an attached image the selected model cannot read', () => {
  const textOnly = {
    providerID: 'kortix',
    modelID: 'deepseek-v4-flash',
    modelName: 'DeepSeek V4 Flash',
    capabilities: { vision: false },
  };
  const vision = {
    providerID: 'kortix',
    modelID: 'grok-4.6',
    modelName: 'Grok 4.6',
    capabilities: { vision: true },
  };
  const unknown = { providerID: 'custom', modelID: 'my-model', modelName: 'My model' };
  const models = [textOnly, vision, unknown];
  const image = { isImage: true };
  const text = { isImage: false };
  const pick = (model: { providerID: string; modelID: string }) => ({
    providerID: model.providerID,
    modelID: model.modelID,
  });

  test('names a model whose catalog says it has no image input', () => {
    expect(
      modelRejectingAttachedImages({ files: [text, image], models, selectedModel: pick(textOnly) }),
    ).toBe('DeepSeek V4 Flash');
  });

  test('a vision model accepts the image', () => {
    expect(
      modelRejectingAttachedImages({ files: [image], models, selectedModel: pick(vision) }),
    ).toBeNull();
  });

  test('a file that is not an image never refuses the send', () => {
    expect(
      modelRejectingAttachedImages({ files: [text], models, selectedModel: pick(textOnly) }),
    ).toBeNull();
  });

  test('a model without capability data is not refused on a guess', () => {
    expect(
      modelRejectingAttachedImages({ files: [image], models, selectedModel: pick(unknown) }),
    ).toBeNull();
  });

  test('no selected model, or one missing from the list, refuses nothing', () => {
    expect(modelRejectingAttachedImages({ files: [image], models, selectedModel: null })).toBeNull();
    expect(
      modelRejectingAttachedImages({
        files: [image],
        models,
        selectedModel: { providerID: 'kortix', modelID: 'gone' },
      }),
    ).toBeNull();
  });
});

describe('session model availability', () => {
  test('blocks normal sends when a model is required but missing', () => {
    expect(
      isModelRequiredButUnavailable({
        modelRequired: true,
        selectedModel: null,
        lockForQuestion: false,
      }),
    ).toBe(true);
  });

  test('does not block once a model is selected', () => {
    expect(
      isModelRequiredButUnavailable({
        modelRequired: true,
        selectedModel: { providerID: 'kortix', modelID: 'openai/gpt-5' },
        lockForQuestion: false,
      }),
    ).toBe(false);
  });

  test('removes a selected model that is not usable for the account', () => {
    const selectedModel = { providerID: 'kortix', modelID: 'glm-5.3-flash' };

    expect(resolveAvailableSelectedModel(selectedModel, () => false)).toBeNull();
  });

  test('keeps a selected model that is usable for the account', () => {
    const selectedModel = { providerID: 'kortix', modelID: 'glm-5.3-flash' };

    expect(resolveAvailableSelectedModel(selectedModel, () => true)).toEqual(selectedModel);
  });

  test('does not block non-chat question actions', () => {
    expect(
      isModelRequiredButUnavailable({
        modelRequired: true,
        selectedModel: null,
        lockForQuestion: true,
      }),
    ).toBe(false);
  });

  /**
   * The staging release-gate failure this argument exists for
   * (`27-desktop-parity.spec.ts` › "Enter and Command+Enter keep distinct
   * pending prompt placements", 4/4 on the v0.13.21 gate, run 35242868705).
   *
   * Project home paints a focusable composer ~1.1s after navigation, long
   * before its catalog lands. Measured from that run's trace, at the Enter
   * keypress `GET /model-picker` had 414ms left to run, `/detail` 4.5s and
   * `/model-defaults` 6.8s. So `selectedModel` was null purely because
   * nothing had arrived yet — the picker read "No model" — and this predicate
   * reported "no models available", which error-toasted
   * NO_MODEL_AVAILABLE_MESSAGE and dropped the prompt with zero network
   * calls. Nothing retries, so the prompt was lost for good.
   *
   * "Not loaded yet" is not "none exist". While a catalog input is still in
   * flight this must refuse nothing.
   */
  test('does not refuse a send while the catalog is still loading', () => {
    expect(
      isModelRequiredButUnavailable({
        modelRequired: true,
        selectedModel: null,
        lockForQuestion: false,
        modelsLoading: true,
      }),
    ).toBe(false);
  });

  test('does not refuse a send while entitlements are still resolving', () => {
    expect(
      isModelRequiredButUnavailable({
        modelRequired: true,
        selectedModel: null,
        lockForQuestion: false,
        entitlementsPending: true,
      }),
    ).toBe(false);
  });

  test('still refuses once every catalog input has landed and none is offered', () => {
    expect(
      isModelRequiredButUnavailable({
        modelRequired: true,
        selectedModel: null,
        lockForQuestion: false,
        modelsLoading: false,
        entitlementsPending: false,
      }),
    ).toBe(true);
  });

  test('uses a generic no-model message', () => {
    expect(NO_MODEL_AVAILABLE_MESSAGE).toBe('No models available for this session yet.');
    expect(NO_MODEL_AVAILABLE_MESSAGE).not.toContain('upgrade');
    expect(NO_MODEL_AVAILABLE_MESSAGE).not.toContain('Go');
  });

  test('uses an actionable hover message', () => {
    expect(NO_MODEL_AVAILABLE_ACTION_MESSAGE).toContain('Connect a model');
    expect(NO_MODEL_AVAILABLE_ACTION_MESSAGE).toContain('upgrade');
  });
});
