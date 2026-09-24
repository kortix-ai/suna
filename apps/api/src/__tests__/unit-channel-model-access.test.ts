import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The model list and checks a chat conversation (Teams, Slack) uses. Before
// this, the channels listed Kortix models plus one model per legacy project
// key, checked every choice as the ACCOUNT OWNER, and never sent a key
// selection: a model reached through a shared key or a ChatGPT subscription
// was missing from /models and rejected by /model.

let pooledFlag = true;
mock.module('../feature-flags/for-project', () => ({
  projectFeatureFlagEnabled: async () => pooledFlag,
}));

const catalogCalls: Array<Record<string, unknown>> = [];
let catalogModels: Record<string, Record<string, unknown>> = {};
mock.module('../llm-gateway/models/servable-catalog', () => ({
  servableProjectCatalog: async (input: Record<string, unknown>) => {
    catalogCalls.push(input);
    return { models: catalogModels, modelOverrides: {}, defaultModel: 'codex/gpt-6-astra', usingDefaults: true };
  },
}));

mock.module('../llm-gateway/models/provider-registry', () => ({
  resolveCatalogUpstream: (id: string) => (id === 'anthropic' ? { envVar: 'ANTHROPIC_API_KEY' } : null),
}));

const probes: Array<Record<string, unknown>> = [];
let servable = true;
mock.module('../llm-gateway/resolution/default-model', () => ({
  isModelServableForAccount: async (input: Record<string, unknown>) => {
    probes.push(input);
    return servable;
  },
}));

const keyQueries: Array<Record<string, unknown>> = [];
let usableKeys: Array<{ secretId: string; providerId: string; name: string; label: string; accessMode: string }> = [];
mock.module('../secrets/account-resource', () => ({
  listUsableGatewaySecrets: async (input: Record<string, unknown>) => {
    keyQueries.push(input);
    return usableKeys.filter((key) => !input.providerId || key.providerId === input.providerId);
  },
}));

mock.module('../channels/slack/model-gate', () => ({
  channelModelContext: async () => ({
    projectId: 'proj', accountId: 'acct', ownerUserId: 'owner', freeManagedOnly: false, llmGatewayEnabled: true,
  }),
}));

const writes: Array<{ op: string; values?: unknown }> = [];
let insertReturning: unknown[] = [{ sessionId: 's1' }];
mock.module('../shared/db', () => ({
  db: {
    insert: () => ({
      values: (values: unknown) => ({
        onConflictDoUpdate: async () => {
          writes.push({ op: 'upsert', values });
        },
        onConflictDoNothing: () => ({
          returning: async () => {
            writes.push({ op: 'insert-if-absent', values });
            return insertReturning;
          },
        }),
      }),
    }),
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
  },
}));

const access = await import('../channels/model-access');

const scope = (over: Partial<ReturnType<typeof access.channelModelScope>> = {}) => ({
  projectId: 'proj', accountId: 'acct', memberUserId: 'ivan', personalUserId: 'ivan',
  freeManagedOnly: false, llmGatewayEnabled: true, pooledEnabled: true, ...over,
});

beforeEach(() => {
  pooledFlag = true;
  catalogCalls.length = 0;
  probes.length = 0;
  keyQueries.length = 0;
  writes.length = 0;
  servable = true;
  insertReturning = [{ sessionId: 's1' }];
  usableKeys = [];
  catalogModels = {};
});

describe('channelModelScope — whose resources a conversation may use', () => {
  const base = { projectId: 'p', accountId: 'a', ownerUserId: 'owner', freeManagedOnly: false, llmGatewayEnabled: true, pooledEnabled: true };

  test('a one-to-one chat with a linked person: their own keys and ChatGPT count', () => {
    expect(access.channelModelScope({ ...base, linkedUserId: 'ivan', oneToOne: true })).toMatchObject({
      memberUserId: 'ivan', personalUserId: 'ivan',
    });
  });

  test('a group chat or channel: the linked person is the member, and no personal key counts', () => {
    // A personal key there would let everyone in the chat spend one person's
    // subscription (spec 2026-09-22 §2.3: shared sessions never reach one).
    expect(access.channelModelScope({ ...base, linkedUserId: 'ivan', oneToOne: false })).toMatchObject({
      memberUserId: 'ivan', personalUserId: null,
    });
  });

  test('an unlinked person: the owner is the member, and the owner`s personal keys never stand in', () => {
    expect(access.channelModelScope({ ...base, linkedUserId: null, oneToOne: true })).toMatchObject({
      memberUserId: 'owner', personalUserId: null,
    });
  });
});

describe('listChannelModels', () => {
  test('lists the web picker`s models for this member and scope — subscriptions and keys first', async () => {
    catalogModels = {
      'glm-5.3-flash': { name: 'GLM 5.3 Flash', provider: 'kortix', enabled: true },
      'anthropic/claude-opus-4-8': { name: 'Claude Opus 4.8', provider: 'anthropic', enabled: true },
      'codex/gpt-6-astra': { name: 'GPT-6 Astra (ChatGPT)', provider: 'codex', enabled: true },
      'codex/gpt-5.5': { name: 'GPT-5.5 (ChatGPT)', provider: 'codex', enabled: false },
    };

    const { models, defaultModel } = await access.listChannelModels(scope({ personalUserId: null }));

    expect(catalogCalls[0]).toEqual({ projectId: 'proj', accountId: 'acct', principalUserId: 'ivan', personalUserId: null });
    expect(models.map((m) => [m.id, m.via])).toEqual([
      ['codex/gpt-6-astra', 'chatgpt'],
      ['anthropic/claude-opus-4-8', 'key'],
      ['glm-5.3-flash', 'kortix'],
    ]);
    expect(defaultModel).toBe('codex/gpt-6-astra');
  });
});

describe('keyProviderOf', () => {
  test('a Kortix model needs no key; ChatGPT and API-key models name the key the gateway reads', () => {
    expect(access.keyProviderOf('kortix/glm-5.3-flash')).toBeNull();
    expect(access.keyProviderOf('kortix/codex/gpt-6-astra')).toEqual({ providerId: 'codex', envVar: 'CODEX_AUTH_JSON' });
    expect(access.keyProviderOf('anthropic/claude-opus-4-8')).toEqual({ providerId: 'anthropic', envVar: 'ANTHROPIC_API_KEY' });
    expect(access.keyProviderOf('mystery/model')).toBeNull();
  });
});

describe('channelKeySelection — every usable key, so they rotate', () => {
  test('selects every key of the provider this conversation may use, with its labels', async () => {
    usableKeys = [
      { secretId: 'k1', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'Team ChatGPT', accessMode: 'project' },
      { secretId: 'k2', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'Ivan ChatGPT', accessMode: 'members' },
      { secretId: 'k3', providerId: 'anthropic', name: 'ANTHROPIC_API_KEY', label: 'Claude', accessMode: 'project' },
    ];

    const keys = await access.channelKeySelection(scope(), 'codex/gpt-6-astra');

    expect(keys).toEqual({ providerId: 'codex', envVar: 'CODEX_AUTH_JSON', secretIds: ['k1', 'k2'], labels: ['Team ChatGPT', 'Ivan ChatGPT'] });
    // Grants follow the personal scope, not the member.
    expect(keyQueries[0]).toMatchObject({ userId: 'ivan', grantUserId: 'ivan', providerId: 'codex' });
  });

  test('a shared conversation asks for project-wide keys only', async () => {
    await access.channelKeySelection(scope({ personalUserId: null }), 'codex/gpt-6-astra');
    expect(keyQueries[0]).toMatchObject({ userId: 'ivan', grantUserId: null });
  });

  test('nothing to select: flag off, gateway off, a Kortix model, or no pooled key', async () => {
    usableKeys = [{ secretId: 'k1', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'x', accessMode: 'project' }];
    expect(await access.channelKeySelection(scope({ pooledEnabled: false }), 'codex/gpt-6-astra')).toBeNull();
    expect(await access.channelKeySelection(scope({ llmGatewayEnabled: false }), 'codex/gpt-6-astra')).toBeNull();
    expect(await access.channelKeySelection(scope(), 'glm-5.3-flash')).toBeNull();
    usableKeys = [];
    expect(await access.channelKeySelection(scope(), 'codex/gpt-6-astra')).toBeNull();
  });

  test('a key of another kind under the same provider is not selected', async () => {
    usableKeys = [{ secretId: 'k9', providerId: 'anthropic', name: 'OTHER_NAME', label: 'x', accessMode: 'project' }];
    expect(await access.channelKeySelection(scope(), 'anthropic/claude-opus-4-8')).toBeNull();
  });

  test('at most ten keys, the most one session may select', async () => {
    usableKeys = Array.from({ length: 12 }, (_, i) => ({
      secretId: `k${i}`, providerId: 'anthropic', name: 'ANTHROPIC_API_KEY', label: `key ${i}`, accessMode: 'project',
    }));
    expect((await access.channelKeySelection(scope(), 'anthropic/claude-opus-4-8'))?.secretIds).toHaveLength(10);
  });
});

describe('checkChannelModel — checked as the gateway will run it', () => {
  test('probes as the member, with the personal scope and the keys it would select', async () => {
    usableKeys = [{ secretId: 'k1', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'Team', accessMode: 'project' }];

    const verdict = await access.checkChannelModel(scope({ personalUserId: null }), 'codex/gpt-6-astra');

    expect(verdict).toMatchObject({ ok: true, model: 'kortix/codex/gpt-6-astra' });
    expect(probes[0]).toMatchObject({
      userId: 'ivan', personalUserId: null, providerSecretPools: { codex: ['k1'] }, model: 'codex/gpt-6-astra',
    });
  });

  test('an agent whose secret grant leaves out the key is refused before any probe', async () => {
    usableKeys = [{ secretId: 'k1', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'Team', accessMode: 'project' }];

    const verdict = await access.checkChannelModel(scope(), 'codex/gpt-6-astra', { agentGrantEnv: async () => ['GITHUB_TOKEN'] });

    expect(verdict).toEqual({ ok: false, reason: 'agent_grant', envVar: 'CODEX_AUTH_JSON', providerId: 'codex' });
    expect(probes).toHaveLength(0);
  });

  test('an unrestricted agent, or one granted the key, passes the grant check', async () => {
    usableKeys = [{ secretId: 'k1', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'Team', accessMode: 'project' }];
    for (const env of [null, 'all' as const, ['codex_auth_json']]) {
      expect((await access.checkChannelModel(scope(), 'codex/gpt-6-astra', { agentGrantEnv: async () => env })).ok).toBe(true);
    }
  });

  test('with no key to select, a live session`s own selection counts', async () => {
    await access.checkChannelModel(scope(), 'anthropic/claude-opus-4-8', { sessionId: 'sess-1' });
    expect(probes[0]).toMatchObject({ sessionId: 'sess-1' });
    expect(probes[0]).not.toHaveProperty('providerSecretPools');
  });

  test('a model the gateway would refuse is refused', async () => {
    servable = false;
    expect(await access.checkChannelModel(scope(), 'glm-5.3-flash')).toEqual({ ok: false, reason: 'not_servable' });
  });
});

describe('applyChannelSessionKeys', () => {
  const keys = { providerId: 'codex', envVar: 'CODEX_AUTH_JSON', secretIds: ['k1', 'k2'], labels: ['a', 'b'] };

  test('a /model change replaces the session`s selection for that provider', async () => {
    expect(await access.applyChannelSessionKeys({ sessionId: 's1', keys, replace: true })).toBe(true);
    expect(writes).toEqual([{ op: 'upsert', values: expect.objectContaining({ sessionId: 's1', providerId: 'codex', secretIds: ['k1', 'k2'] }) }]);
  });

  test('otherwise it fills only a missing selection, and keeps one a person set', async () => {
    insertReturning = [];
    expect(await access.applyChannelSessionKeys({ sessionId: 's1', keys, replace: false })).toBe(false);
    expect(writes[0]?.op).toBe('insert-if-absent');
  });

  test('no keys, nothing written', async () => {
    expect(await access.applyChannelSessionKeys({ sessionId: 's1', keys: null, replace: true })).toBe(false);
    expect(writes).toEqual([]);
  });
});

describe('describeKeys', () => {
  test('says which keys pay, and that they rotate', () => {
    expect(access.describeKeys({ providerId: 'codex', envVar: 'X', secretIds: ['a', 'b'], labels: ['Team', 'Ivan'] })).toBe(
      'Rotates across 2 ChatGPT connections: Team, Ivan.',
    );
    expect(access.describeKeys({ providerId: 'anthropic', envVar: 'X', secretIds: ['a'], labels: ['Claude'] })).toBe('Uses one key: Claude.');
    expect(access.describeKeys(null)).toBeNull();
  });
});
