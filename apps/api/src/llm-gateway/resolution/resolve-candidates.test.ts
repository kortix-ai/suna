import { beforeEach, describe, expect, mock, test } from 'bun:test';

let tierByAccount: Record<string, string> = {};
const getAccountTier = mock(async (accountId: string) => tierByAccount[accountId] ?? 'pro');
mock.module('../../billing/services/entitlements', () => ({ getAccountTier }));

mock.module('../../billing/services/tiers', () => ({
  accountIsFreeTierForModels: (tier: string) => tier === 'free',
}));

const config: Record<string, unknown> = {};
mock.module('../../config', () => ({ config }));

let resolvedSecret: string | null = null;
const getResolvedProjectSecretValue = mock(async () => resolvedSecret);
mock.module('../../projects/secrets', () => ({ getResolvedProjectSecretValue }));

let codexCredential: { access: string; accountId?: string } | null = null;
const resolveCodexCredential = mock(async () => codexCredential);
mock.module('../credentials/codex', () => ({ resolveCodexCredential }));

mock.module('./descriptors', () => ({
  codexDescriptor: (credential: { access: string }, model: string) => ({
    provider: 'openai-codex',
    kind: 'openai-responses',
    baseUrl: 'https://codex.test',
    apiKey: credential.access,
    billingMode: 'none',
    markup: 0,
    resolvedModel: model,
  }),
  livePricing: () => undefined,
  managedCandidates: (managed: { id: string }) => [
    {
      provider: 'kortix-managed',
      kind: 'bedrock',
      baseUrl: 'https://managed.test',
      apiKey: 'm',
      billingMode: 'credits',
      markup: 1,
      resolvedModel: managed.id,
    },
  ],
}));

let catalogUpstream: { baseUrl: string; envVar: string; kind: string } | null = null;
mock.module('../models/provider-registry', () => ({
  resolveCatalogUpstream: () => catalogUpstream,
}));

mock.module('../routing', () => ({
  resolveGatewayRoute: async () => ({ primaryModel: 'anthropic/claude-sonnet-4.6' }),
}));

let runtimeManagedModel: { id: string } | undefined;
mock.module('../models/managed-models', () => ({
  RUNTIME_MANAGED_MODELS: [],
  getRuntimeManagedModel: (id: string) =>
    runtimeManagedModel?.id === id ? runtimeManagedModel : undefined,
  isRuntimeManagedModelId: (id: string) => runtimeManagedModel?.id === id,
}));

let capabilities = { reasoning: false, temperature: true };
mock.module('../models/catalog-models', () => ({
  capabilitiesForModel: () => capabilities,
}));

const { resolveCandidates, resolveCachedAccountTier } = await import('./resolve-candidates');

function principal(overrides: Record<string, unknown> = {}) {
  return { userId: 'u1', accountId: crypto.randomUUID(), projectId: 'p1', ...overrides };
}

beforeEach(() => {
  tierByAccount = {};
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, {
    LLM_GATEWAY_ENABLED: true,
    KORTIX_MANAGED_PROVIDER_ENABLED: true,
    KORTIX_BILLING_INTERNAL_ENABLED: true,
    LLM_GATEWAY_BYOK_FALLBACK_MODEL: 'anthropic/claude-sonnet-4.6',
  });
  resolvedSecret = null;
  codexCredential = null;
  catalogUpstream = null;
  runtimeManagedModel = undefined;
  capabilities = { reasoning: false, temperature: true };
  getAccountTier.mockClear();
  getResolvedProjectSecretValue.mockClear();
  resolveCodexCredential.mockClear();
});

describe('resolveCandidates — BYOK billingMode / free-tier / managed-fallback', () => {
  test('paid tier: platform-fee billing, 10% markup, managed fallback queued behind the BYOK key', async () => {
    catalogUpstream = {
      baseUrl: 'https://api.anthropic.com/v1',
      envVar: 'ANTHROPIC_API_KEY',
      kind: 'anthropic',
    };
    resolvedSecret = 'sk-user-key';
    runtimeManagedModel = { id: 'anthropic/claude-sonnet-4.6' };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(p, 'anthropic/claude-sonnet-4.6');

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      billingMode: 'platform-fee',
      markup: 0.1,
      apiKey: 'sk-user-key',
    });
    expect(candidates[1]).toMatchObject({ provider: 'kortix-managed' });
  });

  test('BYOK descriptor carries the model capability flags for the transport', async () => {
    catalogUpstream = {
      baseUrl: 'https://api.openai.com/v1',
      envVar: 'OPENAI_API_KEY',
      kind: 'openai-compat',
    };
    resolvedSecret = 'sk-user-key';
    capabilities = { reasoning: true, temperature: false };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(p, 'openai/gpt-5.5');
    expect(candidates[0]).toMatchObject({ reasoning: true, temperature: false });
  });

  test('free tier: BYOK key is billing-free (markup 0, billingMode none) with no managed fallback', async () => {
    catalogUpstream = {
      baseUrl: 'https://api.anthropic.com/v1',
      envVar: 'ANTHROPIC_API_KEY',
      kind: 'anthropic',
    };
    resolvedSecret = 'sk-user-key';
    const p = principal();
    tierByAccount[p.accountId] = 'free';

    const candidates = await resolveCandidates(p, 'anthropic/claude-sonnet-4.6');

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ billingMode: 'none', markup: 0 });
  });

  test('self-hosted (billing disabled): no tier lookup, still gets the platform markup and a managed fallback', async () => {
    config.KORTIX_BILLING_INTERNAL_ENABLED = false;
    catalogUpstream = {
      baseUrl: 'https://api.anthropic.com/v1',
      envVar: 'ANTHROPIC_API_KEY',
      kind: 'anthropic',
    };
    resolvedSecret = 'sk-user-key';
    runtimeManagedModel = { id: 'anthropic/claude-sonnet-4.6' };

    const candidates = await resolveCandidates(principal(), 'anthropic/claude-sonnet-4.6');

    expect(getAccountTier).not.toHaveBeenCalled();
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ billingMode: 'none', markup: 0.1 });
  });

  test('no BYOK secret configured for the project falls through to the managed/empty path', async () => {
    catalogUpstream = {
      baseUrl: 'https://api.anthropic.com/v1',
      envVar: 'ANTHROPIC_API_KEY',
      kind: 'anthropic',
    };
    resolvedSecret = null;

    expect(await resolveCandidates(principal(), 'anthropic/claude-sonnet-4.6')).toEqual([]);
  });
});

describe('resolveCandidates — managed model tier gating', () => {
  test('freeModelsOnly principal short-circuits before any tier lookup', async () => {
    runtimeManagedModel = { id: 'glm-5.2' };

    expect(await resolveCandidates(principal({ freeModelsOnly: true }), 'glm-5.2')).toEqual([]);
    expect(getAccountTier).not.toHaveBeenCalled();
  });

  test('free-tier account gets no managed candidates', async () => {
    runtimeManagedModel = { id: 'glm-5.2' };
    const p = principal();
    tierByAccount[p.accountId] = 'free';

    expect(await resolveCandidates(p, 'glm-5.2')).toEqual([]);
  });

  test('paid-tier account gets the managed candidates', async () => {
    runtimeManagedModel = { id: 'glm-5.2' };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(p, 'glm-5.2');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ provider: 'kortix-managed' });
  });

  test('managed model is gated off entirely when KORTIX_MANAGED_PROVIDER_ENABLED is false', async () => {
    config.KORTIX_MANAGED_PROVIDER_ENABLED = false;
    runtimeManagedModel = { id: 'glm-5.2' };

    expect(await resolveCandidates(principal(), 'glm-5.2')).toEqual([]);
  });
});

describe('resolveCandidates — codex + unknown provider', () => {
  test('codex provider requires a projectId', async () => {
    expect(await resolveCandidates(principal({ projectId: undefined }), 'codex/gpt-5.5')).toEqual(
      [],
    );
  });

  test('codex provider resolves to the codex descriptor when a credential exists', async () => {
    codexCredential = { access: 'codex-token' };
    const candidates = await resolveCandidates(principal(), 'codex/gpt-5.5');
    expect(candidates).toEqual([
      expect.objectContaining({
        provider: 'openai-codex',
        apiKey: 'codex-token',
        resolvedModel: 'codex/gpt-5.5',
      }),
    ]);
  });

  test('codex provider with no resolvable credential returns nothing', async () => {
    codexCredential = null;
    expect(await resolveCandidates(principal(), 'codex/gpt-5.5')).toEqual([]);
  });

  test('an unroutable provider (no BYOK, no managed, no codex) returns nothing', async () => {
    expect(await resolveCandidates(principal(), 'made-up-provider/some-model')).toEqual([]);
  });
});

describe('resolveCachedAccountTier — 30s TTL boundary', () => {
  test('caches within the TTL window: a second call inside 30s does not re-query', async () => {
    const accountId = crypto.randomUUID();
    tierByAccount[accountId] = 'pro';

    expect(await resolveCachedAccountTier(accountId, 1_000)).toBe('pro');
    tierByAccount[accountId] = 'free';
    expect(await resolveCachedAccountTier(accountId, 1_000 + 29_999)).toBe('pro');
    expect(getAccountTier).toHaveBeenCalledTimes(1);
  });

  test('a tier change mid-window is invisible until the cache expires (the exact bug shape)', async () => {
    const accountId = crypto.randomUUID();
    tierByAccount[accountId] = 'free';
    expect(await resolveCachedAccountTier(accountId, 5_000)).toBe('free');

    tierByAccount[accountId] = 'pro';
    expect(await resolveCachedAccountTier(accountId, 5_000 + 15_000)).toBe('free');
  });

  test('refreshes exactly once the 30s TTL has elapsed', async () => {
    const accountId = crypto.randomUUID();
    tierByAccount[accountId] = 'free';
    await resolveCachedAccountTier(accountId, 10_000);

    tierByAccount[accountId] = 'pro';
    expect(await resolveCachedAccountTier(accountId, 10_000 + 30_000)).toBe('pro');
    expect(getAccountTier).toHaveBeenCalledTimes(2);
  });
});
