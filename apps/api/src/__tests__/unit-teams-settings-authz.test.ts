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
let deletes = 0;
function chain(): any {
  const c: any = {};
  for (const m of ['from', 'where', 'limit']) c[m] = () => c;
  c.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return c;
}
mock.module('../shared/db', () => ({
  db: {
    select: () => chain(),
    delete: () => ({
      where: async () => {
        deletes += 1;
        return [];
      },
    }),
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
  projectModelContext: async () => null,
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
const realDefaultModel = await import('../llm-gateway/resolution/default-model');
mock.module('../llm-gateway/resolution/default-model', () => ({ ...realDefaultModel, isModelServableForAccount: async () => true }));
mock.module('../projects/lib/access', () => ({ lookupEmailsByUserIds: async () => new Map() }));
mock.module('../channels/teams/agent-picker', () => ({ buildAgentsPicker: async () => ({ type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: 'AGENTS-PICKER' }] }) }));
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
mock.module('../feature-flags/for-project', () => ({ projectFeatureFlagEnabled: async () => true }));

const realModelChoice = await import('../channels/teams/model-choice');
mock.module('../channels/teams/model-choice', () => ({
  ...realModelChoice,
  buildTeamsModelsCard: async () => ({ type: 'AdaptiveCard', body: [{ type: 'TextBlock', text: 'MODELS-PICKER' }] }),
}));

let recentSessions: unknown[] | null = [];
const sessionQueries: unknown[] = [];
mock.module('../channels/core/sessions', () => ({
  listVisibleChatSessions: async (user: unknown, opts: unknown) => {
    sessionQueries.push({ user, opts });
    return recentSessions;
  },
}));

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
  deletes = 0;
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
    await run('/model default');
    await run('/agent reviewer');
    await run('/policy owner');
    dbResults = [[{ id: 'install-2' }]]; // `/use Second`: the target is installed
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
    expect(writes).toEqual([{ kind: 'model', value: 'glm-5.3-flash' }]);
  });
});

// Slack's settings panel changes what it shows; Teams' `/status` only showed
// it (2026-09-29 parity audit). Its buttons open the same pickers the
// commands post, and go through the same settings gate when a pick is made.
describe('/status and /sessions', () => {
  test('/status shows the policy and who you are, with buttons that open each picker', async () => {
    await run('/status');
    const card = JSON.parse(posted[0]!);
    const facts = JSON.stringify(card.body);
    expect(facts).toContain('Policy');
    expect(facts).toContain('not connected — run /login');
    expect(card.actions.map((a: { title: string; data?: { panel?: string } }) => [a.title, a.data?.panel ?? null])).toEqual([
      ['Change model', 'models'],
      ['Change agent', 'agents'],
      ['Switch project', 'projects'],
      ['Open in Kortix', null],
    ]);
  });

  test('a /status button returns its picker to the presser', async () => {
    expect(await press('teams_open_panel', { panel: 'projects' })).toContain('Connected projects');
    expect(await press('teams_open_panel', { panel: 'models' })).toContain('MODELS-PICKER');
    expect(await press('teams_open_panel', { panel: 'agents' })).toContain('AGENTS-PICKER');
    expect(await press('teams_open_panel', { panel: 'nope' })).toContain("isn't available anymore");
    // Opening a picker changes nothing.
    expect(writes).toEqual([]);
    expect(inserts).toEqual([]);
  });

  test('/sessions lists the recent sessions this person may open, each linking to Kortix', async () => {
    sessionQueries.length = 0;
    recentSessions = [
      { projectId: PROJECT, projectName: 'First', repoUrl: '', sessionId: 'sess-1', lastMessageAt: new Date(), title: 'Fix the flaky test', status: 'completed' },
      { projectId: PROJECT, projectName: 'First', repoUrl: '', sessionId: 'sess-2', lastMessageAt: new Date(), title: null, status: 'running' },
    ];
    await run('/sessions');
    expect(posted[0]).toContain('Recent sessions');
    expect(posted[0]).toContain('Fix the flaky test');
    expect(posted[0]).toContain('First · done');
    expect(posted[0]).toContain('Untitled session');
    expect(posted[0]).toContain('https://dev.kortix.com/projects/proj-1/sessions/sess-1');
    expect(sessionQueries).toEqual([{ user: expect.objectContaining({ platform: 'teams', workspaceId: TENANT }), opts: { limit: 5, projectId: undefined } }]);
  });

  test('/sessions asks an unlinked person to connect, and says so when there is nothing yet', async () => {
    recentSessions = null;
    await run('/sessions');
    expect(posted[0]).toContain('/login');
    recentSessions = [];
    await run('/sessions');
    expect(posted[1]).toContain('No recent sessions');
  });
});

// Slack parity, part 2: `/unbind`, `/home`, and `/projects` with previews.
describe('/unbind, /home and /projects', () => {
  test('a project manager unbinds the conversation; the next message picks a project again', async () => {
    await run('/unbind');
    expect(deletes).toBe(1);
    expect(posted[0]).toContain('Unbound');
    expect(actorChecks).toEqual([{ projectId: PROJECT, action: 'project.connector.write' }]);
  });

  test('a member without the capability cannot unbind; nothing is removed', async () => {
    settingsActor = { reason: 'not_member' };
    await run('/unbind');
    expect(deletes).toBe(0);
    expect(posted[0]).toContain('Only a project manager');
  });

  test('a per-project bot has nothing to unbind', async () => {
    await handleTeamsCommand({ command: parseTeamsCommand('/unbind')!, activity: message('/unbind') as never, tenantId: TENANT, projectId: PROJECT, projectScoped: true });
    expect(deletes).toBe(0);
    expect(posted[0]).toContain('nothing to unbind');
  });

  test('a per-project bot never binds the conversation to another project', async () => {
    // `/use` there bound the conversation elsewhere; the bot then declined it
    // for good, and `/unbind` (above) is refused on a per-project bot.
    for (const text of ['/use Second', '/switch Second', '/projects']) {
      await handleTeamsCommand({ command: parseTeamsCommand(text)!, activity: message(text) as never, tenantId: TENANT, projectId: PROJECT, projectScoped: true });
    }
    expect(inserts).toEqual([]);
    expect(actorChecks).toEqual([]);
    expect(posted).toHaveLength(3);
    for (const card of posted) expect(card).toContain('always runs its own project');
  });

  test('/projects lists each project with Open and Use, the current one marked', async () => {
    await run('/projects');
    const card = posted[0]!;
    expect(card).toContain('Connected projects');
    expect(card).toContain('"title":"✓ In use"');
    expect(card).toContain(`"projectId":"${OTHER}"`);
    expect(card).toContain('https://dev.kortix.com/projects/proj-2');
  });

  test('/home lists the organization\'s projects and what to try', async () => {
    await run('/home');
    expect(posted[0]).toContain('Projects in this organization');
    expect(posted[0]).toContain('First');
    expect(posted[0]).toContain('Second');
  });
});
