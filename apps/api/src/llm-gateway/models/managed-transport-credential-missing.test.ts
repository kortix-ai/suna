import { describe, expect, mock, test } from 'bun:test';

// Existing fixtures have no project inference restrictions.
mock.module('../../repositories/project-model-access', () => ({ getProjectModelAccess: async () => ({ disabledProviders: [], disabledModels: [] }) }));

const configuredModels = [
  {
    id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash',
    upstreamModelId: 'deepseek/deepseek-v4.1-flash', transport: 'openrouter',
    pricingRef: 'openrouter/deepseek/deepseek-v4.1-flash', tier: 'balanced', vision: true,
    openrouterProvider: { only: ['test-endpoint'], allow_fallbacks: false, zdr: true, data_collection: 'deny' },
    limit: { context: 1_048_576, output: 16_384 },
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
        if (key === 'LLM_GATEWAY_DEFAULT_MODEL') return 'deepseek-v4.1-flash';
        if (key === 'LLM_GATEWAY_VISION_MODEL') return undefined;
        if (key === 'LLM_GATEWAY_FALLBACK_POLICIES') return [];
        if (key === 'AWS_BEDROCK_REGION') return 'us-west-2';
        if (key === 'AWS_BEDROCK_API_KEY') return 'bedrock-key';
        if (key === 'OPENROUTER_API_KEY') return undefined;
        if (key === 'MORPH_API_KEY') return undefined;
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
  resolveCodexAccountCredential: async () => null,
}));

const { RUNTIME_MANAGED_MODELS } = await import('./managed-models');
const { SERVED_MANAGED_MODELS } = await import('./served-managed-models');
const { gatewayModelCatalog, managedModels } = await import('./catalog-models');
const { managedPickerModels } = await import('./picker-catalog');
const { resolveCandidates } = await import('../resolution/resolve-candidates');

describe('an OpenRouter model without a credential is not offered', () => {
  test('removes the model from every served catalog', () => {
    expect(RUNTIME_MANAGED_MODELS.map((model) => model.id)).toContain('deepseek-v4.1-flash');
    expect(SERVED_MANAGED_MODELS).toEqual([]);
    expect(managedModels()['deepseek-v4.1-flash']).toBeUndefined();
    expect(gatewayModelCatalog('proj')['deepseek-v4.1-flash']).toBeUndefined();
    expect(managedPickerModels().map((model) => model.id)).not.toContain('kortix/deepseek-v4.1-flash');
  });

  test('refuses an explicit request for the uncredentialed model', async () => {
    await expect(
      resolveCandidates({ userId: 'u', accountId: 'a', projectId: 'p' }, 'deepseek-v4.1-flash'),
    ).rejects.toMatchObject({ name: 'GatewayResolutionError', code: 'model_disabled_on_deployment' });
  });
});
