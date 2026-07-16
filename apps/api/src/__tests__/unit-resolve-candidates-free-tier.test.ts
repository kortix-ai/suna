import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

let billingEnabled = true;
let accountTier = 'free';
let accountTierCalls = 0;
// Defaults true here (cloud-shaped fixture): the real gate is covered by the
// managed-provider-disabled test suite (llm-gateway/models/managed-provider-disabled.test.ts),
// which imports the REAL (unmocked) descriptors.ts against the flag OFF. This
// file mocks descriptors.ts entirely (below), so this toggle only exercises
// resolveCandidates' OWN inline gate.
let managedProviderEnabled = true;

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  KORTIX_MARKUP: 1.2,
  PLATFORM_FEE_MARKUP: 0.1,
  config: new Proxy(
    {},
    {
      get: (target: Record<PropertyKey, unknown>, key) => {
        if (Object.hasOwn(target, key)) return target[key];
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return billingEnabled;
        if (key === 'KORTIX_MANAGED_PROVIDER_ENABLED') return managedProviderEnabled;
        if (key === 'LLM_GATEWAY_ENABLED') return true;
        if (key === 'LLM_GATEWAY_DEFAULT_ENABLED') return false;
        if (key === 'TUNNEL_ENABLED') return false;
        if (key === 'LLM_GATEWAY_BYOK_FALLBACK_MODEL') return 'claude-sonnet-4.6';
        if (key === 'LLM_GATEWAY_DEFAULT_MODEL') return 'codex/gpt-5.6-sol';
        if (key === 'LLM_GATEWAY_VISION_MODEL') return 'claude-sonnet-4.6';
        if (key === 'LLM_GATEWAY_FALLBACK_POLICIES') {
          return [{
            id: 'test-platform-default',
            models: ['codex/gpt-5.6-sol'],
            fallbackModels: ['glm-5.2'],
            fallbackOn: 'any-error',
          }];
        }
        return target[key];
      },
    },
  ),
  getToolCost: () => 0,
}));

mock.module('../billing/services/entitlements', () => ({
  getAccountTier: async () => {
    accountTierCalls += 1;
    return accountTier;
  },
}));

mock.module('../projects/secrets', () => ({
  decryptProjectSecret: (_projectId: string, value: string) => value,
  encryptProjectSecret: (_projectId: string, value: string) => value,
  getProjectSecretValue: async () => 'user-key',
  listProjectSecrets: async () => ({}),
  listProjectSecretsForUser: async () => ({}),
  listProjectSecretsSnapshot: async () => ({
    env: {},
    names: [],
    revision: 'empty',
  }),
  listProjectSecretsSnapshotForUser: async () => ({
    env: {},
    names: [],
    revision: 'empty',
  }),
  projectSecretsRevision: () => 'empty',
}));

mock.module('../llm-gateway/credentials/codex', () => ({
  resolveCodexCredential: async () => ({
    access: 'codex-token',
    accountId: 'chatgpt-account',
  }),
}));

mock.module('../llm-gateway/resolution/descriptors', () => ({
  codexDescriptor: (_credential: unknown, model: string) => ({
    provider: 'openai-codex',
    kind: 'openai-responses',
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    apiKey: 'codex-token',
    billingMode: 'none',
    markup: 0,
    resolvedModel: model.replace(/^codex\//, ''),
  }),
  livePricing: () => undefined,
  managedCandidates: (managed: { id: string; upstreamModelId?: string }) => [
    {
      provider: 'openrouter',
      kind: 'openai-chat',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      billingMode: 'credits',
      markup: 1.2,
      resolvedModel: managed.upstreamModelId ?? managed.id,
    },
  ],
}));

const { resolveCandidates } = await import('../llm-gateway/resolution/resolve-candidates');

function principal(accountId: string) {
  return {
    userId: `user-${accountId}`,
    accountId,
    projectId: `project-${accountId}`,
  };
}

describe('resolveCandidates free-tier premium gate', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    billingEnabled = true;
    accountTier = 'free';
    accountTierCalls = 0;
    managedProviderEnabled = true;
  });

  test('blocks managed premium candidates for free accounts', async () => {
    accountTier = 'free';
    const candidates = await resolveCandidates(principal('free-managed'), 'claude-sonnet-4.6');
    expect(candidates).toEqual([]);
    expect(accountTierCalls).toBe(1);
  });

  test('allows managed premium candidates for Team accounts', async () => {
    accountTier = 'per_seat';
    const candidates = await resolveCandidates(principal('team-managed'), 'claude-sonnet-4.6');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.billingMode).toBe('credits');
    expect(accountTierCalls).toBe(1);
  });

  test('resolves raw auto to the Codex GPT-5.6 Sol platform default for stale gateway callers', async () => {
    accountTier = 'per_seat';
    const candidates = await resolveCandidates(principal('team-auto'), 'auto');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.provider).toBe('openai-codex');
    expect(candidates[0]?.resolvedModel).toBe('gpt-5.6-sol');
    expect(accountTierCalls).toBe(0);
  });

  test('does not tier-gate the Codex platform default for free accounts with ChatGPT auth', async () => {
    accountTier = 'free';
    const candidates = await resolveCandidates(
      { ...principal('free-auto'), freeModelsOnly: true },
      'auto',
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.provider).toBe('openai-codex');
    expect(candidates[0]?.resolvedModel).toBe('gpt-5.6-sol');
    expect(accountTierCalls).toBe(0);
  });

  test('waives BYOK platform fee and disables managed fallback for free accounts', async () => {
    accountTier = 'free';
    const candidates = await resolveCandidates(principal('free-byok'), 'openai/gpt-4.1');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.billingMode).toBe('none');
    expect(candidates[0]?.markup).toBe(0);
    expect(candidates[0]?.apiKey).toBe('user-key');
    expect(accountTierCalls).toBe(1);
  });

  test('keeps BYOK platform fee and managed fallback for Team accounts', async () => {
    accountTier = 'per_seat';
    const candidates = await resolveCandidates(principal('team-byok'), 'openai/gpt-4.1');
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.billingMode).toBe('platform-fee');
    expect(candidates[0]?.markup).toBe(0.1);
    expect(candidates[1]?.billingMode).toBe('credits');
    expect(accountTierCalls).toBe(1);
  });

  test('does not tier-gate ChatGPT subscription candidates', async () => {
    accountTier = 'free';
    const candidates = await resolveCandidates(principal('free-codex'), 'codex/gpt-5');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.billingMode).toBe('none');
    expect(accountTierCalls).toBe(0);
  });

  test('keeps managed candidates available when internal billing is disabled AND the managed provider is explicitly on', async () => {
    billingEnabled = false;
    accountTier = 'free';
    managedProviderEnabled = true;
    const candidates = await resolveCandidates(principal('self-host-managed'), 'claude-sonnet-4.6');
    expect(candidates).toHaveLength(1);
    expect(accountTierCalls).toBe(0);
  });

  test('CLOUD-ONLY gate: blocks an explicitly-named managed model when KORTIX_MANAGED_PROVIDER_ENABLED is off, even for a paid tier', async () => {
    managedProviderEnabled = false;
    accountTier = 'per_seat';
    const candidates = await resolveCandidates(
      principal('self-host-flag-off'),
      'claude-sonnet-4.6',
    );
    expect(candidates).toEqual([]);
  });

  test('CLOUD-ONLY gate: a self-host BYOK request gets no managed fallback candidate appended when the flag is off', async () => {
    managedProviderEnabled = false;
    accountTier = 'per_seat';
    const candidates = await resolveCandidates(
      principal('self-host-byok-flag-off'),
      'openai/gpt-4.1',
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.billingMode).toBe('platform-fee');
  });
});
