import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { chatIdentityStub } from './helpers/chat-identity-stub';

// Teams `/models`, `/model <id>` and the model card's buttons. The list and
// every check run as the person who typed, with the conversation's personal
// scope (channels/model-access.ts, pinned in unit-channel-model-access). This
// file pins who that is, what the card offers, and what a choice does to the
// conversation's live session: on dev, `/model` answered "Model set to …"
// while the live session kept failing on its old ChatGPT model.

const CTX = { platform: 'teams', teamId: 'tenant-1', channelId: 'a:synthetic-chat' };
const testConfig = { TEAMS_REQUIRE_USER_IDENTITY: true };
mock.module('../config', () => ({ SANDBOX_VERSION: 'test', config: testConfig }));

let gate: Record<string, unknown> | null = null;
mock.module('../channels/slack/model-gate', () => ({ channelModelContext: async () => gate }));
mock.module('../feature-flags/for-project', () => ({ projectFeatureFlagEnabled: async () => true }));

let actor: { userId: string } | { reason: string } = { userId: 'ivan' };
const actorLookups: string[] = [];
mock.module('../channels/teams/identity', () => ({
  teamsUserId: () => 'aad-ivan',
}));
// The same linked person decides the scope and, through core/settings.ts,
// whether they may change this conversation's settings at all.
mock.module('../channels/core/identity', () =>
  chatIdentityStub({
    resolveChatActor: async (user: { platformUserId: string }) => {
      actorLookups.push(user.platformUserId);
      return actor;
    },
    resolveProjectChatActor: async () => actor,
  }),
);

let live: {
  sessionId: string;
  agentName: string | null;
  createdBy: string | null;
  conversationPolicy?: string | null;
  opencodeModel?: string | null;
} | null = null;
mock.module('../channels/teams/binding', () => ({
  conversationSession: async () => live,
  teamsChannelCtx: () => CTX,
}));

mock.module('../channels/teams/participants', () => ({
  normalizeConversationPolicy: (v: unknown) =>
    v === 'owner_only' || v === 'owner_approval' || v === 'project_open' ? v : 'project_open',
}));

let selection: Record<string, unknown> | null = null;
const stored: Array<string | null> = [];
mock.module('../channels/slack/selection', () => ({
  currentChannelSelection: async () => selection,
  setChannelAgent: async () => ({ ok: true }),
  setChannelConversationPolicy: async () => true,
  setChannelModel: async (_ctx: unknown, model: string | null) => {
    stored.push(model);
    return true;
  },
}));

mock.module('../llm-gateway/models/picker', () => ({
  labelForModelRef: (ref: string) => ref.replace(/^kortix\//, '').replace('anthropic/claude-opus-4-8', 'Claude Opus 4.8'),
}));

type Scope = { memberUserId: string; linkedUserId: string | null; personalUserId: string | null };
const checks: Array<{ scope: Scope; model: string }> = [];
/** Which models pass, by the personal user the check ran with. */
let servableFor: (model: string, personal: string | null) => boolean = () => true;
const keysOf = { providerId: 'anthropic', envVar: 'ANTHROPIC_API_KEY', secretIds: ['k1', 'k2'], labels: ['Team', 'Ivan'] };
let grantVerdict: { ok: false; reason: 'agent_grant'; envVar: string; providerId: string } | null = null;
const grantAgents: Array<string | null | undefined> = [];
const keyWrites: Array<Record<string, unknown>> = [];
let liveReachesPersonal = true;
let catalog: Array<Record<string, unknown>> = [];

mock.module('../channels/model-access', () => ({
  channelModelScope: (input: {
    projectId: string;
    accountId: string;
    ownerUserId: string;
    linkedUserId: string | null;
    oneToOne: boolean;
    freeManagedOnly: boolean;
    llmGatewayEnabled: boolean;
    pooledEnabled: boolean;
  }) => ({
    projectId: input.projectId,
    accountId: input.accountId,
    memberUserId: input.linkedUserId ?? input.ownerUserId,
    linkedUserId: input.linkedUserId,
    personalUserId: input.linkedUserId && input.oneToOne ? input.linkedUserId : null,
    freeManagedOnly: input.freeManagedOnly,
    llmGatewayEnabled: input.llmGatewayEnabled,
    pooledEnabled: input.pooledEnabled,
  }),
  agentGrantEnvFor: (_projectId: string, agentName: string | null | undefined) => {
    grantAgents.push(agentName);
    return async () => null;
  },
  checkChannelModel: async (scope: Scope, model: string) => {
    checks.push({ scope, model });
    if (grantVerdict) return grantVerdict;
    return servableFor(model, scope.personalUserId)
      ? { ok: true, model: `kortix/${model}`, keys: model.includes('/') ? keysOf : null }
      : { ok: false, reason: 'not_servable' };
  },
  sessionModelScope: async (scope: Scope, session: { ownerUserId: string | null }) => ({
    ...scope,
    memberUserId: session.ownerUserId ?? scope.memberUserId,
    personalUserId: liveReachesPersonal ? scope.personalUserId : null,
  }),
  applyChannelSessionKeys: async (input: Record<string, unknown>) => {
    keyWrites.push(input);
    return true;
  },
  channelKeySelection: async () => null,
  describeKeys: (keys: { labels: string[] } | null) => (keys ? `Rotates across ${keys.labels.join(', ')}.` : null),
  listChannelModels: async () => ({ models: catalog, defaultModel: 'glm-5.3-flash' }),
}));

const { applyTeamsModelChoice, buildTeamsModelsCard, statusModel, teamsModelScope } = await import('../channels/teams/model-choice');

const personal = { conversation: { id: 'a:synthetic-chat', conversationType: 'personal' }, from: { id: '29:x', aadObjectId: 'aad-ivan' } };
const groupChat = { ...personal, conversation: { id: 'a:synthetic-chat', conversationType: 'groupChat' } };

const cardText = (card: unknown) => JSON.stringify(card);

beforeEach(() => {
  testConfig.TEAMS_REQUIRE_USER_IDENTITY = true;
  gate = { projectId: 'proj', accountId: 'acct', ownerUserId: 'owner', freeManagedOnly: false, llmGatewayEnabled: true };
  actor = { userId: 'ivan' };
  actorLookups.length = 0;
  live = null;
  selection = { projectId: 'proj', agentName: null, opencodeModel: null };
  stored.length = 0;
  checks.length = 0;
  servableFor = () => true;
  grantVerdict = null;
  grantAgents.length = 0;
  keyWrites.length = 0;
  liveReachesPersonal = true;
  catalog = [];
});

describe('teamsModelScope — whose keys a Teams conversation may use', () => {
  test('a personal chat with a linked person: that person, with their own keys', async () => {
    expect(await teamsModelScope(personal as never, 'tenant-1', 'a:synthetic-chat')).toMatchObject({
      memberUserId: 'ivan', personalUserId: 'ivan',
    });
  });

  test('a group chat: the linked person, project-wide keys only', async () => {
    expect(await teamsModelScope(groupChat as never, 'tenant-1', 'a:synthetic-chat')).toMatchObject({
      memberUserId: 'ivan', personalUserId: null,
    });
  });

  test('a conversation Teams did not type is not treated as personal', async () => {
    const untyped = { ...personal, conversation: { id: 'a:synthetic-chat' } };
    expect((await teamsModelScope(untyped as never, 'tenant-1', 'a:synthetic-chat'))?.personalUserId).toBeNull();
  });

  test('without required identity sessions run as the owner: no one`s personal keys, no identity lookup', async () => {
    testConfig.TEAMS_REQUIRE_USER_IDENTITY = false;
    expect(await teamsModelScope(personal as never, 'tenant-1', 'a:synthetic-chat')).toMatchObject({
      memberUserId: 'owner', linkedUserId: null, personalUserId: null,
    });
    expect(actorLookups).toHaveLength(0);
  });
});

describe('/model — a choice reaches the live session', () => {
  test('a personal chat`s private session: the model is stored and its keys replace the session`s', async () => {
    live = { sessionId: 'sess-1', agentName: 'reviewer', createdBy: 'ivan' };

    const card = await applyTeamsModelChoice(personal as never, 'tenant-1', 'a:synthetic-chat', 'anthropic/claude-opus-4-8');

    expect(stored).toEqual(['kortix/anthropic/claude-opus-4-8']);
    expect(keyWrites).toEqual([{ sessionId: 'sess-1', keys: keysOf, replace: true }]);
    expect(checks[0].scope).toMatchObject({ memberUserId: 'ivan', personalUserId: 'ivan' });
    // The live session's agent decides which keys it may use.
    expect(grantAgents).toEqual(['reviewer']);
    expect(cardText(card)).toContain('Model set to Claude Opus 4.8. Rotates across Team, Ivan. Your next message uses it.');
  });

  test('an unlinked person cannot change the model of a live session', async () => {
    live = { sessionId: 'sess-1', agentName: null, createdBy: 'ivan' };
    actor = { reason: 'unlinked' };
    const card = await applyTeamsModelChoice(groupChat as never, 'tenant-1', 'a:synthetic-chat', 'glm-5.3-flash');
    expect(cardText(card)).toContain('Connect your Kortix account first');
    expect(stored).toHaveLength(0);
  });

  test('under an owner-only or approval policy only the session`s owner can change it', async () => {
    for (const policy of ['owner_only', 'owner_approval']) {
      live = { sessionId: 'sess-1', agentName: null, createdBy: 'someone-else', conversationPolicy: policy };
      const card = await applyTeamsModelChoice(groupChat as never, 'tenant-1', 'a:synthetic-chat', 'glm-5.3-flash');
      expect(cardText(card)).toContain("Only the person who started this chat's session can change its model.");
    }
    expect(stored).toHaveLength(0);
    live = { sessionId: 'sess-1', agentName: null, createdBy: 'ivan', conversationPolicy: 'owner_only' };
    await applyTeamsModelChoice(groupChat as never, 'tenant-1', 'a:synthetic-chat', 'glm-5.3-flash');
    expect(stored).toEqual(['kortix/glm-5.3-flash']);
  });

  test('an open conversation: any linked member may change it', async () => {
    live = { sessionId: 'sess-1', agentName: null, createdBy: 'someone-else', conversationPolicy: 'project_open' };
    await applyTeamsModelChoice(groupChat as never, 'tenant-1', 'a:synthetic-chat', 'glm-5.3-flash');
    expect(stored).toEqual(['kortix/glm-5.3-flash']);
  });

  test('no live session: stored for the next one, nothing written to a session', async () => {
    await applyTeamsModelChoice(personal as never, 'tenant-1', 'a:synthetic-chat', 'glm-5.3-flash');
    expect(stored).toEqual(['kortix/glm-5.3-flash']);
    expect(keyWrites).toHaveLength(0);
  });

  test('an agent that may not use the keys is named, with the fix', async () => {
    live = { sessionId: 'sess-1', agentName: 'reviewer', createdBy: 'ivan' };
    grantVerdict = { ok: false, reason: 'agent_grant', envVar: 'CODEX_AUTH_JSON', providerId: 'codex' };
    const card = await applyTeamsModelChoice(personal as never, 'tenant-1', 'a:synthetic-chat', 'codex/gpt-6-astra');
    expect(cardText(card)).toContain('The reviewer agent may not use ChatGPT connections. Add `CODEX_AUTH_JSON`');
    expect(stored).toHaveLength(0);
  });

  test('a shared chat cannot use a model that runs only on the person`s own keys: it says where it works', async () => {
    servableFor = (_model, personalUser) => personalUser === 'ivan';
    const card = await applyTeamsModelChoice(groupChat as never, 'tenant-1', 'a:synthetic-chat', 'codex/gpt-6-astra');
    expect(checks.map((c) => c.scope.personalUserId)).toEqual([null, 'ivan']);
    expect(cardText(card)).toContain('which this shared chat cannot use. Pick it in a personal chat with me');
    expect(stored).toHaveLength(0);
  });

  test('a personal chat whose live session is still shared: stored, and /new is the way to use it', async () => {
    live = { sessionId: 'sess-old', agentName: null, createdBy: 'ivan' };
    liveReachesPersonal = false;
    servableFor = (_model, personalUser) => personalUser === 'ivan';
    const card = await applyTeamsModelChoice(personal as never, 'tenant-1', 'a:synthetic-chat', 'codex/gpt-6-astra');
    expect(stored).toEqual(['kortix/codex/gpt-6-astra']);
    expect(keyWrites).toHaveLength(0);
    expect(cardText(card)).toContain('Send /new to start a session that is private to you');
  });

  test('an unlinked person is never told about the owner`s own keys: they are asked to link, and nothing is checked or stored', async () => {
    actor = { reason: 'unlinked' };
    servableFor = () => false;
    const card = await applyTeamsModelChoice(personal as never, 'tenant-1', 'a:synthetic-chat', 'codex/gpt-6-astra');
    expect(checks).toHaveLength(0);
    expect(stored).toHaveLength(0);
    expect(cardText(card)).toContain('Connect your Kortix account first');
    expect(cardText(card)).not.toContain('your own API key');
  });

  test('`default` with a live session: new sessions use the default, the live one keeps its own model', async () => {
    live = { sessionId: 'sess-1', agentName: null, createdBy: 'ivan', opencodeModel: 'kortix/codex/gpt-6-astra' };
    const card = await applyTeamsModelChoice(personal as never, 'tenant-1', 'a:synthetic-chat', 'default');
    expect(stored).toEqual([null]);
    expect(cardText(card)).toContain("This chat's session keeps codex/gpt-6-astra; send /new to start on the default.");
  });

  test('`default` is guarded like any change to a live session', async () => {
    live = { sessionId: 'sess-1', agentName: null, createdBy: 'someone-else', conversationPolicy: 'owner_only' };
    const card = await applyTeamsModelChoice(groupChat as never, 'tenant-1', 'a:synthetic-chat', 'default');
    expect(cardText(card)).toContain("Only the person who started this chat's session can change its model.");
    expect(stored).toHaveLength(0);
  });

  test('`default` resets the conversation to the project default', async () => {
    const card = await applyTeamsModelChoice(personal as never, 'tenant-1', 'a:synthetic-chat', 'default');
    expect(stored).toEqual([null]);
    expect(cardText(card)).toContain('Model reset to the project default.');
  });

  test('off the gateway a native ref is stored as typed; a gateway id is refused', async () => {
    gate = { ...gate, llmGatewayEnabled: false };
    expect(cardText(await applyTeamsModelChoice(personal as never, 'tenant-1', 'a:synthetic-chat', 'kortix/glm-5.3-flash'))).toContain(
      "isn't usable here",
    );
    const ok = await applyTeamsModelChoice(personal as never, 'tenant-1', 'a:synthetic-chat', 'anthropic/claude-sonnet-4-6');
    expect(stored).toEqual(['anthropic/claude-sonnet-4-6']);
    expect(cardText(ok)).toContain('New sessions will use it.');
  });
});

describe('/models — the card lists what this person may run here', () => {
  const few = [
    { id: 'codex/gpt-6-astra', label: 'GPT-6 Astra (ChatGPT)', provider: 'codex', providerLabel: 'ChatGPT', via: 'chatgpt' },
    { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', providerLabel: 'Anthropic', via: 'key' },
    { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', provider: 'kortix', providerLabel: 'Kortix', via: 'kortix' },
  ];

  test('a short list is one-tap buttons, each saying how it is paid for', async () => {
    catalog = few;
    const text = cardText(await buildTeamsModelsCard(personal as never, 'tenant-1', 'a:synthetic-chat'));
    for (const piece of ['GPT-6 Astra (ChatGPT)', 'ChatGPT subscription', 'Claude Opus 4.8', 'Anthropic key', 'GLM 5.3 Flash', 'Project default', 'teams_set_model']) {
      expect(text).toContain(piece);
    }
    expect(text).toContain('Includes your own API keys and ChatGPT subscriptions');
    expect(text).not.toContain('Input.ChoiceSet');
  });

  test('a shared chat says which keys count there, and where the person`s own work', async () => {
    catalog = few;
    const text = cardText(await buildTeamsModelsCard(groupChat as never, 'tenant-1', 'a:synthetic-chat'));
    expect(text).toContain('only keys shared with the whole project work');
  });

  test('a long list becomes one searchable dropdown with a Use button', async () => {
    catalog = Array.from({ length: 12 }, (_, i) => ({
      id: `openrouter/model-${i}`, label: `Model ${i}`, provider: 'openrouter', providerLabel: 'OpenRouter', via: 'key',
    }));
    const card = (await buildTeamsModelsCard(personal as never, 'tenant-1', 'a:synthetic-chat')) as Record<string, unknown>;
    const text = cardText(card);
    expect(text).toContain('"type":"Input.ChoiceSet"');
    expect(text).toContain('"style":"filtered"');
    expect(text).toContain('Model 11 · OpenRouter key');
    expect(text).toContain('Use model');
  });

  test('no project connected: says how to connect one', async () => {
    gate = null;
    expect(cardText(await buildTeamsModelsCard(personal as never, 'tenant-1', 'a:synthetic-chat'))).toContain('Connect a project');
  });

  test('off the gateway: explains native refs instead of a list', async () => {
    gate = { ...gate, llmGatewayEnabled: false };
    expect(cardText(await buildTeamsModelsCard(personal as never, 'tenant-1', 'a:synthetic-chat'))).toContain('native OpenCode models');
  });
});

describe('/status — the model the next message runs on', () => {
  test('the conversation`s choice, which reaches the live session too', () => {
    expect(statusModel('kortix/glm-5.3-flash', { opencodeModel: 'kortix/codex/gpt-6-astra' }, true)).toBe('glm-5.3-flash');
  });

  test('no choice: the model the live session started with — not "project default"', () => {
    // A chat stuck on a ChatGPT pin it could not run read "project default" here.
    expect(statusModel(null, { opencodeModel: 'kortix/codex/gpt-6-astra' }, true)).toBe('codex/gpt-6-astra (this session)');
  });

  test('no choice and no session: the project default', () => {
    expect(statusModel(null, null, true)).toBe('project default');
  });

  test('off the gateway a choice waits for /new, so both are named', () => {
    expect(statusModel('anthropic/claude-sonnet-4-6', { opencodeModel: 'openai/gpt-5.5' }, false)).toBe(
      'openai/gpt-5.5 (this session; anthropic/claude-sonnet-4-6 from /new)',
    );
    expect(statusModel('anthropic/claude-sonnet-4-6', null, false)).toBe('anthropic/claude-sonnet-4-6');
  });
});
