import { describe, expect, test } from 'bun:test';
import { CodexRefreshError } from '../credentials/codex-core';
import { UnknownAuthProviderError, resolveCredentialStatus } from './resolve-credential-status';

const PROJECT_ID = 'proj_1';
const USER_ID = 'user_1';

describe('resolveCredentialStatus — unknown provider/door', () => {
  test('throws UnknownAuthProviderError for an id with no registry entry', async () => {
    await expect(
      resolveCredentialStatus(PROJECT_ID, USER_ID, 'does-not-exist', 'account'),
    ).rejects.toThrow(UnknownAuthProviderError);
  });

  test('throws for a known id under the WRONG door — (id, door) is the natural registry key', async () => {
    // 'openai-compatible-endpoint' exists ONLY as door:'api-key' — asking
    // for its 'account' door must fail rather than silently matching by id
    // alone, proving door-scoping actually gates the lookup.
    await expect(
      resolveCredentialStatus(PROJECT_ID, USER_ID, 'openai-compatible-endpoint', 'account'),
    ).rejects.toThrow(UnknownAuthProviderError);
  });
});

describe('resolveCredentialStatus — codex_subscription', () => {
  test('absent when resolveCodex returns null', async () => {
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'openai', 'account', {
      resolveCodex: async () => null,
    });
    expect(result.status).toBe('absent');
    expect(result.authKind).toBe('codex_subscription');
    expect(result.refreshable).toBe(true);
    expect(result.lastCheckedAt).toBeNull();
    expect(result.reason).toContain('ChatGPT / Codex');
  });

  test('healthy with expiresAt carried through when resolveCodex succeeds', async () => {
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'openai', 'account', {
      resolveCodex: async () => ({
        access: 'tok',
        accountId: 'acct_1',
        expiresAt: 1_800_000_000_000,
      }),
    });
    expect(result.status).toBe('healthy');
    expect(result.expiresAt).toBe(1_800_000_000_000);
    expect(result.lastCheckedAt).not.toBeNull();
    expect(result.scope).toBe('shared');
  });

  test('expired when resolveCodex throws CodexRefreshError — the fail-closed short-circuit', async () => {
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'openai', 'account', {
      resolveCodex: async () => {
        throw new CodexRefreshError('upstream rejected refresh', 401);
      },
    });
    expect(result.status).toBe('expired');
    expect(result.reason).toContain('refresh');
  });

  test('a non-CodexRefreshError propagates rather than being swallowed', async () => {
    await expect(
      resolveCredentialStatus(PROJECT_ID, USER_ID, 'openai', 'account', {
        resolveCodex: async () => {
          throw new Error('unexpected db error');
        },
      }),
    ).rejects.toThrow('unexpected db error');
  });
});

describe('resolveCredentialStatus — claude_subscription', () => {
  test('absent when resolveClaude returns null', async () => {
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'anthropic', 'account', {
      resolveClaude: async () => null,
    });
    expect(result.status).toBe('absent');
    expect(result.authKind).toBe('claude_subscription');
    expect(result.refreshable).toBe(false); // Tier A: no refresh path
  });

  test('expired when a known expiresAt has passed — no probe is even attempted', async () => {
    let probeCalled = false;
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'anthropic', 'account', {
      resolveClaude: async () => ({ token: 't', expiresAt: Date.now() - 1000, scope: 'shared' }),
      probeClaude: async () => {
        probeCalled = true;
        return 'healthy';
      },
    });
    expect(result.status).toBe('expired');
    expect(probeCalled).toBe(false);
  });

  test('unverified (no lastCheckedAt) when there is no known expiry and the probe is unverified', async () => {
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'anthropic', 'account', {
      resolveClaude: async () => ({ token: 't', expiresAt: null, scope: 'personal' }),
      probeClaude: async () => 'unverified',
    });
    expect(result.status).toBe('unverified');
    expect(result.lastCheckedAt).toBeNull();
    expect(result.scope).toBe('personal');
  });

  test('healthy when the probe confirms it, carries a real lastCheckedAt', async () => {
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'anthropic', 'account', {
      resolveClaude: async () => ({ token: 't', expiresAt: null, scope: 'shared' }),
      probeClaude: async () => 'healthy',
    });
    expect(result.status).toBe('healthy');
    expect(result.lastCheckedAt).not.toBeNull();
  });

  test('invalid when the probe rejects the token', async () => {
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'anthropic', 'account', {
      resolveClaude: async () => ({ token: 't', expiresAt: null, scope: 'shared' }),
      probeClaude: async () => 'invalid',
    });
    expect(result.status).toBe('invalid');
    expect(result.reason).toContain('rejected');
  });
});

describe('resolveCredentialStatus — api-key doors (anthropic_api_key / openai_api_key / compatible endpoints)', () => {
  test('absent when no configured env var carries a value', async () => {
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'anthropic', 'api-key', {
      getSecretValue: async () => null,
    });
    expect(result.status).toBe('absent');
    expect(result.authKind).toBe('anthropic_api_key');
  });

  test('healthy when the value is present and checkApiKey confirms it', async () => {
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'anthropic', 'api-key', {
      getSecretValue: async (_projectId, name) =>
        name === 'ANTHROPIC_API_KEY' ? 'sk-ant-xxx' : null,
      checkApiKey: async (providerId, apiKey) => {
        expect(providerId).toBe('anthropic');
        expect(apiKey).toBe('sk-ant-xxx');
        return 'healthy';
      },
    });
    expect(result.status).toBe('healthy');
    expect(result.lastCheckedAt).not.toBeNull();
  });

  test('invalid when checkApiKey rejects it', async () => {
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'openai', 'api-key', {
      getSecretValue: async (_projectId, name) => (name === 'OPENAI_API_KEY' ? 'sk-oa-xxx' : null),
      checkApiKey: async () => 'invalid',
    });
    expect(result.status).toBe('invalid');
    expect(result.authKind).toBe('openai_api_key');
  });

  test('unverified (no lastCheckedAt) when no probe is registered for the provider', async () => {
    const result = await resolveCredentialStatus(PROJECT_ID, USER_ID, 'openai', 'api-key', {
      getSecretValue: async (_projectId, name) => (name === 'OPENAI_API_KEY' ? 'sk-oa-xxx' : null),
      checkApiKey: async () => 'unverified',
    });
    expect(result.status).toBe('unverified');
    expect(result.lastCheckedAt).toBeNull();
  });

  test('custom OpenAI-compatible endpoint: absent unless CUSTOM_LLM_PROTOCOL/BASE_URL/MODEL_ID are set', async () => {
    const result = await resolveCredentialStatus(
      PROJECT_ID,
      USER_ID,
      'openai-compatible-endpoint',
      'api-key',
      {
        getSecretValue: async (_projectId, name) =>
          name === 'CUSTOM_LLM_BASE_URL' ? 'https://example.test' : null,
        // No probe registered for a synthetic endpoint id — falls to unverified.
        checkApiKey: async () => 'unverified',
      },
    );
    expect(result.status).toBe('unverified');
    expect(result.authKind).toBe('openai_compatible');
  });

  test('multi-env-var entries stop at the first configured var', async () => {
    const calls: string[] = [];
    await resolveCredentialStatus(PROJECT_ID, USER_ID, 'openai-compatible-endpoint', 'api-key', {
      getSecretValue: async (_projectId, name) => {
        calls.push(name);
        return name === 'CUSTOM_LLM_PROTOCOL' ? 'openai' : null;
      },
      checkApiKey: async () => 'unverified',
    });
    expect(calls).toEqual(['CUSTOM_LLM_PROTOCOL']);
  });
});
