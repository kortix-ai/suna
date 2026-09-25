import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Slack `/kortix models`, `/kortix model <id>` and the picker's controls. The
// list and every check run as the person who typed, with the conversation's
// personal scope (channels/model-access.ts, pinned in
// unit-channel-model-access). Before this, Slack listed Kortix models plus
// one model per legacy project key and checked every pick as the ACCOUNT
// OWNER: a model reached through a shared key or a ChatGPT subscription was
// missing from the list and refused when typed.

const testConfig = { SLACK_REQUIRE_USER_IDENTITY: true };
mock.module('../config', () => ({ SANDBOX_VERSION: 'test', config: testConfig }));

let gate: Record<string, unknown> | null = null;
mock.module('../channels/slack/model-gate', () => ({ channelModelContext: async () => gate }));
mock.module('../feature-flags/for-project', () => ({ projectFeatureFlagEnabled: async () => true }));

let actor: { userId: string } | { reason: string } = { userId: 'ivan' };
const actorLookups: string[] = [];
mock.module('../channels/slack/identity', () => ({
  resolveSlackActor: async (_team: string, slackUserId: string) => {
    actorLookups.push(slackUserId);
    return actor;
  },
}));

let selection: Record<string, unknown> | null = null;
const stored: Array<string | null> = [];
let bound = true;
mock.module('../channels/slack/selection', () => ({
  currentChannelSelection: async () => selection,
  setChannelModel: async (_ctx: unknown, model: string | null) => {
    stored.push(model);
    return bound;
  },
}));

mock.module('../llm-gateway/models/picker', () => ({
  labelForModelRef: (ref: string) => ref.replace(/^kortix\//, '').replace('anthropic/claude-opus-4-8', 'Claude Opus 4.8'),
}));

type Scope = { memberUserId: string; linkedUserId: string | null; personalUserId: string | null };
const checks: Array<{ scope: Scope; model: string }> = [];
let servableFor: (model: string, personal: string | null) => boolean = () => true;
const keysOf = { providerId: 'anthropic', envVar: 'ANTHROPIC_API_KEY', secretIds: ['k1', 'k2'], labels: ['Team', 'Ivan'] };
let currentKeys: typeof keysOf | null = null;
let grantVerdict: { ok: false; reason: 'agent_grant'; envVar: string; providerId: string } | null = null;
const grantAgents: Array<string | null | undefined> = [];
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
  channelKeySelection: async () => currentKeys,
  describeKeys: (keys: { labels: string[] } | null) => (keys ? `Rotates across ${keys.labels.join(', ')}.` : null),
  listChannelModels: async () => ({ models: catalog, defaultModel: 'glm-5.3-flash' }),
}));

const { applySlackModelChoice, buildSlackModelsResponse, slackModelScope } = await import('../channels/slack/model-choice');

const dm = { teamId: 'T1', channelId: 'D1', slackUserId: 'U1', command: '/kortix' };
const channel = { ...dm, channelId: 'C1' };

const text = (resp: unknown) => JSON.stringify(resp);
function findAccessory(resp: { blocks?: unknown[] }, type: string): Record<string, any> | undefined {
  for (const block of (resp.blocks ?? []) as Array<Record<string, any>>) {
    if (block.accessory?.type === type) return block.accessory;
  }
  return undefined;
}

beforeEach(() => {
  testConfig.SLACK_REQUIRE_USER_IDENTITY = true;
  gate = { projectId: 'proj', accountId: 'acct', ownerUserId: 'owner', freeManagedOnly: false, llmGatewayEnabled: true };
  actor = { userId: 'ivan' };
  actorLookups.length = 0;
  selection = { projectId: 'proj', agentName: null, opencodeModel: null };
  stored.length = 0;
  bound = true;
  checks.length = 0;
  servableFor = () => true;
  currentKeys = null;
  grantVerdict = null;
  grantAgents.length = 0;
  catalog = [];
});

describe('slackModelScope — whose keys a Slack conversation may use', () => {
  test('a DM with a linked person: that person, with their own keys', async () => {
    expect(await slackModelScope(dm)).toMatchObject({ memberUserId: 'ivan', personalUserId: 'ivan' });
  });

  test('a channel or group DM: the linked person, project-wide keys only', async () => {
    expect(await slackModelScope(channel)).toMatchObject({ memberUserId: 'ivan', personalUserId: null });
    expect(await slackModelScope({ ...dm, channelId: 'G1' })).toMatchObject({ personalUserId: null });
  });

  test('without required identity sessions run as the owner: no one`s personal keys, no identity lookup', async () => {
    testConfig.SLACK_REQUIRE_USER_IDENTITY = false;
    expect(await slackModelScope(dm)).toMatchObject({ memberUserId: 'owner', linkedUserId: null, personalUserId: null });
    expect(actorLookups).toHaveLength(0);
  });

  test('an unlinked person: the owner is the member, and no personal keys', async () => {
    actor = { reason: 'unlinked' };
    expect(await slackModelScope(dm)).toMatchObject({ memberUserId: 'owner', personalUserId: null });
  });
});

describe('/kortix models — what this person may run here', () => {
  const few = [
    { id: 'codex/gpt-6-astra', label: 'GPT-6 Astra (ChatGPT)', provider: 'codex', providerLabel: 'ChatGPT', via: 'chatgpt' },
    { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', provider: 'anthropic', providerLabel: 'Anthropic', via: 'key' },
    { id: 'glm-5.3-flash', label: 'GLM 5.3 Flash', provider: 'kortix', providerLabel: 'Kortix', via: 'kortix' },
  ];

  test('a short list: one button per model, each saying how it is paid for', async () => {
    catalog = few;
    selection = { projectId: 'proj', agentName: null, opencodeModel: 'kortix/anthropic/claude-opus-4-8' };
    currentKeys = keysOf;
    const resp = await buildSlackModelsResponse(dm);
    const all = text(resp);
    for (const piece of ['set_model_default', 'set_model_codex/gpt-6-astra', 'set_model_anthropic/claude-opus-4-8', 'set_model_glm-5.3-flash']) {
      expect(all).toContain(piece);
    }
    for (const piece of ['ChatGPT subscription', 'Anthropic key', '_Kortix_']) expect(all).toContain(piece);
    // The current pick is marked, and says which keys pay for it.
    expect(all).toContain('✓ *Claude Opus 4.8*');
    expect(all).toContain('This channel uses *Claude Opus 4.8*. Rotates across Team, Ivan.');
    expect(all).toContain('Includes your own API keys and ChatGPT subscriptions');
    expect(findAccessory(resp, 'static_select')).toBeUndefined();
  });

  test('a channel says only project-wide keys work there, and where the person`s own do', async () => {
    catalog = few;
    expect(text(await buildSlackModelsResponse(channel))).toContain('Your own keys and ChatGPT subscription work in a DM with me.');
  });

  test('a long list: one select, grouped by how each model is paid for, the current one preselected', async () => {
    catalog = [
      ...Array.from({ length: 11 }, (_, i) => ({
        id: `openrouter/model-${i}`, label: `Model ${i}`, provider: 'openrouter', providerLabel: 'OpenRouter', via: 'key',
      })),
      ...few,
    ];
    selection = { projectId: 'proj', agentName: null, opencodeModel: 'kortix/glm-5.3-flash' };
    const resp = await buildSlackModelsResponse(dm);
    const select = findAccessory(resp, 'static_select')!;
    expect(select.action_id).toBe('set_model_select');
    expect(select.option_groups.map((g: any) => [g.label.text, g.options.length])).toEqual([
      ['ChatGPT subscriptions', 1],
      ['API keys', 12],
      ['Kortix models', 1],
    ]);
    expect(select.initial_option.value).toBe(JSON.stringify({ c: 'D1', m: 'glm-5.3-flash' }));
    expect(text(resp)).toContain('Model 10 · OpenRouter key');
    // Slack caps a message at 50 blocks: the long list is one block, not 14.
    expect((resp.blocks ?? []).length).toBeLessThan(10);
  });

  test('past Slack`s 100 options, it says how many are shown and how to reach the rest', async () => {
    catalog = Array.from({ length: 130 }, (_, i) => ({
      id: `openrouter/model-${i}`, label: `A model with a name long enough to be clipped by Slack's limit ${i}`, provider: 'openrouter', providerLabel: 'OpenRouter', via: 'key',
    }));
    const resp = await buildSlackModelsResponse(dm);
    const options = findAccessory(resp, 'static_select')!.option_groups.flatMap((g: any) => g.options);
    expect(options).toHaveLength(100);
    expect(options.every((o: any) => o.text.text.length <= 75)).toBe(true);
    expect(text(resp)).toContain('Showing 100 of 130');
  });

  test('no project connected: says how to connect one', async () => {
    gate = null;
    expect(text(await buildSlackModelsResponse(dm))).toContain('No project is connected to this channel yet');
  });

  test('off the gateway: explains native refs instead of a list', async () => {
    gate = { ...gate, llmGatewayEnabled: false };
    expect(text(await buildSlackModelsResponse(dm))).toContain('native OpenCode models');
  });
});

describe('/kortix model — a choice is checked as the person who made it', () => {
  test('a DM: the model is stored with every key it may use, and says so', async () => {
    const reply = await applySlackModelChoice(dm, 'anthropic/claude-opus-4-8');
    expect(stored).toEqual(['kortix/anthropic/claude-opus-4-8']);
    expect(checks[0].scope).toMatchObject({ memberUserId: 'ivan', personalUserId: 'ivan' });
    expect(reply).toContain('Model for this channel set to *Claude Opus 4.8*');
    expect(reply).toContain('Rotates across Team, Ivan. New threads use it.');
  });

  test('the channel`s agent decides which keys may be used, and is named when it may not', async () => {
    selection = { projectId: 'proj', agentName: 'reviewer', opencodeModel: null };
    grantVerdict = { ok: false, reason: 'agent_grant', envVar: 'CODEX_AUTH_JSON', providerId: 'codex' };
    const reply = await applySlackModelChoice(dm, 'codex/gpt-6-astra');
    expect(grantAgents).toEqual(['reviewer']);
    expect(reply).toContain('The *reviewer* agent may not use ChatGPT connections. Add `CODEX_AUTH_JSON`');
    expect(stored).toHaveLength(0);
  });

  test('a channel cannot use a model that runs only on the person`s own keys: it says where it works', async () => {
    servableFor = (_model, personal) => personal === 'ivan';
    const reply = await applySlackModelChoice(channel, 'codex/gpt-6-astra');
    expect(checks.map((c) => c.scope.personalUserId)).toEqual([null, 'ivan']);
    expect(reply).toContain('which this shared channel cannot use. Pick it in a DM with me');
    expect(stored).toHaveLength(0);
  });

  test('an unlinked person is never told about the owner`s own keys', async () => {
    actor = { reason: 'unlinked' };
    servableFor = () => false;
    const reply = await applySlackModelChoice(dm, 'codex/gpt-6-astra');
    expect(checks).toHaveLength(1);
    expect(reply).toContain("isn't available for this workspace");
  });

  test('an id with whitespace is refused on shape, before any check', async () => {
    expect(await applySlackModelChoice(dm, 'not a model')).toContain("doesn't look like a model id");
    expect(checks).toHaveLength(0);
  });

  test('`default` resets the channel to the project default', async () => {
    expect(await applySlackModelChoice(dm, 'default')).toBe('Model reset to the project default.');
    expect(stored).toEqual([null]);
  });

  test('no project connected, or the binding is gone: says to connect one, nothing kept', async () => {
    gate = null;
    expect(await applySlackModelChoice(dm, 'glm-5.3-flash')).toContain('Connect a project first');
    gate = { projectId: 'proj', accountId: 'acct', ownerUserId: 'owner', freeManagedOnly: false, llmGatewayEnabled: true };
    bound = false;
    expect(await applySlackModelChoice(dm, 'glm-5.3-flash')).toContain('Connect a project first');
  });

  test('off the gateway a native ref is stored as typed; a gateway id is refused', async () => {
    gate = { ...gate, llmGatewayEnabled: false };
    expect(await applySlackModelChoice(dm, 'kortix/glm-5.3-flash')).toContain("isn't usable here");
    expect(await applySlackModelChoice(dm, 'anthropic/claude-sonnet-4-6')).toContain('New threads use it.');
    expect(stored).toEqual(['anthropic/claude-sonnet-4-6']);
  });
});
