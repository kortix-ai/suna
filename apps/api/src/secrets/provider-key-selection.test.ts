import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The pooled keys a session may run on (secrets/provider-key-selection.ts).
// The pool routes check a selection with mayUseProviderKeys. Session create
// and model change fall back to usableProviderKeys, and the chat channels
// select with it. Both ask for the key name the gateway reads, derived from
// the provider: no caller passes a name.

mock.module('../llm-gateway/models/provider-registry', () => ({
  resolveCatalogUpstream: (id: string) => (id === 'anthropic' ? { envVar: 'ANTHROPIC_API_KEY' } : null),
}));

const queries: Array<Record<string, unknown>> = [];
let rows: Array<{ secretId: string; providerId: string; name: string; label: string; accessMode: string }> = [];
// As listUsableGatewaySecrets filters in SQL: provider, key name, ids.
mock.module('./account-resource', () => ({
  listUsableGatewaySecrets: async (input: { providerId?: string; name?: string; ids?: string[] }) => {
    queries.push(input);
    return rows.filter((row) =>
      (!input.providerId || row.providerId === input.providerId) &&
      (!input.name || row.name === input.name) &&
      (!input.ids || input.ids.includes(row.secretId)));
  },
}));

const { MAX_KEYS_PER_PROVIDER, mayUseProviderKeys, providerEnvVarOf, providerKeyOf, usableProviderKeys } = await import('./provider-key-selection');

const input = { accountId: 'acct', projectId: 'proj', userId: 'ivan', grantUserId: 'ivan' };

beforeEach(() => {
  queries.length = 0;
  rows = [];
});

describe('providerEnvVarOf', () => {
  test('ChatGPT connections are CODEX_AUTH_JSON; a catalog provider reads its own key; an unknown one none', () => {
    expect(providerEnvVarOf('codex')).toBe('CODEX_AUTH_JSON');
    expect(providerEnvVarOf('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(providerEnvVarOf('unknown')).toBeNull();
  });
});

describe('mayUseProviderKeys', () => {
  const key = (secretId: string, name = 'ANTHROPIC_API_KEY') =>
    ({ secretId, providerId: 'anthropic', name, label: secretId, accessMode: 'project' });
  const scope = { accountId: 'acct', projectId: 'proj', userId: 'owner', grantUserId: null, providerId: 'anthropic' };

  test('asks for the named keys under the provider`s key name, as one member with one member`s grants', async () => {
    rows = [key('k1'), key('k2')];
    expect(await mayUseProviderKeys({ ...scope, ids: ['k1', 'k2'] })).toBe(true);
    expect(queries[0]).toEqual({
      accountId: 'acct', projectId: 'proj', userId: 'owner', grantUserId: null,
      providerId: 'anthropic', name: 'ANTHROPIC_API_KEY', ids: ['k1', 'k2'],
    });
  });

  test('false when any one key is not usable', async () => {
    rows = [key('k1')];
    expect(await mayUseProviderKeys({ ...scope, ids: ['k1', 'k2'] })).toBe(false);
  });

  test('a key stored under another name for the provider does not count', async () => {
    rows = [key('k1'), key('k2', 'OTHER_KEY')];
    expect(await mayUseProviderKeys({ ...scope, ids: ['k1', 'k2'] })).toBe(false);
  });

  test('ChatGPT connections are asked for as CODEX_AUTH_JSON', async () => {
    rows = [{ secretId: 'c1', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'ChatGPT', accessMode: 'members' }];
    expect(await mayUseProviderKeys({ ...scope, providerId: 'codex', ids: ['c1'] })).toBe(true);
    expect(queries[0]).toMatchObject({ providerId: 'codex', name: 'CODEX_AUTH_JSON' });
  });

  test('an unknown provider has no usable keys, and no query runs', async () => {
    expect(await mayUseProviderKeys({ ...scope, providerId: 'unknown', ids: ['k1'] })).toBe(false);
    expect(queries).toHaveLength(0);
  });

  test('no ids: nothing to check, and no query runs', async () => {
    expect(await mayUseProviderKeys({ ...scope, ids: [] })).toBe(true);
    expect(queries).toHaveLength(0);
  });

  test('a repeated id counts once', async () => {
    rows = [key('k1')];
    expect(await mayUseProviderKeys({ ...scope, ids: ['k1', 'k1'] })).toBe(true);
    expect(queries[0]).toMatchObject({ ids: ['k1'] });
  });
});

describe('providerKeyOf', () => {
  test('names the provider and the key the gateway reads; a Kortix model needs none', () => {
    expect(providerKeyOf('kortix/codex/gpt-6-astra')).toEqual({ providerId: 'codex', envVar: 'CODEX_AUTH_JSON' });
    expect(providerKeyOf('anthropic/claude-opus-4-8')).toEqual({ providerId: 'anthropic', envVar: 'ANTHROPIC_API_KEY' });
    expect(providerKeyOf('kortix/glm-5.3-flash')).toBeNull();
    expect(providerKeyOf('unknown/model')).toBeNull();
  });
});

describe('usableProviderKeys', () => {
  test('every key of the model`s provider the caller may use, oldest first, with labels', async () => {
    rows = [
      { secretId: 'k1', providerId: 'anthropic', name: 'ANTHROPIC_API_KEY', label: 'Team', accessMode: 'project' },
      { secretId: 'k2', providerId: 'anthropic', name: 'ANTHROPIC_API_KEY', label: 'Ivan', accessMode: 'members' },
      { secretId: 'k3', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'ChatGPT', accessMode: 'project' },
    ];
    expect(await usableProviderKeys({ ...input, model: 'anthropic/claude-opus-4-8' })).toEqual({
      providerId: 'anthropic', envVar: 'ANTHROPIC_API_KEY', secretIds: ['k1', 'k2'], labels: ['Team', 'Ivan'],
    });
    expect(queries[0]).toEqual({
      accountId: 'acct', projectId: 'proj', userId: 'ivan', grantUserId: 'ivan', providerId: 'anthropic', name: 'ANTHROPIC_API_KEY', ids: undefined,
    });
  });

  test('a shared session asks without anyone`s member grants', async () => {
    await usableProviderKeys({ ...input, grantUserId: null, model: 'kortix/codex/gpt-6-astra' });
    expect(queries[0]).toMatchObject({ grantUserId: null, providerId: 'codex' });
  });

  test('a key stored under another name for the provider is not selected', async () => {
    rows = [{ secretId: 'k9', providerId: 'anthropic', name: 'SOMETHING_ELSE', label: 'x', accessMode: 'project' }];
    expect(await usableProviderKeys({ ...input, model: 'anthropic/claude-opus-4-8' })).toBeNull();
  });

  test('nothing to select for a Kortix model, and no query', async () => {
    expect(await usableProviderKeys({ ...input, model: 'glm-5.3-flash' })).toBeNull();
    expect(queries).toHaveLength(0);
  });

  test('at most the ten keys one session may select', async () => {
    rows = Array.from({ length: 13 }, (_, i) => ({
      secretId: `k${i}`, providerId: 'anthropic', name: 'ANTHROPIC_API_KEY', label: `key ${i}`, accessMode: 'project',
    }));
    const keys = await usableProviderKeys({ ...input, model: 'anthropic/claude-opus-4-8' });
    expect(keys?.secretIds).toHaveLength(MAX_KEYS_PER_PROVIDER);
    expect(MAX_KEYS_PER_PROVIDER).toBe(10);
  });
});
