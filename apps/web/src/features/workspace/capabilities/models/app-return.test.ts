import { describe, expect, test } from 'bun:test';

import { usableModelCount } from './app-return';

describe('usableModelCount', () => {
  test('counts enabled models and skips auto, like the mobile picker', () => {
    expect(
      usableModelCount([
        { modelID: 'auto' },
        { modelID: 'kortix/auto' },
        { modelID: 'claude-sonnet', enabled: false },
        { modelID: 'gpt-5' },
        { modelID: 'claude-opus', enabled: true },
      ]),
    ).toBe(2);
  });

  test('is zero for an empty catalog', () => {
    expect(usableModelCount([])).toBe(0);
  });
});
