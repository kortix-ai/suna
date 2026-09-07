import { describe, expect, test } from 'bun:test';

import {
  RUNTIME_ATTACHMENTS_UNAVAILABLE_MESSAGE,
  resolveRuntimePromptOverrides,
  runtimePromptFilesError,
  runtimePromptOverridesEnabled,
} from './runtime-prompt-contract';

describe('runtimePromptOverridesEnabled', () => {
  test('keeps ordinary and resolved OpenCode sessions configurable', () => {
    expect(
      runtimePromptOverridesEnabled({
        hasProjectSession: false,
        projectRuntimeIdentity: 'unknown',
        sandboxIsPiWorker: false,
      }),
    ).toBe(true);
    expect(
      runtimePromptOverridesEnabled({
        hasProjectSession: true,
        projectRuntimeIdentity: 'opencode',
        sandboxIsPiWorker: false,
      }),
    ).toBe(true);
  });

  test('fails closed while project runtime identity is unknown and for every Pi signal', () => {
    expect(
      runtimePromptOverridesEnabled({
        hasProjectSession: true,
        projectRuntimeIdentity: 'unknown',
        sandboxIsPiWorker: false,
      }),
    ).toBe(false);
    expect(
      runtimePromptOverridesEnabled({
        hasProjectSession: true,
        projectRuntimeIdentity: 'pi-worker',
        sandboxIsPiWorker: false,
      }),
    ).toBe(false);
    expect(
      runtimePromptOverridesEnabled({
        hasProjectSession: false,
        projectRuntimeIdentity: 'unknown',
        sandboxIsPiWorker: true,
      }),
    ).toBe(false);
    expect(
      runtimePromptOverridesEnabled({
        hasProjectSession: true,
        projectRuntimeIdentity: 'opencode',
        sandboxIsPiWorker: true,
      }),
    ).toBe(false);
  });
});

describe('runtimePromptFilesError', () => {
  test('allows OpenCode files and text-only Pi prompts', () => {
    expect(runtimePromptFilesError({ attachmentsEnabled: true, attachmentCount: 2 })).toBeNull();
    expect(runtimePromptFilesError({ attachmentsEnabled: false, attachmentCount: 0 })).toBeNull();
  });

  test('refuses a file before a text-only Pi payload is built', () => {
    expect(runtimePromptFilesError({ attachmentsEnabled: false, attachmentCount: 1 })).toBe(
      RUNTIME_ATTACHMENTS_UNAVAILABLE_MESSAGE,
    );
  });
});

describe('resolveRuntimePromptOverrides', () => {
  const staleModel = { providerID: 'openai', modelID: 'gpt-stale' };

  test('removes stale and explicit choices from a compiled Pi prompt', () => {
    expect(
      resolveRuntimePromptOverrides({
        agentEnabled: false,
        modelEnabled: false,
        variantEnabled: false,
        overrideAgent: 'other-agent',
        selectedAgent: 'compiled-agent',
        overrideModel: staleModel,
        selectedModel: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-5' },
        overrideVariant: 'max',
        selectedVariant: 'high',
      }),
    ).toEqual({});
  });

  test('preserves OpenCode override precedence and explicit clears', () => {
    expect(
      resolveRuntimePromptOverrides({
        agentEnabled: true,
        modelEnabled: true,
        variantEnabled: true,
        overrideAgent: 'review',
        selectedAgent: 'build',
        overrideModel: staleModel,
        selectedModel: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-5' },
        overrideVariant: 'max',
        selectedVariant: 'high',
      }),
    ).toEqual({ agent: 'review', model: staleModel, variant: 'max' });

    expect(
      resolveRuntimePromptOverrides({
        agentEnabled: true,
        modelEnabled: true,
        variantEnabled: true,
        overrideAgent: null,
        selectedAgent: 'build',
        overrideModel: null,
        selectedModel: { providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-5' },
        overrideVariant: null,
        selectedVariant: 'high',
      }),
    ).toEqual({});
  });

  test('supports a creation composer that selects an agent but not a model', () => {
    expect(
      resolveRuntimePromptOverrides({
        agentEnabled: true,
        modelEnabled: false,
        variantEnabled: false,
        selectedAgent: 'research',
        selectedModel: staleModel,
        selectedVariant: 'high',
      }),
    ).toEqual({ agent: 'research' });
  });
});
