/**
 * `authProviderRefForKind` mapping + the short-TTL memo (spec §4/§8/§11#5).
 * The registry itself is real (dependency-free); only the DB/config-touching
 * `resolveCredentialStatus` is mocked, so the mapping is asserted against the
 * ACTUAL registry entries and the cache behavior against a counting resolver.
 */
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

let resolverCalls = 0;

mock.module('./resolve-credential-status', () => ({
  resolveCredentialStatus: async (
    _projectId: string,
    _userId: string | null,
    providerId: string,
    door: string,
  ) => {
    resolverCalls += 1;
    return {
      providerId,
      authKind: 'codex_subscription',
      door,
      scope: 'shared',
      status: 'healthy',
      refreshable: true,
      expiresAt: null,
      lastCheckedAt: Date.now(),
      reason: null,
    };
  },
  UnknownAuthProviderError: class extends Error {},
}));

const { authProviderRefForKind, invalidateCredentialStatus, resolveCredentialStatusCached } =
  await import('./credential-status');

afterAll(() => mock.restore());
beforeEach(() => {
  resolverCalls = 0;
});

describe('authProviderRefForKind', () => {
  test('maps each connectable kind to its single registry (id, door)', () => {
    expect(authProviderRefForKind('claude_subscription')).toEqual({
      providerId: 'anthropic',
      door: 'account',
    });
    expect(authProviderRefForKind('codex_subscription')).toEqual({
      providerId: 'openai',
      door: 'account',
    });
    expect(authProviderRefForKind('anthropic_api_key')).toEqual({
      providerId: 'anthropic',
      door: 'api-key',
    });
    expect(authProviderRefForKind('openai_api_key')).toEqual({
      providerId: 'openai',
      door: 'api-key',
    });
  });

  test('non-connectable kinds have no registry entry → null', () => {
    expect(authProviderRefForKind('managed_gateway')).toBeNull();
    expect(authProviderRefForKind('native_config')).toBeNull();
  });
});

describe('resolveCredentialStatusCached', () => {
  test('a second call within TTL is served from the memo (one probe, not two)', async () => {
    await resolveCredentialStatusCached('proj-ttl-1', 'user-1', 'openai', 'account');
    await resolveCredentialStatusCached('proj-ttl-1', 'user-1', 'openai', 'account');
    expect(resolverCalls).toBe(1);
  });

  test('invalidate forces the next call to re-probe', async () => {
    await resolveCredentialStatusCached('proj-ttl-2', 'user-1', 'openai', 'account');
    invalidateCredentialStatus('proj-ttl-2', 'user-1', 'openai', 'account');
    await resolveCredentialStatusCached('proj-ttl-2', 'user-1', 'openai', 'account');
    expect(resolverCalls).toBe(2);
  });

  test('distinct (project, provider, door) keys do not collide', async () => {
    await resolveCredentialStatusCached('proj-ttl-3', 'user-1', 'openai', 'account');
    await resolveCredentialStatusCached('proj-ttl-3', 'user-1', 'anthropic', 'api-key');
    expect(resolverCalls).toBe(2);
  });
});
