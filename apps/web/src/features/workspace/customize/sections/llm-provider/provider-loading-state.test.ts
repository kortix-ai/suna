import { describe, expect, test } from 'bun:test';

import { isProviderStateLoading } from './provider-loading-state';

describe('isProviderStateLoading', () => {
  test('waits for workspace detail and workspace secrets', () => {
    expect(
      isProviderStateLoading({
        workspaceDetailLoading: true,
        secretsLoading: false,
      }),
    ).toBe(true);
    expect(
      isProviderStateLoading({
        workspaceDetailLoading: false,
        secretsLoading: true,
      }),
    ).toBe(true);
  });

  test('does not wait for runtime providers after BYOK state resolves', () => {
    expect(
      isProviderStateLoading({
        workspaceDetailLoading: false,
        secretsLoading: false,
      }),
    ).toBe(false);
  });
});
