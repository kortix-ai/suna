import { describe, expect, test } from 'bun:test';

import { resolveCatalogUpstream } from './provider-registry';

describe('runtime catalog provider resolution', () => {
  test('resolves a known OpenAI-compatible provider', () => {
    expect(resolveCatalogUpstream('groq')).toMatchObject({
      kind: 'openai-compat',
      envVar: 'GROQ_API_KEY',
    });
  });

  // Pins the exact host the openai-compat transport's max_tokens ->
  // max_completion_tokens translation keys off of (see
  // packages/llm-gateway/src/transports/openai-compat/index.ts). If this ever
  // resolves to something other than the real api.openai.com host, that
  // translation silently stops firing for genuine OpenAI BYOK traffic.
  test('resolves OpenAI to the genuine api.openai.com host', () => {
    expect(resolveCatalogUpstream('openai')).toMatchObject({
      kind: 'openai-compat',
      envVar: 'OPENAI_API_KEY',
      baseUrl: 'https://api.openai.com/v1',
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
