import { describe, expect, mock, test } from 'bun:test';

const configuredModels = [
  {
    id: 'glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    upstreamModelId: 'z-ai/glm-5.3-flash',
    transport: 'openrouter',
    pricingRef: 'openrouter/z-ai/glm-5.3-flash',
    tier: 'balanced',
    vision: false,
    limit: { context: 64_000, output: 8_000 },
    openrouterProvider: { order: ['z-ai'] },
  },
  {
    id: 'managed-bedrock-test',
    name: 'Managed Bedrock Test',
    upstreamModelId: 'us.anthropic.claude-sonnet-4-6',
    transport: 'bedrock',
    pricingRef: 'anthropic/claude-sonnet-4-6',
    tier: 'flagship',
    vision: true,
    limit: { context: 1_000_000, output: 64_000 },
  },
];

mock.module('../../config', () => ({
  SANDBOX_VERSION: 'test',
  config: new Proxy(
    {},
    {
      get: (target: Record<PropertyKey, unknown>, key) => {
        if (Object.hasOwn(target, key)) return target[key];
        if (key === 'KORTIX_MANAGED_PROVIDER_ENABLED') return true;
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return false;
        if (key === 'LLM_GATEWAY_ENABLED') return true;
        if (key === 'LLM_GATEWAY_DEFAULT_ENABLED') return true;
        if (key === 'LLM_GATEWAY_MANAGED_MODELS') return JSON.stringify(configuredModels);
        if (key === 'TUNNEL_ENABLED') return false;
        if (key === 'LLM_GATEWAY_BYOK_FALLBACK_MODEL') return '';
        if (key === 'LLM_GATEWAY_DEFAULT_MODEL') return 'glm-5.3-flash';
        if (key === 'LLM_GATEWAY_VISION_MODEL') return undefined;
        if (key === 'LLM_GATEWAY_FALLBACK_POLICIES') return [];
        if (key === 'AWS_BEDROCK_REGION') return 'us-west-2';
        if (key === 'AWS_BEDROCK_API_KEY') return 'bedrock-key';
        if (key === 'OPENROUTER_API_KEY') return undefined;
        if (key === 'OPENROUTER_API_URL') return 'https://openrouter.ai/api/v1';
        return target[key];
      },
    },
  ),
  getToolCost: () => 0,
}));

mock.module('../../billing/services/entitlements', () => ({
  getAccountTier: async () => 'pro',
  getCachedAccountTier: async () => 'pro',
  accountMayUseManagedModels: async () => true,
}));

mock.module('../../projects/secrets', () => ({
  decryptProjectSecret: (_projectId: string, value: string) => value,
  encryptProjectSecret: (_projectId: string, value: string) => value,
  getProjectSecretValue: async () => null,
  getProjectSecretValueForConsumer: async () => null,
  resolveProjectSecretsForConsumer: async () => [],
  listProjectSecrets: async () => ({}),
  listProjectSecretsForUser: async () => ({}),
  listProjectSecretsSnapshot: async () => ({ env: {}, names: [], revision: 'empty' }),
  listProjectSecretNamesForConsumer: async () => [],
  listProjectSecretsSnapshotForUser: async () => ({ env: {}, names: [], revision: 'empty' }),
  projectSecretsRevision: () => 'empty',
}));

mock.module('../../repositories/project-routing-policies', () => ({
  getProjectRoutingPolicy: async () => null,
  setProjectModelOverrides: async () => undefined,
}));

mock.module('../credentials/codex', () => ({
  CHATGPT_CODEX_BASE_URL: 'https://chatgpt.com/backend-api/codex',
  CODEX_USER_AGENT: 'test-agent',
  CodexRefreshError: class CodexRefreshError extends Error {},
  resolveCodexCredential: async () => null,
}));

const { RUNTIME_MANAGED_MODELS } = await import('./managed-models');
const { SERVED_MANAGED_MODELS, platformDefaultModelId } = await import('./served-managed-models');
const { gatewayModelCatalog, managedModels } = await import('./catalog-models');
const { managedPickerModels } = await import('./picker-catalog');
const { resolveCandidates } = await import('../resolution/resolve-candidates');

describe('a managed model whose transport credential is missing is never offered', () => {
  test('keeps the configured model but removes it from every served catalog', () => {
    expect(RUNTIME_MANAGED_MODELS.map((model) => model.id)).toContain('glm-5.3-flash');
    expect(SERVED_MANAGED_MODELS.map((model) => model.id)).toEqual(['managed-bedrock-test']);
    expect(managedModels()['glm-5.3-flash']).toBeUndefined();
    expect(gatewayModelCatalog('proj')['glm-5.3-flash']).toBeUndefined();
    expect(managedPickerModels().map((model) => model.id)).not.toContain('kortix/glm-5.3-flash');
  });

  test('degrades the unreachable platform default to a credentialed model', async () => {
    expect(platformDefaultModelId()).toBe('managed-bedrock-test');
    const candidates = await resolveCandidates(
      { userId: 'u', accountId: 'a', projectId: 'p' },
      platformDefaultModelId(),
    );
    expect(candidates[0]?.apiKey).toBe('bedrock-key');
  });

  test('refuses an explicit request for the uncredentialed model', async () => {
    await expect(
      resolveCandidates({ userId: 'u', accountId: 'a', projectId: 'p' }, 'glm-5.3-flash'),
    ).rejects.toMatchObject({ name: 'GatewayResolutionError' });
  });
});
