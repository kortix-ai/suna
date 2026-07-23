import { describe, expect, test } from 'bun:test';

import {
  deriveComposerBlockingAction,
  isModelRequiredButUnavailable,
  NO_MODEL_AVAILABLE_ACTION_MESSAGE,
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

  test('uses an actionable hover message', () => {
    expect(NO_MODEL_AVAILABLE_ACTION_MESSAGE).toContain('Connect a model');
    expect(NO_MODEL_AVAILABLE_ACTION_MESSAGE).toContain('upgrade');
  });
});

describe('deriveComposerBlockingAction', () => {
  test('no reason means no action', () => {
    expect(
      deriveComposerBlockingAction({ blockingReason: null, authReady: false, harnessLabel: 'Claude Code' }),
    ).toBeNull();
  });

  test('missing auth reads as "Connect <Harness>"', () => {
    expect(
      deriveComposerBlockingAction({
        blockingReason: 'Connect a compatible claude authentication route.',
        authReady: false,
        harnessLabel: 'Claude Code',
      }),
    ).toBe('Connect Claude Code');
  });

  test('missing auth for Codex reads as "Connect Codex"', () => {
    expect(
      deriveComposerBlockingAction({
        blockingReason: 'Connect a compatible codex authentication route.',
        authReady: false,
        harnessLabel: 'Codex',
      }),
    ).toBe('Connect Codex');
  });

  test('ready auth with no usable default reads as "Choose a model for <connection>"', () => {
    expect(
      deriveComposerBlockingAction({
        blockingReason: 'No usable model is available for opencode.',
        authReady: true,
        connectionLabel: 'Local vLLM',
      }),
    ).toBe('Choose a model for Local vLLM');
  });

  test('falls back to the raw reason when neither shape is known', () => {
    expect(
      deriveComposerBlockingAction({
        blockingReason: 'Choose which claude authentication connection to use.',
        authReady: false,
        harnessLabel: null,
      }),
    ).toBe('Choose which claude authentication connection to use.');

    expect(
      deriveComposerBlockingAction({
        blockingReason: 'No usable model is available for opencode.',
        authReady: true,
        connectionLabel: null,
      }),
    ).toBe('No usable model is available for opencode.');
  });
});
