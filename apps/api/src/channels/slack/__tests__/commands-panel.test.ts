import { beforeEach, describe, expect, mock, test } from 'bun:test';

// The consolidated `/kortix` panel + the real-catalog model picker + the
// servability gate (a stored model can never 404). Heavy deps are mocked; the
// pure resolver module (effective.ts) is used for real.

process.env.SLACK_REQUIRE_USER_IDENTITY = 'false';

mock.module('../../../config', () => ({
  config: { FRONTEND_URL: 'https://app.test', SLACK_REQUIRE_USER_IDENTITY: false },
}));

// FIFO db mock — slashPanel reads one project row.
let dbResults: Array<unknown[]> = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['select', 'from', 'where', 'limit', 'leftJoin', 'orderBy']) chain[m] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../../../shared/db', () => ({ db: { select: () => makeChain() }, hasDatabase: () => true }));

let selection: any = { projectId: 'p1', agentName: null, opencodeModel: null, conversationPolicy: null };
mock.module('../selection', () => ({
  currentChannelSelection: async () => selection,
  isValidModelId: (s: string) => s.indexOf('/') > 0,
  listProjectAgents: async () => [],
  setChannelAgent: async () => true,
  setChannelConversationPolicy: async () => true,
  setChannelModel: mock(async () => true),
}));

let gate: any = { projectId: 'p1', accountId: 'a1', ownerUserId: 'u1', freeManagedOnly: false };
mock.module('../model-gate', () => ({ channelModelContext: async () => gate }));

mock.module('../../../llm-gateway/models/picker', () => ({
  listPickerModels: async () => ({
    models: [
      { id: 'kortix/glm-5.2', label: 'GLM 5.2', provider: 'kortix', managed: true, hint: 'Balanced, fast' },
      { id: 'kortix/claude-opus-4.8', label: 'Claude Opus 4.8', provider: 'kortix', managed: true, hint: 'Most capable' },
    ],
    projectDefault: { model: 'glm-5.2', source: 'platform', label: 'GLM 5.2' },
  }),
  labelForModelRef: (ref: string) => (ref.includes('glm') ? 'GLM 5.2' : ref),
}));

let servable = true;
mock.module('../../../llm-gateway/resolution/default-model', () => ({
  isModelServableForAccount: async () => servable,
  resolveEffectiveModel: async () => ({ model: 'glm-5.2', source: 'project' }),
}));

mock.module('../participants', () => ({
  conversationPolicyLabel: () => 'Owner approval',
  normalizeConversationPolicy: () => 'owner_approval',
}));
mock.module('../identity', () => ({
  lookupSlackIdentity: async () => null,
  revokeSlackIdentity: async () => true,
}));
mock.module('../../../accounts/core/app', () => ({ lookupEmailsByUserIds: async () => new Map() }));

const { handleSlashCommand } = await import('../commands');
const { setChannelModel } = (await import('../selection')) as any;

const ctx = { teamId: 'T1', channelId: 'C1', slackUserId: 'U1', command: '/kortix' };

function actionIds(resp: any): string[] {
  const ids: string[] = [];
  for (const b of resp.blocks ?? []) {
    if (b.accessory?.action_id) ids.push(b.accessory.action_id);
    for (const el of b.elements ?? []) if (el.action_id) ids.push(el.action_id);
  }
  return ids;
}

beforeEach(() => {
  dbResults = [];
  selection = { projectId: 'p1', agentName: null, opencodeModel: null, conversationPolicy: null };
  gate = { projectId: 'p1', accountId: 'a1', ownerUserId: 'u1', freeManagedOnly: false };
  servable = true;
  setChannelModel.mockClear();
});

describe('bare /kortix → channel panel', () => {
  test('renders the project + inline change buttons (one command for everything)', async () => {
    dbResults = [[{ projectId: 'p1', name: 'acme/api', repoUrl: 'https://github.com/acme/api', metadata: {} }]];
    const resp = await handleSlashCommand('', '', ctx);
    const ids = actionIds(resp);
    expect(ids).toContain('cfg_open_models');
    expect(ids).toContain('cfg_open_agents');
    expect(ids).toContain('cfg_open_projects');
    // honest effective-model + source line
    expect(JSON.stringify(resp.blocks)).toContain('project default');
  });

  test('unconnected channel → a Connect button, not a "type switch" instruction', async () => {
    selection = null;
    const resp = await handleSlashCommand('config', '', ctx);
    expect(actionIds(resp)).toContain('cfg_open_projects');
  });
});

describe('/kortix models → real served catalog', () => {
  test('lists the picker models as set_model_<ref> buttons + a project-default reset', async () => {
    const resp = await handleSlashCommand('models', '', ctx);
    const ids = actionIds(resp);
    expect(ids).toContain('set_model_default');
    expect(ids).toContain('set_model_kortix/glm-5.2');
    expect(ids).toContain('set_model_kortix/claude-opus-4.8');
  });
});

describe('/kortix model <id> → servability gate (never store a 404)', () => {
  test('servable id is stored as the opencode ref', async () => {
    const resp = await handleSlashCommand('model', 'glm-5.2', ctx);
    expect(setChannelModel).toHaveBeenCalledWith(expect.anything(), 'kortix/glm-5.2');
    expect(resp.text).toContain('set to');
  });

  test('unservable id is REJECTED — never written', async () => {
    servable = false;
    const resp = await handleSlashCommand('model', 'anthropic/claude-sonnet-4.6', ctx);
    expect(setChannelModel).not.toHaveBeenCalled();
    expect(resp.text).toContain("isn't available");
  });

  test('`default` clears the override', async () => {
    const resp = await handleSlashCommand('model', 'default', ctx);
    expect(setChannelModel).toHaveBeenCalledWith(expect.anything(), null);
    expect(resp.text).toContain('reset to the project default');
  });
});
