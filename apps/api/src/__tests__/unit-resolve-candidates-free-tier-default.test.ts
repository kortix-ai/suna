import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// KRTX-1067: the platform default is the ONE managed model a free-tier account
// may run (it is what makes a fresh free account usable — `model-defaults`
// advertises `platformDefault` + `freeTier: true`). Every other managed id
// still refuses with `plan_upgrade_required`.
//
// This file's config names the platform default as a SERVED MANAGED model
// (`deepseek-v4.1-flash`), unlike unit-resolve-candidates-free-tier.test.ts,
// whose config default is a codex ref — there the free-default allowance is
// unreachable because codex never reaches the managed route.

mock.module('../repositories/project-model-access', () => ({
  getProjectModelAccess: async () => ({ disabledProviders: [], disabledModels: [] }),
  getProjectGatewayResolution: async () => ({
    access: { disabledProviders: [], disabledModels: [] },
    pooledEnabled: false,
  }),
}));
mock.module('../feature-flags/for-project', () => ({ projectFeatureFlagEnabled: async () => false }));

let accountMayUseManaged = false;

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  config: new Proxy(
    {},
    {
      get: (target: Record<PropertyKey, unknown>, key) => {
        if (Object.hasOwn(target, key)) return target[key];
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return true;
        if (key === 'KORTIX_MANAGED_PROVIDER_ENABLED') return true;
        if (key === 'LLM_GATEWAY_ENABLED') return true;
        if (key === 'LLM_GATEWAY_DEFAULT_MODEL') return 'deepseek-v4.1-flash';
        if (key === 'LLM_GATEWAY_DEFAULT_ENABLED') return false;
        if (key === 'TUNNEL_ENABLED') return false;
        return target[key];
      },
    },
  ),
  getToolCost: () => 0,
}));

mock.module('../billing/services/entitlements', () => ({
  getCachedAccountTier: async () => 'free',
  getAccountTier: async () => 'free',
  accountMayUseManagedModels: async () => accountMayUseManaged,
}));

mock.module('../projects/secrets', () => ({
  decryptProjectSecret: (_projectId: string, value: string) => value,
  encryptProjectSecret: (_projectId: string, value: string) => value,
  getProjectSecretValue: async () => 'user-key',
  getProjectSecretValueForConsumer: async () => 'user-key',
  resolveProjectSecretForConsumer: async () => 'user-key',
  resolveProjectSecretsForConsumer: async (input: { name: string }) => [
    { identifier: input.name, value: 'user-key' },
  ],
  listProjectSecrets: async () => ({}),
  listProjectSecretsForUser: async () => ({}),
  listProjectSecretsSnapshot: async () => ({ env: {}, names: [], revision: 'empty' }),
  listProjectSecretNamesForConsumer: async () => [],
  listProjectSecretsSnapshotForUser: async () => ({ env: {}, names: [], revision: 'empty' }),
  projectSecretsRevision: () => 'empty',
}));

const mockManagedCandidates = (managed: { id: string; upstreamModelId?: string }) => [
  {
    provider: 'openrouter',
    kind: 'openai-chat',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'managed-key',
    billingMode: 'credits',
    markup: 1.2,
    resolvedModel: managed.upstreamModelId ?? managed.id,
  },
];

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
  managedCandidates: mockManagedCandidates,
  managedTransportAvailable: (managed: { id: string; upstreamModelId?: string }) =>
    mockManagedCandidates(managed).length > 0,
  bedrockByokBaseUrl: (region: string | null | undefined) =>
    `https://bedrock-runtime.${region?.trim() || 'us-east-1'}.amazonaws.com`,
  normalizeBedrockInferenceProfileRegion: (model: string) => model,
  stripBedrockInferenceProfilePrefix: (model: string) => model,
}));

const { resolveCandidates } = await import('../llm-gateway/resolution/resolve-candidates');

function principal(accountId: string) {
  return {
    userId: `user-${accountId}`,
    accountId,
    projectId: `project-${accountId}`,
    freeModelsOnly: true,
  };
}

describe('resolveCandidates — the platform default is servable on the free tier', () => {
  afterAll(() => {
    mock.restore();
  });

  beforeEach(() => {
    accountMayUseManaged = false;
  });

  test('a free account resolves the platform default as a managed (credits) candidate', async () => {
    const candidates = await resolveCandidates(principal('free-default'), 'deepseek-v4.1-flash');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.billingMode).toBe('credits');
    expect(candidates[0]?.provider).toBe('openrouter');
  });

  test('the kortix/-prefixed opencode ref of the platform default resolves too', async () => {
    const candidates = await resolveCandidates(principal('free-default'), 'kortix/deepseek-v4.1-flash');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.billingMode).toBe('credits');
  });

  test('every other managed model still refuses with plan_upgrade_required', async () => {
    await expect(
      resolveCandidates(principal('free-managed'), 'glm-5.3-flash'),
    ).rejects.toMatchObject({
      name: 'GatewayResolutionError',
      code: 'plan_upgrade_required',
    });
  });

  test('a paid account is unchanged: any managed model resolves', async () => {
    accountMayUseManaged = true;
    const candidates = await resolveCandidates(
      { ...principal('paid'), freeModelsOnly: false },
      'glm-5.3-flash',
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.billingMode).toBe('credits');
  });
});
