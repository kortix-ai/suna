import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chatIdentityStub } from './helpers/chat-identity-stub';

// A conversation's project, agent, model and policy are project settings.
// Changing one from Teams needs what the web binding editor needs: a linked
// Kortix account with `project.connector.write` on the conversation's project
// (project managers, account owners and admins). The commands and the card
// buttons both go through channels/core/settings.ts.

const PROJECT = 'proj-1';
const OTHER = 'proj-2';
const TENANT = 'tenant-1';
const CONVO = '19:abc@thread.tacv2';

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  config: { FRONTEND_URL: 'https://dev.kortix.com', TEAMS_REQUIRE_USER_IDENTITY: true },
}));

let dbResults: unknown[][] = [];
const inserts: unknown[] = [];
function chain(): any {
  const c: any = {};
  for (const m of ['from', 'where', 'limit']) c[m] = () => c;
  c.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return c;
}
mock.module('../shared/db', () => ({
  db: {
    select: () => chain(),
    insert: () => ({
      values: (v: unknown) => {
        inserts.push(v);
        return { onConflictDoUpdate: async () => [] };
      },
    }),
  },
  hasDatabase: () => true,
}));

let settingsActor: { userId: string } | { reason: 'unlinked' | 'not_member' } = { userId: 'user-1' };
const actorChecks: Array<{ projectId: string; action: string }> = [];
mock.module('../channels/core/identity', () =>
  chatIdentityStub({
    resolveProjectChatActor: async (_user: unknown, projectId: string, action: string) => {
      actorChecks.push({ projectId, action });
      return settingsActor;
    },
  }),
);

const writes: Array<{ kind: string; value: unknown }> = [];
mock.module('../channels/slack/selection', () => ({
  currentChannelSelection: async () => ({ projectId: PROJECT, agentName: null, opencodeModel: null, conversationPolicy: null }),
  setChannelAgent: async (_c: unknown, a: string | null) => {
    writes.push({ kind: 'agent', value: a });
    return { ok: true };
  },
  setChannelModel: async (_c: unknown, m: string | null) => {
    writes.push({ kind: 'model', value: m });
    return true;
  },
  setChannelConversationPolicy: async (_c: unknown, p: string) => {
    writes.push({ kind: 'policy', value: p });
    return true;
  },
  listProjectAgents: async () => [],
}));
mock.module('../channels/slack/model-gate', () => ({
  channelModelContext: async () => ({
    projectId: PROJECT,
    accountId: 'acct-1',
    ownerUserId: 'owner-1',
    freeManagedOnly: false,
    llmGatewayEnabled: true,
  }),
}));
mock.module('../llm-gateway/models/picker', () => ({
  listPickerModels: async () => ({ models: [], projectDefault: { label: null } }),
  labelForModelRef: (r: string) => r,
}));
mock.module('../llm-gateway/resolution/default-model', () => ({ isModelServableForAccount: async () => true }));
mock.module('../projects/lib/access', () => ({ lookupEmailsByUserIds: async () => new Map() }));
mock.module('../channels/teams/agent-picker', () => ({ buildAgentsPicker: async () => ({}) }));
mock.module('../channels/teams/stop', () => ({ stopTeamsTurn: async () => ({ stopped: false, notice: '' }) }));
mock.module('../channels/teams/login', () => ({ buildTeamsLoginUrl: () => 'https://login' }));
mock.module('../channels/teams/fresh-start', () => ({
  startFreshTeamsConversation: async () => ({ reset: false, notice: '' }),
  messageAfterFreshStart: () => '',
}));
mock.module('../channels/teams/session', () => ({ createOrJoinTeamsConversationSession: async () => {} }));
mock.module('../channels/teams/binding', () => ({
  conversationSession: async () => null,
  ensureTeamsConversationBinding: async () => true,
  listTenantProjects: async () => [
    { projectId: PROJECT, name: 'First' },
    { projectId: OTHER, name: 'Second' },
  ],
  resolveConversationProject: async () => PROJECT,
  // The binding write before core/settings.ts owned it; kept so the same
  // assertions hold against either shape.
  setConversationProject: async (input: unknown) => {
    inserts.push(input);
    return true;
  },
  teamsChannelCtx: (tenantId: string, conversationId: string) => ({ platform: 'teams', teamId: tenantId, channelId: conversationId }),
}));
mock.module('../projects/review-items', () => ({ getReviewItemById: async () => null, applyVerdict: async () => {} }));

const posted: string[] = [];
mock.module('../channels/teams-api', () => ({
  sendCard: async (_ref: unknown, card: Record<string, unknown>) => {
    posted.push(JSON.stringify(card));
    return 'card-1';
  },
  updateCard: async () => true,
}));

const { handleTeamsCommand, parseTeamsCommand } = await import('../channels/teams/commands');
const { handleAdaptiveCardAction } = await import('../channels/teams/interactivity');

const message = (text: string) => ({
  type: 'message',
  id: 'act-1',
  text,
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
  conversation: { id: CONVO, tenantId: TENANT, conversationType: 'channel' },
  from: { id: '29:abc', aadObjectId: 'aad-user-1', name: 'Someone' },
  recipient: { id: '28:bot' },
});
const run = (text: string) =>
  handleTeamsCommand({ command: parseTeamsCommand(text)!, activity: message(text) as never, tenantId: TENANT, projectId: PROJECT });
const press = async (verb: string, data: Record<string, unknown>) =>
  JSON.stringify(
    (
      await handleAdaptiveCardAction({
        type: 'invoke',
        id: 'act-2',
        conversation: { id: CONVO, tenantId: TENANT },
        from: { id: '29:abc', aadObjectId: 'aad-user-1' },
        value: { action: { verb, data } },
      } as never)
    ).value,
  );

beforeEach(() => {
  dbResults = [];
  inserts.length = 0;
  writes.length = 0;
  posted.length = 0;
  actorChecks.length = 0;
  settingsActor = { userId: 'user-1' };
});

afterAll(() => mock.restore());

describe('Teams setting commands need a linked project manager', () => {
  test('a member without the capability cannot change the model, agent or policy; nothing is written', async () => {
    settingsActor = { reason: 'not_member' };
    await run('/model default');
    await run('/agent reviewer');
    await run('/policy owner');
    expect(writes).toEqual([]);
    expect(posted.every((c) => c.includes('Only a project manager'))).toBe(true);
    expect(actorChecks.every((c) => c.action === 'project.connector.write' && c.projectId === PROJECT)).toBe(true);
  });

  test('an unlinked sender is asked to connect first; nothing is written', async () => {
    settingsActor = { reason: 'unlinked' };
    await run('/model default');
    expect(writes).toEqual([]);
    expect(posted[0]).toContain('/login');
  });

  test('/use another project needs the capability on the bound project and the target; no binding is written', async () => {
    settingsActor = { reason: 'not_member' };
    await run('/use Second');
    expect(inserts).toEqual([]);
    expect(posted[0]).toContain('Only a project manager');
  });

  test('a project manager changes the model, agent, policy and project', async () => {
    dbResults = [[{ id: 'install-2' }]]; // `/use Second`: the target is installed
    await run('/model default');
    await run('/agent reviewer');
    await run('/policy owner');
    await run('/use Second');
    expect(writes).toEqual([
      { kind: 'model', value: null },
      { kind: 'agent', value: 'reviewer' },
      { kind: 'policy', value: 'owner_only' },
    ]);
    expect(inserts).toEqual([{ platform: 'teams', workspaceId: TENANT, channelId: CONVO, projectId: OTHER, pickerTs: null }]);
    expect(actorChecks.map((c) => c.projectId)).toEqual([PROJECT, PROJECT, PROJECT, PROJECT, OTHER]);
  });
});

describe('Teams setting cards need a linked project manager', () => {
  test('model, agent and project picks from a member without the capability change nothing', async () => {
    settingsActor = { reason: 'not_member' };
    expect(await press('teams_set_model', { model: 'kortix/glm-5.3-flash' })).toContain('Only a project manager');
    expect(await press('teams_set_agent', { agent: 'reviewer' })).toContain('Only a project manager');
    expect(await press('teams_pick_project', { projectId: OTHER })).toContain('Only a project manager');
    expect(writes).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('a project manager applies a model pick', async () => {
    expect(await press('teams_set_model', { model: 'kortix/glm-5.3-flash' })).toContain('Model set to');
    expect(writes).toEqual([{ kind: 'model', value: 'kortix/glm-5.3-flash' }]);
  });
});
