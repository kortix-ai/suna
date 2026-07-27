import { describe, expect, test } from 'bun:test';

import { isProviderStateLoading } from './provider-loading-state';

describe('isProviderStateLoading', () => {
  test('waits for project detail and project secrets', () => {
    expect(
      isProviderStateLoading({
        projectDetailLoading: true,
        secretsLoading: false,
      }),
    ).toBe(true);
    expect(
      isProviderStateLoading({
        projectDetailLoading: false,
        secretsLoading: true,
      }),
    ).toBe(true);
  });

  test('does not wait for runtime providers after BYOK state resolves', () => {
    expect(
      isProviderStateLoading({
        projectDetailLoading: false,
        secretsLoading: false,
      }),
    ).toBe(false);
  });
});
