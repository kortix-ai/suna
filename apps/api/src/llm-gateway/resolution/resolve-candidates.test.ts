import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { GatewayResolutionError } from '@kortix/llm-gateway';
import * as realTiers from '../../billing/services/tiers';

let modelAccess = { disabledProviders: [] as string[], disabledModels: [] as string[] };
mock.module('../../repositories/project-model-access', () => ({ getProjectModelAccess: async () => modelAccess }));

let tierByAccount: Record<string, string> = {};
const getAccountTier = mock(async (accountId: string) => tierByAccount[accountId] ?? 'pro');
// The TTL cache is the real `getCachedAccountTier` in billing-cache; its
// boundary is proven in __tests__/unit-account-tier-cache-unified.test.ts.
// Here both reads answer from the tier table, and the managed entitlement is
// the real tier rule: `credit` is a paid plan without managed models.
mock.module('../../billing/services/entitlements', () => ({
  getAccountTier,
  getCachedAccountTier: getAccountTier,
  accountMayUseManagedModels: async (accountId: string) =>
    !realTiers.accountIsFreeTierForModels(await getAccountTier(accountId)),
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
let resolvedSecrets: Array<{ identifier: string; value: string }> = [];
let pooledEnabled = false;
let pooledSecrets: { configured: boolean; coolingDown: boolean; retryAfterSeconds?: number; secrets: Array<{ secretId: string; label: string; value: string }> } = { configured: false, coolingDown: false, secrets: [] };
let defaultCodexSecret: { secretId: string; label: string; value: string } | null = null;
mock.module('../../feature-flags/for-project', () => ({ projectFeatureFlagEnabled: async () => pooledEnabled }));
const resolveSessionProviderSecrets = mock(async (_input: unknown) => pooledSecrets);
const resolveDefaultCodexAccountSecret = mock(async (..._args: unknown[]) => defaultCodexSecret);
// The project's shared ChatGPT accounts an unconfigured session falls back to.
// Which accounts are usable is the real SQL's job (integration-usable-gateway-
// secrets.test.ts); here the stub answers what that read returned.
let sharedSecrets: { coolingDown: boolean; retryAfterSeconds?: number; secrets: Array<{ secretId: string; label: string; value: string }> } = { coolingDown: false, secrets: [] };
const resolveProjectSharedProviderSecrets = mock(async (_input: unknown) => sharedSecrets);
mock.module('../../secrets/account-resource', () => ({
  resolveSessionProviderSecrets,
  resolveDefaultCodexAccountSecret,
  resolveProjectSharedProviderSecrets,
}));
const getProjectSecretValueForConsumer = mock(async (input: { name: string }) => {
  const name = input.name;
  if (name in secretsByName) return secretsByName[name] ?? null;
  return resolvedSecret;
});
const resolveProjectSecretsForConsumer = mock(async (input: { name: string }) => {
  if (resolvedSecrets.length > 0) return resolvedSecrets;
  const value = await getProjectSecretValueForConsumer(input);
  return value ? [{ identifier: input.name, value }] : [];
});
mock.module('../../projects/secrets', () => ({
  getProjectSecretValueForConsumer,
  resolveProjectSecretsForConsumer,
}));

class CodexRefreshError extends Error {}
let codexCredential: { access: string; accountId?: string } | null = null;
let codexThrows = false;
const resolveCodexCredential = mock(async () => {
  if (codexThrows) throw new CodexRefreshError('codex refresh failed');
  return codexCredential;
});
// Account secrets whose OAuth refresh throws `CodexRefreshError`.
let codexAccountRefreshFails = new Set<string>();
const resolveCodexAccountCredential = mock(async (input: { value: string; secretId?: string }) => {
  if (input.secretId && codexAccountRefreshFails.has(input.secretId)) throw new CodexRefreshError('revoked');
  const parsed = JSON.parse(input.value) as { openai?: { access?: string } };
  return parsed.openai?.access ? { access: parsed.openai.access } : null;
});
mock.module('../credentials/codex', () => ({
  CHATGPT_CODEX_BASE_URL: 'https://codex.test',
  CODEX_USER_AGENT: 'codex-test',
  resolveCodexCredential,
  resolveCodexAccountCredential,
  CodexRefreshError,
}));

// The Bedrock URL, region, and prefix helpers are the real ones. Only the
// managed and Codex descriptors and the pricing lookup are stubbed; the
// pricing stub records every id it is asked for, in call order.
let livePricingCalls: string[] = [];
const realDescriptors = await import('./descriptors');
mock.module('./descriptors', () => ({
  ...realDescriptors,
  codexDescriptor: (credential: { access: string }, model: string) => ({
    provider: 'openai-codex',
    kind: 'openai-responses',
    baseUrl: 'https://codex.test',
    apiKey: credential.access,
    billingMode: 'none',
    markup: 0,
    resolvedModel: model,
  }),
  livePricing: (providerId: string, modelId: string) => {
    livePricingCalls.push(`${providerId}/${modelId}`);
    return undefined;
  },
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

let catalogUpstream: { baseUrl?: string; envVar: string; kind: string } | null = null;
mock.module('../models/provider-registry', () => ({
  resolveCatalogUpstream: () => catalogUpstream,
}));

mock.module('../routing', () => ({
  resolveGatewayRoute: async () => ({ primaryModel: 'anthropic/claude-sonnet-4.6' }),
}));

let runtimeManagedModel: { id: string } | undefined;
let knownManagedModelId: string | null = null;
const managedModels = await import('../models/managed-models');
mock.module('../models/managed-models', () => ({
  ...managedModels,
  RUNTIME_MANAGED_MODELS: [],
  getRuntimeManagedModel: (id: string) =>
    runtimeManagedModel?.id === id ? runtimeManagedModel : undefined,
  isRuntimeManagedModelId: (id: string) => runtimeManagedModel?.id === id,
  isKnownManagedModelId: (id: string) => id === knownManagedModelId,
}));

let capabilities = { reasoning: false, temperature: true };
mock.module('../models/catalog-models', () => ({
  capabilitiesForModel: () => capabilities,
  gatewayModelCatalog: () => ({}),
}));

const { resolveCandidates } = await import('./resolve-candidates');

function principal(overrides: Record<string, unknown> = {}) {
  return { userId: 'u1', accountId: crypto.randomUUID(), projectId: 'p1', ...overrides };
}

beforeEach(() => {
  pooledEnabled = false;
  resolveSessionProviderSecrets.mockClear();
  pooledSecrets = { configured: false, coolingDown: false, secrets: [] };
  defaultCodexSecret = null;
  resolveDefaultCodexAccountSecret.mockClear();
  sharedSecrets = { coolingDown: false, secrets: [] };
  resolveProjectSharedProviderSecrets.mockClear();
  tierByAccount = {};
  modelAccess = { disabledProviders: [], disabledModels: [] };
  for (const key of Object.keys(config)) delete config[key];
  Object.assign(config, {
    LLM_GATEWAY_ENABLED: true,
    KORTIX_MANAGED_PROVIDER_ENABLED: true,
    KORTIX_BILLING_INTERNAL_ENABLED: true,
    LLM_GATEWAY_BYOK_FALLBACK_MODEL: 'anthropic/claude-sonnet-4.6',
  });
  resolvedSecret = null;
  secretsByName = {};
  resolvedSecrets = [];
  codexCredential = null;
  codexThrows = false;
  codexAccountRefreshFails = new Set();
  catalogUpstream = null;
  runtimeManagedModel = undefined;
  knownManagedModelId = null;
  capabilities = { reasoning: false, temperature: true };
  livePricingCalls = [];
  getAccountTier.mockClear();
  getProjectSecretValueForConsumer.mockClear();
  resolveProjectSecretsForConsumer.mockClear();
  resolveCodexCredential.mockClear();
  resolveCodexAccountCredential.mockClear();
});

describe('resolveCandidates — selected account key pool', () => {
  test('the flag preserves legacy keys until enabled, then selects only granted pool keys', async () => {
    catalogUpstream = { baseUrl: 'https://api.anthropic.com/v1', envVar: 'ANTHROPIC_API_KEY', kind: 'anthropic' };
    resolvedSecrets = [{ identifier: 'legacy', value: 'legacy-value' }];
    pooledSecrets = { configured: true, coolingDown: false, secrets: [
      { secretId: 'id-a', label: 'A', value: 'key-a' },
      { secretId: 'id-b', label: 'B', value: 'key-b' },
    ] };
    const p = principal({ sessionId: 'session-1' });
    expect((await resolveCandidates(p, 'anthropic/claude-sonnet-4.6'))[0]?.credentialRef).toBe('legacy');
    pooledEnabled = true;
    const candidates = await resolveCandidates(p, 'anthropic/claude-sonnet-4.6');
    expect(candidates.map((candidate) => candidate.poolSecretId)).toEqual(['id-a', 'id-b']);
    expect(candidates.map((candidate) => candidate.apiKey)).toEqual(['key-a', 'key-b']);
  });

  test('a narrowed agent grant blocks the pool at use time', async () => {
    catalogUpstream = { baseUrl: 'https://api.anthropic.com/v1', envVar: 'ANTHROPIC_API_KEY', kind: 'anthropic' };
    pooledEnabled = true;
    pooledSecrets = { configured: true, coolingDown: false, secrets: [{ secretId: 'id-a', label: 'A', value: 'key-a' }] };
    await expect(resolveCandidates(principal({ sessionId: 'session-1', agentGrant: { env: [] } }),
      'anthropic/claude-sonnet-4.6')).rejects.toMatchObject({ code: 'provider_not_connected' });
  });

  test('an exhausted selected pool returns a rate-limit reason and never uses a legacy key', async () => {
    catalogUpstream = { baseUrl: 'https://api.anthropic.com/v1', envVar: 'ANTHROPIC_API_KEY', kind: 'anthropic' };
    pooledEnabled = true;
    resolvedSecrets = [{ identifier: 'legacy', value: 'legacy-value' }];
    pooledSecrets = { configured: true, coolingDown: true, retryAfterSeconds: 7, secrets: [] };
    await expect(resolveCandidates(principal({ sessionId: 'session-1' }),
      'anthropic/claude-sonnet-4.6')).rejects.toMatchObject({ code: 'provider_pool_rate_limited', retryAfterSeconds: 7 });
  });
});

describe('resolveCandidates — BYOK billing', () => {
  // BYOK bills the provider account directly. The tier and the billing switch
  // must not change that, and a managed model registered under the same id
  // must never be appended as a fallback.
  test.each([
    ['a paid account', 'pro', true],
    ['a free account', 'free', true],
    ['a self-hosted deployment with billing off', 'pro', false],
  ] as const)('%s: a BYOK key is charged nothing and gets no managed fallback', async (_name, tier, billing) => {
    config.KORTIX_BILLING_INTERNAL_ENABLED = billing;
    catalogUpstream = {
      baseUrl: 'https://api.anthropic.com/v1',
      envVar: 'ANTHROPIC_API_KEY',
      kind: 'anthropic',
    };
    resolvedSecrets = [{ identifier: 'ANTHROPIC_API_KEY', value: 'sk-user-key' }];
    runtimeManagedModel = { id: 'anthropic/claude-sonnet-4.6' };
    const p = principal();
    tierByAccount[p.accountId] = tier;

    expect(await resolveCandidates(p, 'anthropic/claude-sonnet-4.6')).toEqual([
      expect.objectContaining({
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com/v1',
        resolvedModel: 'claude-sonnet-4.6',
        billingMode: 'none',
        markup: 0,
        apiKey: 'sk-user-key',
        credentialRef: 'ANTHROPIC_API_KEY',
      }),
    ]);
  });

  test('queues every provider credential without a managed fallback', async () => {
    catalogUpstream = {
      baseUrl: 'https://api.anthropic.com/v1',
      envVar: 'ANTHROPIC_API_KEY',
      kind: 'anthropic',
    };
    resolvedSecrets = [
      { identifier: 'primary', value: 'sk-primary' },
      { identifier: 'secondary', value: 'sk-secondary' },
    ];
    runtimeManagedModel = { id: 'anthropic/claude-sonnet-4.6' };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(p, 'anthropic/claude-sonnet-4.6');

    expect(candidates).toHaveLength(2);
    expect(candidates.map((candidate) => candidate.credentialRef)).toEqual(['primary', 'secondary']);
    expect(candidates.map((candidate) => candidate.apiKey)).toEqual(['sk-primary', 'sk-secondary']);
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
  // transport with the user's own credentials.
  // KORTIX_MANAGED_PROVIDER_ENABLED is irrelevant here.
  //
  // Regression coverage: the region MUST come from the project's OWN
  // AWS_REGION secret, never from deployment/operator config — an earlier
  // version of this fix baked resolveCatalogUpstream's baseUrl from
  // an operator-wide region, which would have silently routed every BYOK
  // Bedrock project away from its own region. This test pins a project region
  // that differs from the BYOK default (us-east-1) to
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
      // Region-normalized: a `us.` inference profile 400s on an eu-west-1
      // endpoint, so the invoke id is rewritten to the endpoint's geography.
      resolvedModel: 'eu.anthropic.claude-opus-4-8',
    });
    // The bearer token AND the region are each looked up under their own
    // AWS-standard secret name, project-wide (shared) only — there is no
    // per-caller/private lookup.
    expect(getProjectSecretValueForConsumer).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'p1',
        name: 'AWS_BEARER_TOKEN_BEDROCK',
        consumer: 'llm_gateway',
      }),
    );
    expect(getProjectSecretValueForConsumer).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p1', name: 'AWS_REGION', consumer: 'llm_gateway' }),
    );
  });

  test('BYOK Bedrock with no AWS_REGION set: falls back to us-east-1', async () => {
    catalogUpstream = { envVar: 'AWS_BEARER_TOKEN_BEDROCK', kind: 'bedrock' };
    secretsByName = { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer-key', AWS_REGION: null };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(p, 'amazon-bedrock/us.anthropic.claude-opus-4-8');
    expect(candidates[0]).toMatchObject({
      baseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    });
  });

  test('BYOK Bedrock: an AWS_REGION that is not a region name is refused before any endpoint is built', async () => {
    catalogUpstream = { envVar: 'AWS_BEARER_TOKEN_BEDROCK', kind: 'bedrock' };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';
    for (const region of ['x@example.test/', 'example.test#', 'us-east-1.example.test', 'us-east-1/']) {
      secretsByName = { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer-key', AWS_REGION: region };
      await expect(resolveCandidates(p, 'amazon-bedrock/us.anthropic.claude-opus-4-8')).rejects.toMatchObject({
        code: 'provider_not_connected',
      });
    }
  });

  test('BYOK Bedrock: a padded region name is trimmed and accepted', async () => {
    catalogUpstream = { envVar: 'AWS_BEARER_TOKEN_BEDROCK', kind: 'bedrock' };
    secretsByName = { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer-key', AWS_REGION: ' us-gov-west-1 ' };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';
    const candidates = await resolveCandidates(p, 'amazon-bedrock/us.anthropic.claude-opus-4-8');
    expect(candidates[0]).toMatchObject({
      baseUrl: 'https://bedrock-runtime.us-gov-west-1.amazonaws.com',
      region: 'us-gov-west-1',
    });
  });

  // Regression coverage for the $0 upstream-cost-hint bug: models.dev only
  // catalogs the BASE Bedrock model id, never the cross-region
  // inference-profile id the user actually requests — so the PRICING lookup
  // must strip the `us./eu./apac./us-gov.` prefix while `resolvedModel` (what
  // actually gets invoked) keeps a full profile id. Here the requested `us.`
  // profile is first region-normalized to `eu.` (eu-west-1 endpoint), then the
  // pricing lookup strips THAT to the same base id.
  test('BYOK Bedrock: resolvedModel is region-normalized, pricing still strips to the base id', async () => {
    catalogUpstream = { envVar: 'AWS_BEARER_TOKEN_BEDROCK', kind: 'bedrock' };
    secretsByName = { AWS_BEARER_TOKEN_BEDROCK: 'bedrock-bearer-key', AWS_REGION: 'eu-west-1' };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(p, 'amazon-bedrock/us.anthropic.claude-opus-4-8');

    expect(candidates[0]).toMatchObject({ resolvedModel: 'eu.anthropic.claude-opus-4-8' });
    expect(livePricingCalls).toEqual(['amazon-bedrock/anthropic.claude-opus-4-8']);
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

    expect(livePricingCalls).toEqual(['anthropic/claude-sonnet-4.6']);
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
});

describe('resolveCandidates — managed model tier gating', () => {
  test('freeModelsOnly principal throws plan_upgrade_required before any tier lookup', async () => {
    runtimeManagedModel = { id: 'glm-5.3-flash' };

    await expect(
      resolveCandidates(principal({ freeModelsOnly: true }), 'glm-5.3-flash'),
    ).rejects.toMatchObject({ code: 'plan_upgrade_required' });
    expect(getAccountTier).not.toHaveBeenCalled();
  });

  // Both refusals keep the machine-readable `plan_upgrade_required`; clients
  // branch on the code. The copy differs: a free plan is told to upgrade, a
  // paid plan without managed models is told to bring a key, never to upgrade.
  test.each([
    [
      'a free account is told to upgrade',
      'free',
      '"glm-5.3-flash" requires a paid plan.',
      'Upgrade your plan to use this model, or choose a model available on your current plan.',
    ],
    [
      'a paid plan without managed models is told to bring a key',
      'credit',
      '"glm-5.3-flash" needs your own provider key on this plan.',
      'This plan does not include managed models. Add your own provider key to use this model, or pick a model your key covers.',
    ],
  ] as const)('%s', async (_name, tier, message, suggestion) => {
    runtimeManagedModel = { id: 'glm-5.3-flash' };
    const p = principal();
    tierByAccount[p.accountId] = tier;

    await expect(resolveCandidates(p, 'glm-5.3-flash')).rejects.toMatchObject({
      code: 'plan_upgrade_required',
      message,
      suggestion,
    });
  });

  test('paid-tier account gets the managed candidates', async () => {
    runtimeManagedModel = { id: 'glm-5.3-flash' };
    const p = principal();
    tierByAccount[p.accountId] = 'pro';

    const candidates = await resolveCandidates(p, 'glm-5.3-flash');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ provider: 'kortix-managed' });
  });

  test('a known managed model with the provider disabled throws model_disabled_on_deployment', async () => {
    config.KORTIX_MANAGED_PROVIDER_ENABLED = false;
    runtimeManagedModel = { id: 'glm-5.3-flash' };
    knownManagedModelId = 'glm-5.3-flash';

    await expect(resolveCandidates(principal(), 'glm-5.3-flash')).rejects.toMatchObject({
      code: 'model_disabled_on_deployment',
    });
  });
});

describe('resolveCandidates — codex + unknown provider', () => {
  test('a shared project gateway key never borrows its creator’s personal ChatGPT account', async () => {
    pooledEnabled = true;
    codexCredential = { access: 'legacy-token' };
    defaultCodexSecret = { secretId: 'private', label: 'Private account', value: JSON.stringify({ openai: { access: 'private-token' } }) };
    const candidates = await resolveCandidates(principal({ keyId: 'shared-project-key' }), 'codex/gpt-5.5');
    expect(candidates.map((candidate) => candidate.apiKey)).toEqual(['legacy-token']);
  });

  test('an unselected session uses the caller’s newest personal ChatGPT account', async () => {
    pooledEnabled = true;
    codexCredential = { access: 'legacy-token' };
    defaultCodexSecret = { secretId: 'mine', label: 'My account', value: JSON.stringify({ openai: { access: 'mine-token' } }) };
    const candidates = await resolveCandidates(principal({ sessionId: 'session-1' }), 'codex/gpt-5.5');
    expect(candidates.map((candidate) => [candidate.credentialRef, candidate.apiKey])).toEqual([['mine', 'mine-token']]);
    expect(resolveCodexCredential).not.toHaveBeenCalled();
  });

  test('a selected ChatGPT pool uses separate OAuth accounts and never the project login', async () => {
    pooledEnabled = true;
    codexCredential = { access: 'legacy-token' };
    pooledSecrets = { configured: true, coolingDown: false, secrets: [
      { secretId: 'account-a', label: 'Personal', value: JSON.stringify({ openai: { access: 'oauth-a' } }) },
      { secretId: 'account-b', label: 'Team', value: JSON.stringify({ openai: { access: 'oauth-b' } }) },
    ] };
    const candidates = await resolveCandidates(principal({ sessionId: 'session-1' }), 'codex/gpt-5.5');
    expect(candidates.map((candidate) => [candidate.poolSecretId, candidate.apiKey])).toEqual([
      ['account-a', 'oauth-a'], ['account-b', 'oauth-b'],
    ]);
    expect(resolveCodexCredential).not.toHaveBeenCalled();
  });

  test('codex provider without a projectId throws provider_not_connected', async () => {
    await expect(
      resolveCandidates(principal({ projectId: undefined }), 'codex/gpt-5.5'),
    ).rejects.toMatchObject({ code: 'provider_not_connected' });
  });

  test('codex provider resolves to the codex descriptor when a credential exists', async () => {
    codexCredential = { access: 'codex-token' };
    const candidates = await resolveCandidates(
      principal({ accountId: 'acct-1', sessionId: 'session-1' }),
      'codex/gpt-5.5',
    );
    expect(candidates).toEqual([
      expect.objectContaining({
        provider: 'openai-codex',
        apiKey: 'codex-token',
        resolvedModel: 'codex/gpt-5.5',
      }),
    ]);
    expect(resolveCodexCredential).toHaveBeenCalledWith('p1', 'u1', undefined, {
      accountId: 'acct-1',
      sessionId: 'session-1',
      // Legacy principal (no personalUserId): the personal override owner is the token user.
      principalUserId: 'u1',
    });
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

describe('explicit project model access', () => {
  test('disabled provider fails before any credential is read', async () => {
    modelAccess.disabledProviders = ['anthropic'];
    await expect(resolveCandidates(principal(), 'anthropic/test')).rejects.toMatchObject({ code: 'provider_disabled' });
    expect(resolveProjectSecretsForConsumer).not.toHaveBeenCalled();
  });
  test('disabled model fails before any credential is read', async () => {
    modelAccess.disabledModels = ['codex/test'];
    await expect(resolveCandidates(principal(), 'codex/test')).rejects.toMatchObject({ code: 'model_disabled' });
    expect(resolveCodexCredential).not.toHaveBeenCalled();
  });
  test('a Kortix-managed disable leaves a BYOK request on its own key', async () => {
    modelAccess.disabledProviders = ['kortix'];
    catalogUpstream = { baseUrl: 'https://api.anthropic.com/v1', envVar: 'ANTHROPIC_API_KEY', kind: 'anthropic' };
    resolvedSecrets = [{ identifier: 'key', value: 'sk-test' }];
    const candidates = await resolveCandidates(principal(), 'anthropic/test');
    expect(candidates.map((candidate) => candidate.credentialRef)).toEqual(['key']);
  });
  test('a Kortix-managed disable refuses a managed model before any tier or credential read', async () => {
    modelAccess.disabledProviders = ['kortix'];
    runtimeManagedModel = { id: 'glm-5.3-flash' };
    await expect(resolveCandidates(principal(), 'glm-5.3-flash')).rejects.toMatchObject({ code: 'provider_disabled' });
    expect(getAccountTier).not.toHaveBeenCalled();
  });
});

test('a prospective ChatGPT pool validates through the same member-bound resolver before a session exists', async () => {
  pooledEnabled = true;
  pooledSecrets = { configured: true, coolingDown: false, secrets: [
    { secretId: 'shared', label: 'Shared', value: JSON.stringify({ openai: { access: 'shared-token' } }) },
  ] };
  const actor = principal();
  const candidates = await resolveCandidates(actor, 'codex/gpt-5.5', { providerSecretPools: { codex: ['shared'] } });
  expect(candidates.map(candidate => candidate.poolSecretId)).toEqual(['shared']);
  expect(resolveSessionProviderSecrets).toHaveBeenCalledWith({ accountId: actor.accountId, projectId: actor.projectId, userId: actor.userId, grantUserId: actor.userId, providerId: 'codex', name: 'CODEX_AUTH_JSON', secretIds: ['shared'] });
  expect(resolveCodexAccountCredential).toHaveBeenCalledWith(expect.objectContaining({ sessionId: null }));
});

test('an explicitly empty prospective pool never borrows the legacy project credential', async () => {
  pooledEnabled = true;
  codexCredential = { access: 'legacy-token' };
  pooledSecrets = { configured: true, coolingDown: false, secrets: [] };
  await expect(resolveCandidates(principal(), 'codex/gpt-5.5', { providerSecretPools: { codex: [] } })).rejects.toMatchObject({ code: 'provider_not_connected' });
  expect(resolveCodexCredential).not.toHaveBeenCalled();
});

// Incident 2026-09-26: with `pooled_provider_secrets` ON, a ChatGPT account
// shared with "Everyone in this project" reached only sessions with an explicit
// pool or the member who created it. Slack, cron-trigger, and agent-started
// sessions have no pool row, so they fell through to the legacy project
// connection and failed with `provider_not_connected`.
describe('resolveCandidates — codex, unconfigured session, project-shared ChatGPT accounts', () => {
  const account = (secretId: string, access: string | null) => ({
    secretId, label: secretId, value: JSON.stringify({ openai: access ? { access } : {} }),
  });

  test('an agent-principal session (no on-behalf-of human) uses a project-shared account', async () => {
    pooledEnabled = true;
    sharedSecrets = { coolingDown: false, secrets: [account('team', 'team-token')] };
    const actor = principal({ sessionId: 'trigger-session', personalUserId: null });
    const candidates = await resolveCandidates(actor, 'codex/gpt-6');
    expect(candidates.map((c) => [c.credentialRef, c.poolSecretId, c.apiKey])).toEqual([['team', 'team', 'team-token']]);
    expect(resolveProjectSharedProviderSecrets).toHaveBeenCalledWith({
      accountId: actor.accountId, projectId: 'p1', userId: 'u1', grantUserId: null,
      providerId: 'codex', name: 'CODEX_AUTH_JSON',
    });
    expect(resolveDefaultCodexAccountSecret).not.toHaveBeenCalled();
    expect(resolveCodexCredential).not.toHaveBeenCalled();
  });

  test('a member who did not create the shared account uses it', async () => {
    pooledEnabled = true;
    sharedSecrets = { coolingDown: false, secrets: [account('team', 'team-token')] };
    const actor = principal({ userId: 'u2', sessionId: 'slack-session' });
    const candidates = await resolveCandidates(actor, 'codex/gpt-6');
    expect(candidates.map((c) => c.apiKey)).toEqual(['team-token']);
    expect(resolveDefaultCodexAccountSecret).toHaveBeenCalledWith(actor.accountId, 'p1', 'u2');
    expect(resolveProjectSharedProviderSecrets).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u2', grantUserId: 'u2' }));
    expect(resolveCodexCredential).not.toHaveBeenCalled();
  });

  test('a member-restricted account the principal is not granted stays unusable: provider_not_connected', async () => {
    pooledEnabled = true;
    // The usable-key read filtered it out; nothing shared remains.
    sharedSecrets = { coolingDown: false, secrets: [] };
    await expect(resolveCandidates(principal({ sessionId: 's', personalUserId: null }), 'codex/gpt-6'))
      .rejects.toMatchObject({ code: 'provider_not_connected' });
  });

  test('an explicit session pool still wins over the shared accounts', async () => {
    pooledEnabled = true;
    pooledSecrets = { configured: true, coolingDown: false, secrets: [account('picked', 'picked-token')] };
    sharedSecrets = { coolingDown: false, secrets: [account('team', 'team-token')] };
    const candidates = await resolveCandidates(principal({ sessionId: 's' }), 'codex/gpt-6');
    expect(candidates.map((c) => c.apiKey)).toEqual(['picked-token']);
    expect(resolveProjectSharedProviderSecrets).not.toHaveBeenCalled();
  });

  test('the caller’s personal account is still preferred over the shared accounts', async () => {
    pooledEnabled = true;
    defaultCodexSecret = account('mine', 'mine-token');
    sharedSecrets = { coolingDown: false, secrets: [account('team', 'team-token')] };
    const candidates = await resolveCandidates(principal({ sessionId: 's' }), 'codex/gpt-6');
    expect(candidates.map((c) => c.apiKey)).toEqual(['mine-token']);
    expect(resolveProjectSharedProviderSecrets).not.toHaveBeenCalled();
  });

  test('the shared accounts are preferred over the legacy project connection', async () => {
    pooledEnabled = true;
    codexCredential = { access: 'legacy-token' };
    sharedSecrets = { coolingDown: false, secrets: [account('team', 'team-token')] };
    const candidates = await resolveCandidates(principal({ sessionId: 's', personalUserId: null }), 'codex/gpt-6');
    expect(candidates.map((c) => c.apiKey)).toEqual(['team-token']);
    expect(resolveCodexCredential).not.toHaveBeenCalled();
  });

  test('an expired shared account falls through to the next one, oldest first', async () => {
    pooledEnabled = true;
    sharedSecrets = { coolingDown: false, secrets: [account('old-expired', null), account('newer', 'newer-token'), account('newest', 'newest-token')] };
    const candidates = await resolveCandidates(principal({ sessionId: 's', personalUserId: null }), 'codex/gpt-6');
    expect(candidates.map((c) => c.poolSecretId)).toEqual(['newer', 'newest']);
  });

  test('a shared account whose refresh throws is treated as expired, not as a crash', async () => {
    pooledEnabled = true;
    sharedSecrets = { coolingDown: false, secrets: [account('broken', 'x'), account('ok', 'ok-token')] };
    codexAccountRefreshFails = new Set(['broken']);
    const candidates = await resolveCandidates(principal({ sessionId: 's', personalUserId: null }), 'codex/gpt-6');
    expect(candidates.map((c) => c.poolSecretId)).toEqual(['ok']);
  });

  test('every shared account expired and no legacy connection: provider_reauth_required, not provider_not_connected', async () => {
    pooledEnabled = true;
    sharedSecrets = { coolingDown: false, secrets: [account('a', null), account('b', null)] };
    await expect(resolveCandidates(principal({ sessionId: 's', personalUserId: null }), 'codex/gpt-6'))
      .rejects.toMatchObject({ code: 'provider_reauth_required' });
  });

  test('every shared account expired but a legacy connection exists: the legacy connection serves', async () => {
    pooledEnabled = true;
    codexCredential = { access: 'legacy-token' };
    sharedSecrets = { coolingDown: false, secrets: [account('a', null)] };
    const candidates = await resolveCandidates(principal({ sessionId: 's', personalUserId: null }), 'codex/gpt-6');
    expect(candidates.map((c) => c.apiKey)).toEqual(['legacy-token']);
  });

  test('every shared account cooling down and no legacy connection: provider_pool_rate_limited with retry-after', async () => {
    pooledEnabled = true;
    sharedSecrets = { coolingDown: true, retryAfterSeconds: 9, secrets: [] };
    await expect(resolveCandidates(principal({ sessionId: 's', personalUserId: null }), 'codex/gpt-6'))
      .rejects.toMatchObject({ code: 'provider_pool_rate_limited', retryAfterSeconds: 9 });
  });

  test('an agent whose secret grant omits CODEX_AUTH_JSON never uses a shared account', async () => {
    pooledEnabled = true;
    sharedSecrets = { coolingDown: false, secrets: [account('team', 'team-token')] };
    const actor = principal({ sessionId: 's', personalUserId: null, agentGrant: { env: ['OTHER'] } });
    await expect(resolveCandidates(actor, 'codex/gpt-6')).rejects.toMatchObject({
      code: 'provider_not_connected', message: 'The running agent cannot use ChatGPT connections.',
    });
    expect(resolveCodexAccountCredential).not.toHaveBeenCalled();
    // The legacy project connection it could use before this change still serves it.
    codexCredential = { access: 'legacy-token' };
    expect((await resolveCandidates(actor, 'codex/gpt-6')).map((c) => c.apiKey)).toEqual(['legacy-token']);
  });

  test('an agent without the grant gets the grant refusal, not a cooldown, when every shared account cools down', async () => {
    pooledEnabled = true;
    sharedSecrets = { coolingDown: true, retryAfterSeconds: 9, secrets: [] };
    const actor = principal({ sessionId: 's', personalUserId: null, agentGrant: { env: ['OTHER'] } });
    await expect(resolveCandidates(actor, 'codex/gpt-6')).rejects.toMatchObject({
      code: 'provider_not_connected', message: 'The running agent cannot use ChatGPT connections.',
    });
  });

  test('a project gateway API key (keyId) keeps the legacy-only behavior', async () => {
    pooledEnabled = true;
    codexCredential = { access: 'legacy-token' };
    sharedSecrets = { coolingDown: false, secrets: [account('team', 'team-token')] };
    const candidates = await resolveCandidates(principal({ keyId: 'kgw' }), 'codex/gpt-6');
    expect(candidates.map((c) => c.apiKey)).toEqual(['legacy-token']);
    expect(resolveProjectSharedProviderSecrets).not.toHaveBeenCalled();
  });

  test('flag off: shared accounts are never read', async () => {
    pooledEnabled = false;
    codexCredential = { access: 'legacy-token' };
    sharedSecrets = { coolingDown: false, secrets: [account('team', 'team-token')] };
    const candidates = await resolveCandidates(principal({ sessionId: 's' }), 'codex/gpt-6');
    expect(candidates.map((c) => c.apiKey)).toEqual(['legacy-token']);
    expect(resolveProjectSharedProviderSecrets).not.toHaveBeenCalled();
  });
});
