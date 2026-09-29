import { describe, expect, test } from 'bun:test';

import type { Catalog } from '@kortix/llm-catalog';
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

  // Regression (kortix-ai/suna self-host report, 2026-09-17): the baseUrl
  // override keyed off `kind === 'anthropic'`, so EVERY provider with an
  // Anthropic-shaped transport (npm: @ai-sdk/anthropic) — not just Anthropic
  // itself — had its catalog `api` base discarded and its users' keys sent to
  // api.anthropic.com, which correctly 401s them ("API key is invalid.").
  // The catalog's `anthropic` entry publishes no `api` field (hence the
  // ANTHROPIC_BASE_URL fallback, asserted above); these third-party
  // Anthropic-compatible providers DO, and it must win.
  test('resolves kimi-for-coding to its own Anthropic-compatible endpoint, not api.anthropic.com', () => {
    expect(resolveCatalogUpstream('kimi-for-coding')).toMatchObject({
      kind: 'anthropic',
      envVar: 'KIMI_API_KEY',
      baseUrl: 'https://api.kimi.com/coding/v1',
    });
  });

  test('resolves MiniMax coding-plan providers to their own endpoints', () => {
    expect(resolveCatalogUpstream('minimax-coding-plan')).toMatchObject({
      kind: 'anthropic',
      baseUrl: 'https://api.minimax.io/anthropic/v1',
    });
    expect(resolveCatalogUpstream('minimax-cn')).toMatchObject({
      kind: 'anthropic',
      baseUrl: 'https://api.minimaxi.com/anthropic/v1',
    });
  });

  test('resolves Google Gemini through its OpenAI-compatible API with the primary UI key', () => {
    expect(resolveCatalogUpstream('google')).toEqual({
      kind: 'openai-compat',
      envVar: 'GOOGLE_GENERATIVE_AI_API_KEY',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      npm: '@ai-sdk/google',
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
      // models.dev `npm` (for the ai-sdk engine's provider selection); still NO
      // static baseUrl — the region-scoped endpoint is resolved per-request.
      npm: '@ai-sdk/amazon-bedrock',
    });
  });

  test('returns null for an unknown provider', () => {
    expect(resolveCatalogUpstream('definitely-not-a-provider')).toBeNull();
  });

  // Regression coverage (2026-07-17 defect report): a BYOK OpenRouter call to
  // a model NOT individually catalogued by models.dev (OpenRouter's dynamic/
  // no-catalog-price auto-router, `openrouter/openrouter/fusion`, among
  // hundreds of other models OpenRouter proxies) 502ed with an "Invalid URL"
  // upstream error — consistent with `descriptor.baseUrl` ending up empty for
  // that call. `resolveCatalogUpstream` is this codebase's ONE source of
  // BYOK baseUrl resolution (see resolve-candidates.ts's `byok.baseUrl`), and
  // its signature takes ONLY a `providerId` — there is no model parameter to
  // key off of, so it structurally cannot special-case "is this exact model
  // individually catalogued." A connected provider's baseUrl is therefore the
  // same regardless of which model id a caller passes through it, including
  // one models.dev has never heard of. Live re-verified against dev
  // (2026-07-17): both the in-process gateway and the standalone gateway pod
  // now reach OpenRouter and bill non-zero upstream cost for exactly this
  // model, streaming and non-streaming alike.
  test('OpenRouter resolves a real, non-empty baseUrl — independent of any specific model id', () => {
    const upstream = resolveCatalogUpstream('openrouter');
    expect(upstream).not.toBeNull();
    expect(upstream?.kind).toBe('openai-compat');
    expect(upstream?.envVar).toBe('OPENROUTER_API_KEY');
    // `kind !== 'bedrock'` narrows CatalogUpstream's discriminated union to the
    // branch that actually carries `baseUrl` (bedrock has none — see the type's
    // doc comment above).
    if (upstream?.kind === 'bedrock') throw new Error('expected openai-compat, got bedrock');
    expect(upstream?.baseUrl).toBe('https://openrouter.ai/api/v1');
  });
});

// models.dev overrides the provider's wire format per model with
// `model.provider.npm`. OpenCode Go serves MiniMax/Qwen on Anthropic `/messages`
// and Grok/GPT/Muse on OpenAI `/responses` under one `api` base. Resolving only
// the provider sent every model to `/chat/completions`.
describe('per-model wire format override', () => {
  const catalog: Catalog = {
    source: 'test', fetched_at: '2026-09-29T00:00:00.000Z', provider_count: 1, model_count: 4,
    providers: [{
      id: 'opencode-go', name: 'OpenCode Go', env: ['OPENCODE_API_KEY'],
      api: 'https://opencode.ai/zen/go/v1', npm: '@ai-sdk/openai-compatible',
      models: [
        { id: 'glm-5.3', name: 'GLM-5.3' },
        { id: 'minimax-m3', name: 'MiniMax-M3', provider: { npm: '@ai-sdk/anthropic' } },
        { id: 'grok-4.7', name: 'Grok 4.7', provider: { npm: '@ai-sdk/openai' } },
        { id: 'moved', name: 'Moved', provider: { api: 'https://other.test/v1' } },
      ],
    }],
  };
  const base = { envVar: 'OPENCODE_API_KEY', baseUrl: 'https://opencode.ai/zen/go/v1' };

  test.each([
    ['glm-5.3', { ...base, kind: 'openai-compat', npm: '@ai-sdk/openai-compatible' }],
    ['minimax-m3', { ...base, kind: 'anthropic', npm: '@ai-sdk/anthropic' }],
    ['grok-4.7', { ...base, kind: 'openai-responses', npm: '@ai-sdk/openai' }],
    ['moved', { ...base, kind: 'openai-compat', baseUrl: 'https://other.test/v1' }],
    ['not-in-catalog', { ...base, kind: 'openai-compat' }],
  ])('%s resolves its own transport', (modelId, expected) => {
    expect(resolveCatalogUpstream('opencode-go', modelId, catalog)).toEqual(expect.objectContaining(expected));
  });

  test('without a model id the provider default applies', () => {
    expect(resolveCatalogUpstream('opencode-go', undefined, catalog)).toMatchObject({ kind: 'openai-compat' });
  });
});
