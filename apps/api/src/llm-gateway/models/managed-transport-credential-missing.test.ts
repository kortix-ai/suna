import { describe, expect, mock, test } from 'bun:test';

// KORTIX_MANAGED_PROVIDER_ENABLED is ON, but the `aster` transport has no
// credential — the exact shape of every deployment that loads ASTER_API_KEY
// from a secret store the process cannot reach. The managed lineup must then
// offer only what it can actually serve, and the platform default must degrade
// to one of those rather than 400 on every selection.

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
        if (key === 'LLM_GATEWAY_MANAGED_MODELS') return undefined;
        if (key === 'TUNNEL_ENABLED') return false;
        if (key === 'LLM_GATEWAY_BYOK_FALLBACK_MODEL') return '';
        if (key === 'LLM_GATEWAY_DEFAULT_MODEL') return 'glm-5.2';
        if (key === 'LLM_GATEWAY_VISION_MODEL') return 'claude-sonnet-4.6';
        if (key === 'LLM_GATEWAY_FALLBACK_POLICIES') return [];
        if (key === 'AWS_BEDROCK_REGION') return 'us-west-2';
        if (key === 'AWS_BEDROCK_API_KEY') return 'bedrock-key';
        if (key === 'OPENROUTER_API_KEY') return 'openrouter-key';
        if (key === 'OPENROUTER_API_URL') return 'https://openrouter.ai/api/v1';
        if (key === 'ASTER_API_KEY') return undefined;
        if (key === 'ASTER_API_URL') return 'https://api.asterlab.ai/v1';
        return target[key];
      },
    },
  ),
  getToolCost: () => 0,
}));

mock.module('../../billing/services/entitlements', () => ({
  getAccountTier: async () => 'pro',
  getCachedAccountTier: async () => 'pro',
}));

mock.module('../../projects/secrets', () => ({
  decryptProjectSecret: (_projectId: string, value: string) => value,
  encryptProjectSecret: (_projectId: string, value: string) => value,
  getProjectSecretValue: async () => null,
  listProjectSecrets: async () => ({}),
  listProjectSecretsForUser: async () => ({}),
  listProjectSecretsSnapshot: async () => ({ env: {}, names: [], revision: 'empty' }),
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

describe('a managed model whose transport credential is missing is never OFFERED', () => {
  test('the configured lineup still lists it — config and credentials are different questions', () => {
    expect(RUNTIME_MANAGED_MODELS.map((m) => m.id)).toContain('glm-5.2');
  });

  test('the served lineup drops it and keeps every credentialed transport', () => {
    const served = SERVED_MANAGED_MODELS.map((m) => m.id);
    expect(served).not.toContain('glm-5.2');
    expect(served).toContain('claude-opus-4.8');
    expect(served).toContain('deepseek-v4-flash');
  });

  test('the served model catalog does not advertise it', () => {
    expect(managedModels()['glm-5.2']).toBeUndefined();
    expect(managedModels()['claude-opus-4.8']).toBeDefined();
    expect(gatewayModelCatalog('proj')['glm-5.2']).toBeUndefined();
    expect(gatewayModelCatalog(undefined)['glm-5.2']).toBeUndefined();
  });

  test('the compact picker does not offer it', () => {
    expect(managedPickerModels().map((m) => m.id)).not.toContain('kortix/glm-5.2');
  });
});

describe('the platform default model is always resolvable', () => {
  test('degrades away from the unreachable configured default', () => {
    expect(platformDefaultModelId()).not.toBe('glm-5.2');
    expect(SERVED_MANAGED_MODELS.map((m) => m.id)).toContain(platformDefaultModelId());
  });

  test('resolving the platform default yields a real upstream candidate', async () => {
    const candidates = await resolveCandidates(
      { userId: 'u', accountId: 'a', projectId: 'p' },
      platformDefaultModelId(),
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.apiKey).toBe('bedrock-key');
  });

  test('naming the unreachable model explicitly still refuses, with an actionable reason', async () => {
    await expect(
      resolveCandidates({ userId: 'u', accountId: 'a', projectId: 'p' }, 'glm-5.2'),
    ).rejects.toMatchObject({ name: 'GatewayResolutionError' });
  });
});
