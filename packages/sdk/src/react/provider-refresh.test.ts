import { describe, expect, test } from 'bun:test';

import { providerConnectedInSecrets } from './provider-refresh';

describe('providerConnectedInSecrets', () => {
  test('false for empty, null, or malformed responses', () => {
    expect(providerConnectedInSecrets(undefined, 'anthropic')).toBe(false);
    expect(providerConnectedInSecrets(null, 'anthropic')).toBe(false);
    expect(providerConnectedInSecrets([], 'anthropic')).toBe(false);
    expect(providerConnectedInSecrets({ items: [] }, 'anthropic')).toBe(false);
    expect(providerConnectedInSecrets({ items: [{ notName: 1 }] }, 'anthropic')).toBe(false);
  });

  test('resolves a provider once its credential env var is present (array shape)', () => {
    expect(providerConnectedInSecrets([{ name: 'ANTHROPIC_API_KEY' }], 'anthropic')).toBe(true);
    expect(providerConnectedInSecrets([{ name: 'ANTHROPIC_API_KEY' }], 'openai')).toBe(false);
  });

  test('resolves a provider from the items envelope shape', () => {
    const secrets = { items: [{ name: 'OPENAI_API_KEY' }, { name: 'UNRELATED' }] };
    expect(providerConnectedInSecrets(secrets, 'openai')).toBe(true);
  });

  test('codex resolves from the subscription auth secret', () => {
    expect(providerConnectedInSecrets([{ name: 'CODEX_AUTH_JSON' }], 'codex')).toBe(true);
  });

  test('an unrelated secret never resolves a provider', () => {
    expect(providerConnectedInSecrets([{ name: 'STRIPE_API_KEY' }], 'anthropic')).toBe(false);
  });
});
