import { describe, expect, test } from 'bun:test';
import { tryGetProvider } from './index';

describe('tryGetProvider', () => {
  test('returns null for an unknown/retired provider name instead of throwing', () => {
    // A legacy runtime can name a provider this build no longer knows. getProvider
    // throws for it; tryGetProvider must swallow that so teardown can proceed.
    expect(tryGetProvider('some-retired-provider')).toBeNull();
  });

  test('never throws, whatever the provider string', () => {
    // Disabled providers (API key unset) throw inside getProvider; tryGetProvider
    // converts every such failure to null.
    for (const name of ['platinum', 'daytona', 'e2b', '', 'garbage']) {
      expect(() => tryGetProvider(name)).not.toThrow();
    }
  });
});
