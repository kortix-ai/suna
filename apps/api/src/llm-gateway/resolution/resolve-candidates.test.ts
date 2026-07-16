import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';

let tierByAccount: Record<string, string> = {};
const getAccountTier = mock(async (accountId: string) => tierByAccount[accountId] ?? 'pro');
mock.module('../../billing/services/entitlements', () => ({ getAccountTier }));

mock.module('../../billing/services/tiers', () => ({
  accountIsFreeTierForModels: (tier: string) => tier === 'free',
}));

const config: Record<string, unknown> = {};
mock.module('../../config', () => ({ config }));

let resolvedSecret: string | null = null;
let secretExistsForAnyOwner = false;
const getResolvedProjectSecretValue = mock(async () => resolvedSecret);
const projectSecretExistsForAnyOwner = mock(async () => secretExistsForAnyOwner);
mock.module('../../projects/secrets', () => ({
  getResolvedProjectSecretValue,
  projectSecretExistsForAnyOwner,
}));

class CodexRefreshError extends Error {}
let codexCredential: { access: string; accountId?: string } | null = null;
let codexThrows = false;
const resolveCodexCredential = mock(async () => {
  if (codexThrows) throw new CodexRefreshError('codex refresh failed');
  return codexCredential;
});
mock.module('../credentials/codex', () => ({ resolveCodexCredential, CodexRefreshError }));

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
let knownManagedModelId: string | null = null;
mock.module('../models/managed-models', () => ({
  RUNTIME_MANAGED_MODELS: [],
  getRuntimeManagedModel: (id: string) =>
    runtimeManagedModel?.id === id ? runtimeManagedModel : undefined,
  isRuntimeManagedModelId: (id: string) => runtimeManagedModel?.id === id,
  isKnownManagedModelId: (id: string) => id === knownManagedModelId,
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
  secretExistsForAnyOwner = false;
  codexCredential = null;
  codexThrows = false;
  catalogUpstream = null;
  runtimeManagedModel = undefined;
  knownManagedModelId = null;
  capabilities = { reasoning: false, temperature: true };
  getAccountTier.mockClear();
  getResolvedProjectSecretValue.mockClear();
  projectSecretExistsForAnyOwner.mockClear();
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

  test('no BYOK key connected for anyone throws provider_not_connected', async () => {
    catalogUpstream = {
      baseUrl: 'https://api.anthropic.com/v1',
      envVar: 'ANTHROPIC_API_KEY',
      kind: 'anthropic',
    };
    resolvedSecret = null;
    secretExistsForAnyOwner = false;

    await expect(
      resolveCandidates(principal(), 'anthropic/claude-sonnet-4.6'),
    ).rejects.toMatchObject({ code: 'provider_not_connected' });
  });

  test("a teammate's private key (not shared) throws the distinct provider_key_private", async () => {
    catalogUpstream = {
      baseUrl: 'https://api.anthropic.com/v1',
      envVar: 'ANTHROPIC_API_KEY',
      kind: 'anthropic',
    };
    resolvedSecret = null;
    secretExistsForAnyOwner = true;

    await expect(
      resolveCandidates(principal(), 'anthropic/claude-sonnet-4.6'),
    ).rejects.toMatchObject({ code: 'provider_key_private' });
  });
});

describe('resolveCandidates — managed model tier gating', () => {
  test('freeModelsOnly principal throws plan_upgrade_required before any tier lookup', async () => {
    runtimeManagedModel = { id: 'glm-5.2' };

    await expect(
      resolveCandidates(principal({ freeModelsOnly: true }), 'glm-5.2'),
    ).rejects.toMatchObject({ code: 'plan_upgrade_required' });
    expect(getAccountTier).not.toHaveBeenCalled();
  });

  test('free-tier account throws plan_upgrade_required for a managed model', async () => {
    runtimeManagedModel = { id: 'glm-5.2' };
    const p = principal();
    tierByAccount[p.accountId] = 'free';

    await expect(resolveCandidates(p, 'glm-5.2')).rejects.toMatchObject({
      code: 'plan_upgrade_required',
    });
  });

  test('paid-tier account gets the managed candidates', async () => {
    runtimeManagedModel = { id: 'glm-5.2' };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(p, 'glm-5.2');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ provider: 'kortix-managed' });
  });

  test('a known managed model with the provider disabled throws model_disabled_on_deployment', async () => {
    config.KORTIX_MANAGED_PROVIDER_ENABLED = false;
    runtimeManagedModel = { id: 'glm-5.2' };
    knownManagedModelId = 'glm-5.2';

    await expect(resolveCandidates(principal(), 'glm-5.2')).rejects.toMatchObject({
      code: 'model_disabled_on_deployment',
    });
  });
});

describe('resolveCandidates — codex + unknown provider', () => {
  test('codex provider without a projectId throws provider_not_connected', async () => {
    await expect(
      resolveCandidates(principal({ projectId: undefined }), 'codex/gpt-5.5'),
    ).rejects.toMatchObject({ code: 'provider_not_connected' });
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

  test('codex with no resolvable credential throws provider_not_connected', async () => {
    codexCredential = null;
    await expect(resolveCandidates(principal(), 'codex/gpt-5.5')).rejects.toMatchObject({
      code: 'provider_not_connected',
    });
  });

  test('codex whose session expired (CodexRefreshError) throws provider_reauth_required', async () => {
    codexThrows = true;
    await expect(resolveCandidates(principal(), 'codex/gpt-5.5')).rejects.toMatchObject({
      code: 'provider_reauth_required',
    });
  });

  test('an unroutable provider (no BYOK, no managed, no codex) throws model_not_found', async () => {
    const promise = resolveCandidates(principal(), 'made-up-provider/some-model');
    await expect(promise).rejects.toBeInstanceOf(GatewayResolutionError);
    await expect(promise).rejects.toMatchObject({ code: 'model_not_found' });
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
