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
const defaultCalls: Array<Record<string, unknown>> = [];
/** The default as the creator resolves it (their own keys count), and as a shared session does. */
let creatorDefault: { model: string | null; source: string } = { model: null, source: 'platform' };
let sharedDefault: { model: string | null; source: string } = { model: null, source: 'platform' };
mock.module('../llm-gateway/resolution/default-model', () => ({
  isModelServableForAccount: async (input: Record<string, unknown>) => {
    probes.push(input);
    return servable;
  },
  resolveEffectiveModel: async (input: Record<string, unknown>) => {
    defaultCalls.push(input);
    return 'personalUserId' in input ? sharedDefault : creatorDefault;
  },
}));

mock.module('../llm-gateway/models/served-managed-models', () => ({ platformDefaultModelId: () => 'glm-5.3-flash' }));

// The gateway's own personal-key rule for a live session.
const ownerQueries: Array<Record<string, unknown>> = [];
let gatewayPersonal: string | null = 'ivan';
mock.module('../projects/lib/personal-resources', () => ({
  resolveSessionPersonalOwner: async (input: Record<string, unknown>) => {
    ownerQueries.push(input);
    return gatewayPersonal;
  },
}));

// The image / unservable-pin replacement, pinned in unit-channel-vision-model.
const turnCalls: Array<Record<string, unknown>> = [];
let turnResult: string | null = null;
mock.module('../channels/vision-model', () => ({
  channelTurnModel: async (input: Record<string, unknown>) => {
    turnCalls.push(input);
    return turnResult;
  },
}));

const keyQueries: Array<Record<string, unknown>> = [];
let usableKeys: Array<{ secretId: string; providerId: string; name: string; label: string; accessMode: string }> = [];
mock.module('../secrets/account-resource', () => ({
  // As the query filters in SQL: provider and key name.
  listUsableGatewaySecrets: async (input: Record<string, unknown>) => {
    keyQueries.push(input);
    return usableKeys.filter((key) =>
      (!input.providerId || key.providerId === input.providerId) && (!input.name || key.name === input.name));
  },
}));

mock.module('../channels/slack/model-gate', () => ({
  channelModelContext: async () => ({
    projectId: 'proj', accountId: 'acct', ownerUserId: 'owner', freeManagedOnly: false, llmGatewayEnabled: true,
  }),
  projectModelContext: async (project: { projectId: string; accountId: string }) => ({
    projectId: project.projectId, accountId: project.accountId, ownerUserId: 'owner', freeManagedOnly: false, llmGatewayEnabled: true,
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
  projectId: 'proj', accountId: 'acct', memberUserId: 'ivan', linkedUserId: 'ivan', personalUserId: 'ivan',
  freeManagedOnly: false, llmGatewayEnabled: true, pooledEnabled: true, ...over,
});

beforeEach(() => {
  pooledFlag = true;
  catalogCalls.length = 0;
  probes.length = 0;
  defaultCalls.length = 0;
  creatorDefault = { model: null, source: 'platform' };
  sharedDefault = { model: null, source: 'platform' };
  ownerQueries.length = 0;
  gatewayPersonal = 'ivan';
  turnCalls.length = 0;
  turnResult = null;
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
      memberUserId: 'owner', linkedUserId: null, personalUserId: null,
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

describe('projectChannelModelScope', () => {
  test('reads the pooled-keys flag off the project row it is given', async () => {
    const on = await access.projectChannelModelScope(
      { projectId: 'p', accountId: 'a', metadata: { experimental: { pooled_provider_secrets: true } } },
      { linkedUserId: 'ivan', oneToOne: true },
    );
    expect(on).toMatchObject({ projectId: 'p', memberUserId: 'ivan', personalUserId: 'ivan', pooledEnabled: true });
    const off = await access.projectChannelModelScope({ projectId: 'p', accountId: 'a', metadata: {} }, { linkedUserId: null, oneToOne: true });
    expect(off).toMatchObject({ memberUserId: 'owner', personalUserId: null, pooledEnabled: false });
  });
});

describe('sessionModelScope — a live session, as the gateway runs it', () => {
  test('runs as the session`s owner; personal keys only when the gateway also uses them', async () => {
    const live = await access.sessionModelScope(scope(), { sessionId: 's1', ownerUserId: 'ivan' });
    expect(live).toMatchObject({ memberUserId: 'ivan', personalUserId: 'ivan' });
    expect(ownerQueries[0]).toEqual({ projectId: 'proj', accountId: 'acct', sessionId: 's1', legacyUserId: 'ivan' });
  });

  test('a personal chat`s session that is shared (created before these became private) reaches no personal key', async () => {
    gatewayPersonal = null;
    expect((await access.sessionModelScope(scope(), { sessionId: 's1', ownerUserId: 'ivan' })).personalUserId).toBeNull();
  });

  test('a session acting for someone else never lends their keys to this person', async () => {
    gatewayPersonal = 'someone-else';
    expect((await access.sessionModelScope(scope(), { sessionId: 's1', ownerUserId: 'someone-else' })).personalUserId).toBeNull();
  });

  test('a shared conversation does not look the session up at all', async () => {
    const live = await access.sessionModelScope(scope({ personalUserId: null }), { sessionId: 's1', ownerUserId: 'teammate' });
    expect(live).toMatchObject({ memberUserId: 'teammate', personalUserId: null });
    expect(ownerQueries).toHaveLength(0);
  });
});

describe('planChannelSessionStart — the model and keys a new chat session starts with', () => {
  const start = (over: Partial<Parameters<typeof access.planChannelSessionStart>[0]> = {}) =>
    access.planChannelSessionStart({
      projectId: 'proj', accountId: 'acct', userId: 'ivan', scope: scope(), chosenModel: null, agentName: null, hasImage: false, ...over,
    });

  test('a chosen model that runs on keys starts with every key this conversation may use', async () => {
    usableKeys = [
      { secretId: 'k1', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'Team', accessMode: 'project' },
      { secretId: 'k2', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'Ivan', accessMode: 'members' },
    ];

    const plan = await start({ chosenModel: 'kortix/codex/gpt-6-astra' });

    expect(plan).toEqual({ model: 'kortix/codex/gpt-6-astra', pools: { codex: ['k1', 'k2'] } });
    // Checked WITH those keys: without them a key-only model looked
    // unservable and was replaced by a Kortix model.
    expect(turnCalls[0]).toMatchObject({ userId: 'ivan', personalUserId: 'ivan', providerSecretPools: { codex: ['k1', 'k2'] } });
  });

  test('an agent that may not use the keys gets none, and the model is checked without them', async () => {
    usableKeys = [{ secretId: 'k1', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'Team', accessMode: 'project' }];
    const plan = await start({ chosenModel: 'codex/gpt-6-astra', agentGrantEnv: async () => ['GITHUB_TOKEN'] });
    expect(plan).toEqual({ model: 'codex/gpt-6-astra' });
    expect(turnCalls[0]).not.toHaveProperty('providerSecretPools');
  });

  test('a replacement on another provider does not carry the chosen model`s keys', async () => {
    usableKeys = [{ secretId: 'k1', providerId: 'codex', name: 'CODEX_AUTH_JSON', label: 'Team', accessMode: 'project' }];
    turnResult = 'glm-5.3-flash';
    expect(await start({ chosenModel: 'codex/gpt-6-astra', hasImage: true })).toEqual({ model: 'glm-5.3-flash' });
  });

  test('a shared conversation whose default runs on the creator`s own ChatGPT starts on the shared default', async () => {
    // The server resolves the default as if the creator's own ChatGPT
    // counted; in a shared session it does not, and the first turn failed
    // "Connect Codex to use this model".
    creatorDefault = { model: 'codex/gpt-6-astra', source: 'account' };
    sharedDefault = { model: 'anthropic/claude-opus-4-8', source: 'project' };
    const plan = await start({ scope: scope({ personalUserId: null }), agentName: 'reviewer' });
    expect(defaultCalls).toHaveLength(2);
    expect(defaultCalls[0]).not.toHaveProperty('personalUserId');
    expect(defaultCalls[1]).toMatchObject({ userId: 'ivan', agentName: 'reviewer', personalUserId: null, explicit: null });
    expect(plan.model).toBe('anthropic/claude-opus-4-8');
  });

  test('when only the platform default is left, it is pinned — never the creator`s own default', async () => {
    creatorDefault = { model: 'codex/gpt-6-astra', source: 'account' };
    expect((await start({ scope: scope({ personalUserId: null }) })).model).toBe('glm-5.3-flash');
    expect((await start({ scope: scope({ personalUserId: null, freeManagedOnly: true }) })).model).toBeNull();
  });

  test('when the creator`s own keys change nothing, the server resolves the default itself', async () => {
    // An agent's own default model stays the server's to apply, with its
    // real source.
    creatorDefault = { model: 'anthropic/claude-opus-4-8', source: 'agent' };
    sharedDefault = { model: 'anthropic/claude-opus-4-8', source: 'agent' };
    expect(await start({ scope: scope({ personalUserId: null }) })).toEqual({ model: null });
  });

  test('a personal chat with no choice leaves the default to the server: its rule is the same', async () => {
    expect(await start()).toEqual({ model: null });
    expect(defaultCalls).toHaveLength(0);
  });

  test('no scope: the legacy check, with the choice kept', async () => {
    expect(await start({ scope: null, chosenModel: 'anthropic/x' })).toEqual({ model: 'anthropic/x' });
    expect(turnCalls[0]).not.toHaveProperty('personalUserId');
  });
});

describe('planChannelFollowUp — the model a follow-up carries', () => {
  const session = { sessionId: 's1', ownerUserId: 'ivan', pinnedModel: 'kortix/codex/gpt-6-astra' };
  const followUp = (over: Partial<Parameters<typeof access.planChannelFollowUp>[0]> = {}) =>
    access.planChannelFollowUp({
      projectId: 'proj', accountId: 'acct', userId: 'ivan', scope: scope(), session, chosenModel: null, hasImage: false, ...over,
    });

  test('a /model choice made after the session started travels with the prompt', async () => {
    await followUp({ chosenModel: 'kortix/deepseek-v4.1-flash' });
    expect(turnCalls[0]).toMatchObject({
      currentModel: 'kortix/deepseek-v4.1-flash', explicit: true, sessionId: 's1', userId: 'ivan', personalUserId: 'ivan',
    });
  });

  test('the session`s own pin is not re-sent: no choice, or the same one', async () => {
    await followUp();
    await followUp({ chosenModel: 'codex/gpt-6-astra' });
    expect(turnCalls.map((c) => [c.currentModel, c.explicit])).toEqual([
      ['kortix/codex/gpt-6-astra', false],
      ['codex/gpt-6-astra', false],
    ]);
  });

  test('a ChatGPT pin in a shared session is checked without anyone`s own connection, so it is replaced', async () => {
    // The dev regression: a Teams channel session pinned to codex failed
    // every turn with "Connect Codex to use this model" once agents became
    // their own principal, because the check still counted the typist's
    // own ChatGPT connection.
    await followUp({ scope: scope({ personalUserId: null }) });
    expect(turnCalls[0]).toMatchObject({ personalUserId: null, sessionId: 's1' });
  });

  test('keys for the model are filled into a session that has none, before the check', async () => {
    usableKeys = [{ secretId: 'k1', providerId: 'anthropic', name: 'ANTHROPIC_API_KEY', label: 'Claude', accessMode: 'project' }];
    await followUp({ chosenModel: 'anthropic/claude-opus-4-8' });
    expect(writes).toEqual([{ op: 'insert-if-absent', values: expect.objectContaining({ sessionId: 's1', providerId: 'anthropic', secretIds: ['k1'] }) }]);
  });

  test('off the gateway a choice waits for the next session: it cannot travel per prompt', async () => {
    await followUp({ scope: scope({ llmGatewayEnabled: false }), chosenModel: 'anthropic/claude-sonnet-4-6', session: { ...session, pinnedModel: null } });
    expect(turnCalls[0]).toMatchObject({ currentModel: null, explicit: false });
  });

  test('no scope: the pin, checked the legacy way', async () => {
    await followUp({ scope: null, chosenModel: 'kortix/deepseek-v4.1-flash' });
    expect(turnCalls[0]).toEqual({
      projectId: 'proj', accountId: 'acct', userId: 'ivan', currentModel: 'kortix/codex/gpt-6-astra', hasImage: false, agentGrantEnv: undefined,
    });
  });
});
