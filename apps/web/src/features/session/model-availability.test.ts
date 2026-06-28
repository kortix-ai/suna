import { describe, expect, test } from 'bun:test';

import {
  isModelRequiredButUnavailable,
  NO_MODEL_AVAILABLE_ACTION_MESSAGE,
  NO_MODEL_AVAILABLE_MESSAGE,
} from './model-availability';

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

  test('does not block non-chat question actions', () => {
    expect(
      isModelRequiredButUnavailable({
        modelRequired: true,
        selectedModel: null,
        lockForQuestion: true,
      }),
    ).toBe(false);
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
