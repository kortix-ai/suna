import { describe, expect, test } from 'bun:test';

import { shouldSyncProviderNetworkBoundary } from './index';

describe('shouldSyncProviderNetworkBoundary', () => {
  test('keeps the authoritative provider synchronized for an empty binding set', () => {
    expect(shouldSyncProviderNetworkBoundary('platinum', 0)).toBe(true);
  });

  test('skips on-demand providers for an empty binding set', () => {
    expect(shouldSyncProviderNetworkBoundary('daytona', 0)).toBe(false);
    expect(shouldSyncProviderNetworkBoundary('e2b', 0)).toBe(false);
  });

  test('requires every provider to evaluate non-empty bindings', () => {
    expect(shouldSyncProviderNetworkBoundary('daytona', 1)).toBe(true);
    expect(shouldSyncProviderNetworkBoundary('platinum', 1)).toBe(true);
    expect(shouldSyncProviderNetworkBoundary('e2b', 1)).toBe(true);
  });
});
