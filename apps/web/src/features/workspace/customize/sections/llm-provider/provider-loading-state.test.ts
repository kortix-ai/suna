import { describe, expect, test } from 'bun:test';

import { isProviderStateLoading } from './provider-loading-state';

describe('isProviderStateLoading', () => {
  test('waits for project secrets — the only input BYOK state depends on', () => {
    // Project detail used to be an input too, read only for the retired
    // `llm_gateway` flag. Gateway mode is the only mode, so it is not consulted.
    expect(isProviderStateLoading({ secretsLoading: true })).toBe(true);
  });

  test('does not wait for runtime providers after BYOK state resolves', () => {
    expect(isProviderStateLoading({ secretsLoading: false })).toBe(false);
  });
});
