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

  // Bedrock is a STANDALONE BYOK provider (not the cloud-only managed/credits
  // path): the bearer-token API key secret, resolved here so the normal BYOK
  // flow can build a kind:'bedrock' descriptor from a project's own key.
  // models.dev gives amazon-bedrock no `api` base and an env[0] of
  // AWS_ACCESS_KEY_ID — both wrong for this transport — so envVar is resolved
  // explicitly, not via the generic single-key fallback. Deliberately NO
  // baseUrl here: the runtime endpoint is region-scoped and the region is the
  // PROJECT's own AWS_REGION secret, not deployment config — this function has
  // no project context, so resolve-candidates.ts resolves the region-aware
  // endpoint per-request instead (see its `byok.kind === 'bedrock'` branch).
  test('resolves Amazon Bedrock as a standalone BYOK provider (bearer-token env var, no static baseUrl)', () => {
    expect(resolveCatalogUpstream('amazon-bedrock')).toEqual({
      kind: 'bedrock',
      envVar: 'AWS_BEARER_TOKEN_BEDROCK',
    });
  });

  test('returns null for an unknown provider', () => {
    expect(resolveCatalogUpstream('definitely-not-a-provider')).toBeNull();
  });
});
