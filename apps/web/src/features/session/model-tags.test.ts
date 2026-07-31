import { describe, expect, test } from 'bun:test';

import { shouldShowFreeTag } from './model-tags';

describe('shouldShowFreeTag', () => {
  test('uses an explicit free marker when a provider sends one', () => {
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

