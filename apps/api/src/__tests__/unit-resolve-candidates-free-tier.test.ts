import { beforeEach, describe, expect, mock, test } from 'bun:test';

let billingEnabled = true;
let accountTier = 'free';
let accountTierCalls = 0;

mock.module('@kortix/llm-gateway', () => ({
  resolveCatalogUpstream: (provider: string) =>
    provider === 'openai'
      ? {
          envVar: 'OPENAI_API_KEY',
          kind: 'openai-chat',
          baseUrl: 'https://api.openai.com/v1',
        }
      : null,
}));

mock.module('@kortix/shared/llm-catalog', () => ({
  pickAutoModel: (model: string) => (model === 'auto' || model === 'kortix/auto' ? 'owl-alpha' : null),
  getManagedModel: (model: string) =>
    model === 'claude-sonnet-4.6' || model === 'owl-alpha'
      ? { id: model, transport: 'openrouter' }
      : null,
}));

mock.module('../config', () => ({
  config: new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return billingEnabled;
        if (key === 'LLM_GATEWAY_ENABLED') return true;
        if (key === 'LLM_GATEWAY_BYOK_FALLBACK_MODEL') return 'claude-sonnet-4.6';
        return undefined;
      },
    },
  ),
}));

mock.module('../billing/services/entitlements', () => ({
  getAccountTier: async () => {
    accountTierCalls += 1;
    return accountTier;
  },
}));

mock.module('../projects/secrets', () => ({
  getProjectSecretValue: async () => 'user-key',
}));

mock.module('../llm-gateway/credentials/codex', () => ({
  resolveCodexCredential: async () => ({ access: 'codex-token', accountId: 'chatgpt-account' }),
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
  managedCandidates: (managed: { id: string }) => [
    {
      provider: 'openrouter',
      kind: 'openai-chat',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'managed-key',
      billingMode: 'credits',
      markup: 1.2,
      resolvedModel: managed.id,
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
  beforeEach(() => {
    billingEnabled = true;
    accountTier = 'free';
    accountTierCalls = 0;
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

  test('resolves raw auto to a concrete managed upstream for stale gateway callers', async () => {
    accountTier = 'per_seat';
    const candidates = await resolveCandidates(principal('team-auto'), 'auto');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.provider).toBe('openrouter');
    expect(candidates[0]?.resolvedModel).toBe('owl-alpha');
    expect(accountTierCalls).toBe(1);
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

  test('keeps managed candidates available when internal billing is disabled', async () => {
    billingEnabled = false;
    accountTier = 'free';
    const candidates = await resolveCandidates(principal('self-host-managed'), 'claude-sonnet-4.6');
    expect(candidates).toHaveLength(1);
    expect(accountTierCalls).toBe(0);
  });
});
