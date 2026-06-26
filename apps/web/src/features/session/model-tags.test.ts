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
  test('keeps native provider keys unchanged', () => {
    expect(
      modelVisibilityKeyForProviderModel('anthropic', 'claude-sonnet-4-6', false),
    ).toEqual({ providerID: 'anthropic', modelID: 'claude-sonnet-4-6' });
  });

  test('maps gateway BYOK provider models onto the kortix provider namespace', () => {
    expect(
      modelVisibilityKeyForProviderModel('anthropic', 'claude-sonnet-4-6', true),
    ).toEqual({ providerID: 'kortix', modelID: 'anthropic/claude-sonnet-4-6' });
  });

  test('keeps managed kortix model ids bare in gateway mode', () => {
    expect(
      modelVisibilityKeyForProviderModel('kortix', 'deepseek-v4-flash-free', true),
    ).toEqual({ providerID: 'kortix', modelID: 'deepseek-v4-flash-free' });
  });
});
