import { describe, expect, mock, test } from 'bun:test';

// Self-host default: KORTIX_MANAGED_PROVIDER_ENABLED is OFF. This file boots
// the gateway's real (unmocked) descriptors/resolve-candidates/catalog/picker
// modules against that config so every consumer of the managed lineup is
// exercised end to end — no managed models served, no managed candidates
// resolved, and NEITHER AWS_BEDROCK_API_KEY NOR OPENROUTER_API_KEY read for
// managed routing (the real-world bug: a self-host operator's OWN OpenRouter
// BYOK key lives in that exact config var, and must never be mistaken for
// Kortix's shared managed credential).

let bedrockKeyReads = 0;
let openrouterKeyReads = 0;

mock.module('../../config', () => ({
  SANDBOX_VERSION: 'test',
  config: new Proxy(
    {},
    {
      get: (target: Record<PropertyKey, unknown>, key) => {
        if (Object.hasOwn(target, key)) return target[key];
        if (key === 'KORTIX_MANAGED_PROVIDER_ENABLED') return false;
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return false;
        if (key === 'LLM_GATEWAY_ENABLED') return true;
        if (key === 'LLM_GATEWAY_DEFAULT_ENABLED') return false;
        if (key === 'LLM_GATEWAY_MANAGED_MODELS') return undefined;
        if (key === 'TUNNEL_ENABLED') return false;
        if (key === 'LLM_GATEWAY_BYOK_FALLBACK_MODEL') return 'claude-sonnet-4.6';
        if (key === 'LLM_GATEWAY_DEFAULT_MODEL') return 'codex/gpt-5.6-sol';
        if (key === 'LLM_GATEWAY_VISION_MODEL') return 'claude-sonnet-4.6';
        if (key === 'LLM_GATEWAY_FALLBACK_POLICIES') return [];
        if (key === 'AWS_BEDROCK_REGION') return 'us-west-2';
        if (key === 'AWS_BEDROCK_API_KEY') {
          bedrockKeyReads += 1;
          return 'fake-bedrock-key-must-never-be-read';
        }
        if (key === 'OPENROUTER_API_KEY') {
          // The exact real-world footgun: a self-host operator's OWN BYOK
          // OpenRouter key sits in this same config var. It must never be
          // read to build a "managed" descriptor when the flag is off.
          openrouterKeyReads += 1;
          return 'operators-own-openrouter-key';
        }
        if (key === 'OPENROUTER_API_URL') return 'https://openrouter.ai/api/v1';
        return target[key];
      },
    },
  ),
  getToolCost: () => 0,
}));

mock.module('../../billing/services/entitlements', () => ({
  getAccountTier: async () => 'free',
}));

mock.module('../../projects/secrets', () => ({
  decryptProjectSecret: (_projectId: string, value: string) => value,
  encryptProjectSecret: (_projectId: string, value: string) => value,
  getProjectSecretValue: async () => 'operators-own-anthropic-key',
  listProjectSecrets: async () => ({}),
  listProjectSecretsForUser: async () => ({}),
  listProjectSecretsSnapshot: async () => ({ env: {}, names: [], revision: 'empty' }),
  listProjectSecretsSnapshotForUser: async () => ({ env: {}, names: [], revision: 'empty' }),
  projectSecretsRevision: () => 'empty',
}));

mock.module('../credentials/codex', () => ({
  // Not a self-host managed-provider concern (Codex routes through the
  // caller's own ChatGPT OAuth credential, never Kortix's shared creds) —
  // stubbed purely so importing the REAL descriptors.ts/resolve-candidates.ts
  // below doesn't pull in the real module's DB import chain.
  CHATGPT_CODEX_BASE_URL: 'https://chatgpt.com/backend-api/codex',
  CODEX_USER_AGENT: 'test-agent',
  CodexRefreshError: class CodexRefreshError extends Error {},
  resolveCodexCredential: async () => null,
}));

const { RUNTIME_MANAGED_MODELS, getRuntimeManagedModel, isRuntimeManagedModelId } = await import(
  './managed-models'
);
const { managedCandidates, managedDescriptor } = await import('../resolution/descriptors');
const { resolveCandidates } = await import('../resolution/resolve-candidates');
const { gatewayModelCatalog, managedModels } = await import('./catalog-models');
const { managedPickerModels } = await import('./picker-catalog');

const FAKE_MANAGED_MODEL = {
  id: 'claude-sonnet-4.6',
  name: 'Claude Sonnet 4.6',
  upstreamModelId: 'anthropic.claude-sonnet-4-6-v1:0',
  transport: 'bedrock' as const,
  pricingRef: 'claude-sonnet-4.6',
  tier: 'flagship' as const,
  vision: true,
  limit: { context: 200_000, output: 32_000 },
};

describe('managed provider disabled (KORTIX_MANAGED_PROVIDER_ENABLED=false, the self-host default)', () => {
  test('the managed registry is empty — the single choke point every consumer reads through', () => {
    expect(RUNTIME_MANAGED_MODELS).toEqual([]);
    expect(isRuntimeManagedModelId('claude-sonnet-4.6')).toBe(false);
    expect(getRuntimeManagedModel('claude-sonnet-4.6')).toBeUndefined();
  });

  test('the served model catalog carries no managed models and no synthetic AUTO', () => {
    expect(managedModels()).toEqual({});
    const anonymous = gatewayModelCatalog(undefined);
    expect(anonymous).toEqual({});
    const full = gatewayModelCatalog('proj');
    expect(full.auto).toBeUndefined();
    expect(full['claude-sonnet-4.6']).toBeUndefined();
    expect(full['glm-5.2']).toBeUndefined();
  });

  test('the compact/Slack picker offers no managed entries', () => {
    expect(managedPickerModels()).toEqual([]);
  });

  test('managedCandidates()/managedDescriptor() (defense-in-depth) refuse to build a descriptor and read NEITHER credential', () => {
    expect(managedCandidates(FAKE_MANAGED_MODEL)).toEqual([]);
    expect(managedCandidates({ ...FAKE_MANAGED_MODEL, transport: 'openrouter' })).toEqual([]);
    expect(managedDescriptor(FAKE_MANAGED_MODEL)).toBeNull();
    expect(bedrockKeyReads).toBe(0);
    expect(openrouterKeyReads).toBe(0);
  });

  test('a request explicitly naming a managed model resolves to NO candidates — never a silent fallback to Kortix credits', async () => {
    const candidates = await resolveCandidates(
      { userId: 'u-managed', accountId: 'a-managed', projectId: 'p-managed' },
      'claude-sonnet-4.6',
    );
    expect(candidates).toEqual([]);
    expect(bedrockKeyReads).toBe(0);
    expect(openrouterKeyReads).toBe(0);
  });

  test('a BYOK request still works on its own key, but gets NO managed fallback appended', async () => {
    const candidates = await resolveCandidates(
      { userId: 'u-byok', accountId: 'a-byok', projectId: 'p-byok' },
      'anthropic/claude-opus-4-8',
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.apiKey).toBe('operators-own-anthropic-key');
    expect(bedrockKeyReads).toBe(0);
    expect(openrouterKeyReads).toBe(0);
  });
});
