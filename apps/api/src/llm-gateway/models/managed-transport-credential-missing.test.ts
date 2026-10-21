import { describe, expect, mock, test } from 'bun:test';

// Existing fixtures have no project inference restrictions.
mock.module('../../repositories/project-model-access', () => ({
  getProjectModelAccess: async () => ({ disabledProviders: [], disabledModels: [] }),
  getProjectGatewayResolution: async () => ({ access: { disabledProviders: [], disabledModels: [] }, pooledEnabled: false }),
}));

mock.module('../../config', () => ({
  SANDBOX_VERSION: 'test',
  config: new Proxy(
    {},
    {
      get: (target: Record<PropertyKey, unknown>, key) => {
        if (Object.hasOwn(target, key)) return target[key];
        if (key === 'KORTIX_MANAGED_PROVIDER_ENABLED') return true;
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return false;
        if (key === 'TUNNEL_ENABLED') return false;
        if (key === 'LLM_GATEWAY_BYOK_FALLBACK_MODEL') return '';
        if (key === 'LLM_GATEWAY_DEFAULT_MODEL') return 'deepseek-v4.1-flash';
        if (key === 'LLM_GATEWAY_VISION_MODEL') return undefined;
        if (key === 'LLM_GATEWAY_FALLBACK_POLICIES') return [];
        if (key === 'PLATINUM_INFERENCE_API_KEY') return undefined;
        if (key === 'PLATINUM_INFERENCE_URL') return 'https://api.platinum.dev/v1/inference';
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

const { managedLineup, __setManagedLineupForTest } = await import('./managed-models');
const { servedManagedModels } = await import('./served-managed-models');
const { TEST_MANAGED_LINEUP } = await import('../../__tests__/fixtures/managed-lineup');
// A lineup is known (e.g. loaded before the key was removed), but no key is set.
__setManagedLineupForTest(TEST_MANAGED_LINEUP);
const { gatewayModelCatalog, managedModels } = await import('./catalog-models');
await import('./picker-catalog');
const { resolveCandidates } = await import('../resolution/resolve-candidates');

describe('a managed model without the Platinum inference key is not offered', () => {
  test('removes the model from every served catalog', () => {
    expect(managedLineup().map((model) => model.id)).toContain('deepseek-v4.1-flash');
    expect(servedManagedModels()).toEqual([]);
    expect(managedModels()['deepseek-v4.1-flash']).toBeUndefined();
    expect(gatewayModelCatalog('proj')['deepseek-v4.1-flash']).toBeUndefined();
  });

  test('refuses an explicit request for the uncredentialed model', async () => {
    await expect(
      resolveCandidates({ userId: 'u', accountId: 'a', projectId: 'p' }, 'deepseek-v4.1-flash'),
    ).rejects.toMatchObject({ name: 'GatewayResolutionError', code: 'model_disabled_on_deployment' });
  });
});
