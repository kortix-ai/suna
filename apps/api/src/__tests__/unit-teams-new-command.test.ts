import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// The `/new` command end to end through handleTeamsCommand: what the user
// sees in the chat, and what reaches the next session. fresh-start.ts owns the
// reset rules (unit-teams-fresh-start.test.ts); this pins the wiring.

const PROJECT = '00000000-0000-4000-8000-000000000001';
const TENANT = 'tenant-1';
const CONVO = 'a:synthetic-chat';

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  config: { FRONTEND_URL: 'https://dev.kortix.com', TEAMS_REQUIRE_USER_IDENTITY: true },
}));

// commands.ts reaches the model picker and the gateway through other verbs.
// `/new` touches none of them; these keep the import graph off the network.
mock.module('../llm-gateway/models/picker', () => ({ listPickerModels: async () => [], labelForModelRef: (r: string) => r }));
mock.module('../llm-gateway/resolution/default-model', () => ({ isModelServableForAccount: async () => true }));
mock.module('../projects/lib/session-model-change', () => ({ validateNativeOpencodeModelRef: () => null }));
mock.module('../llm-gateway/resolution/effective', () => ({ toOpencodeModelRef: (r: string) => r, toWireModel: (r: string) => r }));
mock.module('../channels/slack/model-gate', () => ({ channelModelContext: async () => ({}) }));
mock.module('../projects/lib/access', () => ({ lookupEmailsByUserIds: async () => new Map() }));
mock.module('../channels/teams/agent-picker', () => ({ buildAgentsPicker: async () => ({}) }));
mock.module('../channels/teams/stop', () => ({ stopTeamsTurn: async () => ({ stopped: false, notice: '' }) }));
mock.module('../channels/teams/login', () => ({ buildTeamsLoginUrl: () => 'https://login' }));

let channelPolicy: string | null = 'owner_approval';
mock.module('../channels/slack/selection', () => ({
  currentChannelSelection: async () => ({ projectId: PROJECT, agentName: null, opencodeModel: null, conversationPolicy: channelPolicy }),
  loadProjectAgentGovernance: async () => null,
  setChannelAgent: async () => ({ ok: true }),
  setChannelConversationPolicy: async () => true,
  setChannelModel: async () => true,
  listProjectAgents: async () => [],
}));

mock.module('../channels/teams/binding', () => ({
  conversationSession: async () => null,
  ensureTeamsConversationBinding: async () => true,
  listTenantProjects: async () => [],
  resolveConversationProject: async () => PROJECT,
  setConversationProject: async () => true,
  teamsChannelCtx: () => ({ platform: 'teams', teamId: TENANT, channelId: CONVO }),
}));

mock.module('../channels/teams/identity', () => ({
  lookupTeamsIdentity: async () => null,
  revokeTeamsIdentity: async () => false,
  teamsUserId: (a: { from?: { aadObjectId?: string; id?: string } }) => a.from?.aadObjectId ?? a.from?.id ?? null,
}));

const posted: Array<Record<string, unknown>> = [];
mock.module('../channels/teams-api', () => ({
  sendCard: async (_ref: unknown, card: Record<string, unknown>) => {
    posted.push(card);
    return 'card-1';
  },
}));

type FreshOutcome = { reset: true; previousSessionId: string | null } | { reset: false; notice: string };
let freshOutcome: FreshOutcome = { reset: true, previousSessionId: 'sess-old' };
const freshCalls: Array<Record<string, unknown>> = [];
mock.module('../channels/teams/fresh-start', () => ({
  startFreshTeamsConversation: async (input: Record<string, unknown>) => {
    freshCalls.push(input);
    return freshOutcome;
  },
  // A copy of the extraction; unit-teams-fresh-start.test.ts pins the real one.
  messageAfterFreshStart: (activity: { text?: string }) =>
    (activity.text ?? '').replace(/^\/(?:new|reset)\b[ \t]*\n?/i, '').trim(),
}));

const started: Array<{ text?: string; id?: string }> = [];
mock.module('../channels/teams/session', () => ({
  createOrJoinTeamsConversationSession: async (input: { activity: { text?: string; id?: string } }) => {
    started.push(input.activity);
  },
}));

const { handleTeamsCommand, parseTeamsCommand } = await import('../channels/teams/commands');

const activity = (text: string, conversationType = 'personal') => ({
  type: 'message',
  id: 'act-1',
  text,
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
  conversation: { id: CONVO, tenantId: TENANT, conversationType },
  from: { id: '29:abc', aadObjectId: 'aad-user-1', name: 'Ivan' },
  recipient: { id: '28:bot' },
});

const run = async (text: string, conversationType?: string) => {
  const a = activity(text, conversationType);
  return handleTeamsCommand({ command: parseTeamsCommand(a.text)!, activity: a as never, tenantId: TENANT, projectId: PROJECT });
};

const cardText = (card: Record<string, unknown>) => JSON.stringify(card);

beforeEach(() => {
  posted.length = 0;
  started.length = 0;
  freshCalls.length = 0;
  freshOutcome = { reset: true, previousSessionId: 'sess-old' };
  channelPolicy = 'owner_approval';
});

afterAll(() => {
  mock.restore();
});

describe('/new', () => {
  test('alone: confirms, links the previous session, and starts nothing yet', async () => {
    expect(await run('/new')).toBe(true);

    expect(posted).toHaveLength(1);
    expect(cardText(posted[0]!)).toContain('Your next message starts a new session.');
    expect(cardText(posted[0]!)).toContain(`https://dev.kortix.com/projects/${PROJECT}/sessions/sess-old`);
    expect(started).toEqual([]);
  });

  test('with a message: the message starts the new session at once', async () => {
    await run('/new plan the sprint');

    expect(cardText(posted[0]!)).toContain('Starting a new session.');
    expect(started).toHaveLength(1);
    expect(started[0]!.text).toBe('plan the sprint');
    // A distinct id, so it is not mistaken for the command's own activity.
    expect(started[0]!.id).toBe('act-1:new');
  });

  test('passes the chat`s scope, the presser`s AAD id and the conversation`s policy', async () => {
    await run('/new', 'groupChat');

    expect(freshCalls[0]).toEqual({
      tenantId: TENANT,
      conversationId: CONVO,
      scope: 'groupChat',
      teamsUserId: 'aad-user-1',
      channelPolicy: 'owner_approval',
    });
  });

  test('a refusal is shown as it is, and nothing starts', async () => {
    freshOutcome = { reset: false, notice: 'A run is still going here.' };

    await run('/new do the thing');

    expect(posted).toHaveLength(1);
    expect(cardText(posted[0]!)).toContain('A run is still going here.');
    expect(started).toEqual([]);
  });

  test('a chat that had no session says so without a dead link', async () => {
    freshOutcome = { reset: true, previousSessionId: null };

    await run('/reset');

    expect(cardText(posted[0]!)).toContain('Your next message starts a new session.');
    expect(cardText(posted[0]!)).not.toContain('/sessions/');
  });

  test('the help card lists it', async () => {
    await run('/help');

    expect(cardText(posted[0]!)).toContain('/new');
  });
});
