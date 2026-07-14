import { describe, expect, test } from 'bun:test';

import { resolveCatalogUpstream } from './provider-registry';

describe('runtime catalog provider resolution', () => {
  test('resolves a known OpenAI-compatible provider', () => {
    expect(resolveCatalogUpstream('groq')).toMatchObject({
      kind: 'openai-compat',
      envVar: 'GROQ_API_KEY',
    });
  });

  test('resolves Anthropic with its native transport', () => {
    expect(resolveCatalogUpstream('anthropic')).toMatchObject({
      kind: 'anthropic',
      envVar: 'ANTHROPIC_API_KEY',
      baseUrl: 'https://api.anthropic.com/v1',
    });
  });

  test('returns null for an unknown provider', () => {
    expect(resolveCatalogUpstream('definitely-not-a-provider')).toBeNull();
  });
});
