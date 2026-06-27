import { describe, expect, test } from 'bun:test';

import { modelVisibilityKeyForProviderModel, shouldShowFreeTag } from './model-tags';

describe('shouldShowFreeTag', () => {
  test('uses the managed catalog free marker', () => {
    expect(
      shouldShowFreeTag({
        free: true,
        modelID: 'deepseek-v4-flash-free',
        modelName: 'DeepSeek V4 Flash',
      }),
    ).toBe(true);
  });

  test('uses fetched native model names and ids without hardcoding providers', () => {
    expect(
      shouldShowFreeTag({
        modelID: 'deepseek-v4-flash-free',
        modelName: 'DeepSeek V4 Flash Free',
      }),
    ).toBe(true);
  });

  test('does not tag arbitrary zero-cost-looking names without a free token', () => {
    expect(
      shouldShowFreeTag({
        modelID: 'big-pickle',
        modelName: 'Big Pickle',
      }),
    ).toBe(false);
  });
});

describe('modelVisibilityKeyForProviderModel', () => {
  test('keeps native BYOK provider keys unchanged', () => {
    expect(modelVisibilityKeyForProviderModel('anthropic', 'claude-sonnet-4-6')).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet-4-6',
    });
  });

  test('keeps managed kortix model ids on the kortix provider', () => {
    expect(modelVisibilityKeyForProviderModel('kortix', 'deepseek-v4-flash-free')).toEqual({
      providerID: 'kortix',
      modelID: 'deepseek-v4-flash-free',
    });
  });

  test('maps ChatGPT (codex) rows back to the kortix codex namespace', () => {
    expect(modelVisibilityKeyForProviderModel('codex', 'gpt-5')).toEqual({
      providerID: 'kortix',
      modelID: 'codex/gpt-5',
    });
  });
});
