import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';

let tierByAccount: Record<string, string> = {};
const getAccountTier = mock(async (accountId: string) => tierByAccount[accountId] ?? 'pro');

// resolveCandidates now calls the SAME cached tier resolver the rest of the
// gateway uses (entitlements.getCachedAccountTier) instead of keeping its own
// duplicate cache — resolve-candidates.ts's `resolveCachedAccountTier` is a
// thin re-export of this, not a second implementation. Mirrors the real
// implementation's TTL-cache-with-injectable-`now` shape (see
// entitlements.ts) so the TTL-boundary suite below still exercises real
// caching semantics through the mock.
const TIER_CACHE_TTL_MS = 30_000;
const accountTierCache = new Map<string, { tier: string; expiresAt: number }>();
const getCachedAccountTier = mock(async (accountId: string, now: number = Date.now()) => {
  const cached = accountTierCache.get(accountId);
  if (cached && cached.expiresAt > now) return cached.tier;
  const tier = await getAccountTier(accountId);
  accountTierCache.set(accountId, { tier, expiresAt: now + TIER_CACHE_TTL_MS });
  return tier;
});
mock.module('../../billing/services/entitlements', () => ({
  getAccountTier,
  getCachedAccountTier,
}));

mock.module('../../billing/services/tiers', () => ({
  accountIsFreeTierForModels: (tier: string) => tier === 'free',
}));

const config: Record<string, unknown> = {};
mock.module('../../config', () => ({ config }));

// `resolvedSecret` is the legacy single-value behavior every non-Bedrock test
// below still relies on (one BYOK provider = one envVar). Bedrock resolves
// TWO project secrets by distinct name (bearer token + region) in the same
// call, so `secretsByName` lets a test pin per-name values; any name not in
// `secretsByName` falls back to `resolvedSecret` for backward compatibility.
let resolvedSecret: string | null = null;
let secretsByName: Record<string, string | null> = {};
const getProjectSecretValue = mock(async (_projectId: string, name: string) => {
  if (name in secretsByName) return secretsByName[name] ?? null;
  return resolvedSecret;
});
mock.module('../../projects/secrets', () => ({
  getProjectSecretValue,
}));

class CodexRefreshError extends Error {}
let codexCredential: { access: string; accountId?: string } | null = null;
let codexThrows = false;
const resolveCodexCredential = mock(async () => {
  if (codexThrows) throw new CodexRefreshError('codex refresh failed');
  return codexCredential;
});
mock.module('../credentials/codex', () => ({ resolveCodexCredential, CodexRefreshError }));

// Captures every id `livePricing` is called with, in call order — lets tests
// assert resolveCandidates strips the Bedrock cross-region inference-profile
// prefix (`us.`/`eu.`/`apac.`/`us-gov.`) before the PRICING lookup while
// still keeping the full profile id as `resolvedModel` (the id actually sent
// upstream). Mirrors the real stripBedrockInferenceProfilePrefix (descriptors.ts)
// closely enough to exercise the call site; the prefix-stripping logic itself
// is unit-tested directly in descriptors.test.ts.
let livePricingCalls: string[] = [];
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
  livePricing: (modelId: string) => {
    livePricingCalls.push(modelId);
    return undefined;
  },
  stripBedrockInferenceProfilePrefix: (modelId: string) =>
    modelId.replace(/^(us-gov|us|eu|apac)\.(?=.)/, ''),
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
  // Mirrors the real bedrockByokBaseUrl (descriptors.ts) closely enough to
  // assert on: regional endpoint derived from `region`, defaulting exactly
  // like the real DEFAULT_BEDROCK_BYOK_REGION — never reads config.
  bedrockByokBaseUrl: (region: string | null | undefined) =>
    `https://bedrock-runtime.${region?.trim() || 'us-east-1'}.amazonaws.com`,
}));

let catalogUpstream: { baseUrl?: string; envVar: string; kind: string } | null = null;
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
  secretsByName = {};
  codexCredential = null;
  codexThrows = false;
  catalogUpstream = null;
  runtimeManagedModel = undefined;
  knownManagedModelId = null;
  capabilities = { reasoning: false, temperature: true };
  livePricingCalls = [];
  getAccountTier.mockClear();
  getCachedAccountTier.mockClear();
  getProjectSecretValue.mockClear();
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

  // Bedrock is a STANDALONE BYOK provider (its own bearer-token key + regional
  // endpoint), NOT the cloud-only managed/credits path. A project that connects
  // its own AWS_BEARER_TOKEN_BEDROCK resolves to a `kind:'bedrock'` descriptor
  // carrying that key and the bare Bedrock model id — routed through the bedrock
  // transport exactly like the managed Bedrock path, just with the user's own
  // credentials. KORTIX_MANAGED_PROVIDER_ENABLED is irrelevant here.
  //
  // Regression coverage: the region MUST come from the project's OWN
  // AWS_REGION secret, never from deployment/operator config — an earlier
  // version of this fix baked resolveCatalogUpstream's baseUrl from
  // config.AWS_BEDROCK_REGION (the MANAGED path's operator setting), which
  // would have silently routed every BYOK Bedrock project to the operator's
  // region regardless of which region the project's own bearer token was
  // actually issued for. This test pins a project region that differs from
  // both the managed default (us-west-2) and the BYOK default (us-east-1) to
  // prove it's genuinely read from the project secret.
  test('BYOK Bedrock: standalone provider, builds a kind:bedrock descriptor from the PROJECT-OWNED bearer token + region', async () => {
    catalogUpstream = { envVar: 'AWS_BEARER_TOKEN_BEDROCK', kind: 'bedrock' };
    secretsByName = {
      AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer-key',
      AWS_REGION: 'eu-west-1',
    };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(p, 'amazon-bedrock/us.anthropic.claude-opus-4-8');
    expect(candidates[0]).toMatchObject({
      provider: 'amazon-bedrock',
      kind: 'bedrock',
      baseUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com',
      apiKey: 'bedrock-bearer-key',
      resolvedModel: 'us.anthropic.claude-opus-4-8',
    });
    // The bearer token AND the region are each looked up under their own
    // AWS-standard secret name, project-wide (shared) only — there is no
    // per-caller/private lookup.
    expect(getProjectSecretValue).toHaveBeenCalledWith('p1', 'AWS_BEARER_TOKEN_BEDROCK');
    expect(getProjectSecretValue).toHaveBeenCalledWith('p1', 'AWS_REGION');
  });

  test('BYOK Bedrock with no AWS_REGION set: falls back to the BYOK default (us-east-1), not the managed AWS_BEDROCK_REGION default', async () => {
    catalogUpstream = { envVar: 'AWS_BEARER_TOKEN_BEDROCK', kind: 'bedrock' };
    secretsByName = { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer-key', AWS_REGION: null };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(p, 'amazon-bedrock/us.anthropic.claude-opus-4-8');
    expect(candidates[0]).toMatchObject({
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    });
  });

  // Regression coverage for the $0 upstream-cost-hint bug: models.dev only
  // catalogs the BASE Bedrock model id, never the cross-region
  // inference-profile id the user actually requests — so the PRICING lookup
  // must strip the `us./eu./apac./us-gov.` prefix while `resolvedModel` (what
  // actually gets invoked) keeps the full profile id untouched.
  test('BYOK Bedrock: pricing lookup strips the cross-region inference-profile prefix, resolvedModel keeps it', async () => {
    catalogUpstream = { envVar: 'AWS_BEARER_TOKEN_BEDROCK', kind: 'bedrock' };
    secretsByName = { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer-key', AWS_REGION: 'eu-west-1' };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(p, 'amazon-bedrock/us.anthropic.claude-opus-4-8');

    expect(candidates[0]).toMatchObject({ resolvedModel: 'us.anthropic.claude-opus-4-8' });
    expect(livePricingCalls).toEqual(['anthropic.claude-opus-4-8']);
  });

  test('BYOK non-Bedrock provider: pricing lookup is never run through the Bedrock prefix-strip', async () => {
    catalogUpstream = {
      baseUrl: 'https://api.anthropic.com/v1',
      envVar: 'ANTHROPIC_API_KEY',
      kind: 'anthropic',
    };
    resolvedSecret = 'sk-user-key';
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    await resolveCandidates(p, 'anthropic/claude-sonnet-4.6');

    expect(livePricingCalls).toEqual(['claude-sonnet-4.6']);
  });

  test('Bedrock with no project key connected: provider_not_connected (never a silent managed fallback)', async () => {
    catalogUpstream = { envVar: 'AWS_BEARER_TOKEN_BEDROCK', kind: 'bedrock' };
    secretsByName = { AWS_BEARER_TOKEN_BEDROCK: null };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    await expect(
      resolveCandidates(p, 'amazon-bedrock/us.anthropic.claude-opus-4-8'),
    ).rejects.toMatchObject({ code: 'provider_not_connected' });
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

    await expect(
      resolveCandidates(principal(), 'anthropic/claude-sonnet-4.6'),
    ).rejects.toMatchObject({ code: 'provider_not_connected' });
  });

  // Regression coverage (2026-07-17 live defect report): a BYOK OpenRouter
  // call to a model NOT individually catalogued by models.dev — e.g.
  // OpenRouter's dynamic/no-catalog-price auto-router, `openrouter/
  // openrouter/fusion` — 502ed with an "Invalid URL" upstream error,
  // consistent with the resolved descriptor's `baseUrl` ending up empty for
  // that call. Root-caused: it does NOT (provider-registry.ts's
  // `resolveCatalogUpstream` resolves `baseUrl` from the PROVIDER, keyed by
  // `providerId` only — its signature carries no model parameter at all, so
  // it structurally cannot special-case "is this exact model individually
  // catalogued" — see provider-registry.test.ts's sibling regression test).
  // This test pins the OTHER half of that claim from resolveCandidates' own
  // side: for a model id that is CLEARLY not any real catalog entry, under a
  // connected BYOK provider, the resulting descriptor still carries the
  // provider's real (non-empty) baseUrl — resolveCandidates never drops,
  // nulls, or otherwise special-cases baseUrl based on the requested model
  // id. Live re-verified against dev (2026-07-17): both the in-process
  // gateway and the standalone gateway pod reach OpenRouter and bill
  // non-zero upstream cost for the exact real-world case
  // (`openrouter/openrouter/fusion`), streaming and non-streaming alike.
  test("BYOK OpenRouter: a model id models.dev has never heard of still resolves the connected provider's real baseUrl", async () => {
    catalogUpstream = {
      baseUrl: 'https://openrouter.ai/api/v1',
      envVar: 'OPENROUTER_API_KEY',
      kind: 'openai-compat',
    };
    resolvedSecret = 'sk-or-user-key';
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(
      p,
      'openrouter/definitely-not-a-real-catalog-model-xyz-123',
    );

    expect(candidates[0]).toMatchObject({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-user-key',
      resolvedModel: 'definitely-not-a-real-catalog-model-xyz-123',
    });
    expect(candidates[0].baseUrl).toBeTruthy();
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
