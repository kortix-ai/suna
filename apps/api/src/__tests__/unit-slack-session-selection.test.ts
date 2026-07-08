import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import type { ProjectSessionRow } from '../projects/lib/serializers';

// Guarantee: a Slack-started session inherits the bound channel's agent + model
// overrides (set via `/kortix agents` / `/kortix models`). Before this, every
// Slack session was hardcoded to agent 'default' with no model.

let dbResults: unknown[][] = [];
function fakeSessionRow(sessionId: string): ProjectSessionRow {
  const now = new Date('2026-01-01T00:00:00Z');
  return {
    sessionId,
    accountId: 'acc-1',
    projectId: 'proj-1',
    branchName: 'session/test',
    baseRef: 'main',
    sandboxProvider: 'daytona',
    sandboxId: null,
    sandboxUrl: null,
    opencodeSessionId: null,
    agentName: 'default',
    status: 'queued',
    error: null,
    createdBy: 'user-1',
    visibility: 'project',
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
}

function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'set', 'values', 'onConflictDoUpdate', 'onConflictDoNothing', 'returning']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../shared/db', () => ({
  db: { select: () => makeChain(), insert: () => makeChain(), update: () => makeChain(), delete: () => makeChain() },
  hasDatabase: () => true,
}));
mock.module('../projects/session-lifecycle', () => ({
  continueSession: async () => 'delivered',
  createSession: async (input: { body: Record<string, unknown> }) => {
    lastBody = input.body;
    return { status: 'created', sessionId: 'new-sess', row: fakeSessionRow('new-sess') };
  },
  resolveProjectAutomationActor: async () => 'user-1',
}));

// Capture the body createProjectSession is called with.
let lastBody: Record<string, unknown> | null = null;

// The channel's selection — what we assert flows into the session body.
let selection: unknown = null;
mock.module('../channels/slack/selection', () => ({
  currentChannelSelection: async () => selection,
  // session.ts only uses currentChannelSelection; the rest are here so the
  // module shape stays complete for any other importer in the graph.
  setChannelAgent: async () => ({ ok: true }),
  setChannelConversationPolicy: async () => true,
  setChannelModel: async () => true,
  listProjectAgents: async () => [],
  RECOMMENDED_MODELS: [
    { id: 'anthropic/claude-opus-4-8', label: 'Claude Opus 4.8', hint: 'Most capable' },
  ],
  isValidModelId: (id: string) => id.includes('/'),
  modelLabel: (id: string) => id,
}));

const realIam = await import('../iam');
mock.module('../iam', () => ({
  ...realIam,
  authorize: async () => ({ allowed: true }),
  assertAuthorized: async () => {},
  filterAccessibleProjectResources: async (
    _userId: string,
    _accountId: string,
    _projectId: string,
    _resourceType: string,
    resourceIds: readonly string[],
  ) => [...resourceIds],
  unscopedResourceIds: async (_projectId: string, _resourceType: string, resourceIds: readonly string[]) => [...resourceIds],
}));

mock.module('../channels/slack/turn', () => ({
  claimFinalize: async () => true,
  openPlanMessage: async () => true,
  repaintLivePlan: async () => {},
  loadTurn: async () => null,
  startTurn: async () => ({ sessionId: '', channel: 'C1', token: 'xoxb', ts: '', steps: [] }),
  saveTurn: async () => {},
  deleteTurn: async () => {},
  finalizeTurn: async () => {},
  buildSlackTurnEnv: () => ({}),
  relayTurnAnswer: async () => {},
  relayTurnEnd: async () => {},
  relayTurnStep: async () => {},
  rowToHandle: () => ({ sessionId: '', channel: 'C1', token: 'xoxb', ts: '', steps: [] }),
}));
mock.module('../channels/install-store', () => ({
  SLACK_BOT_TOKEN: 'SLACK_BOT_TOKEN',
  SLACK_SIGNING_SECRET: 'SLACK_SIGNING_SECRET',
  SLACK_TEAM_ID: 'SLACK_TEAM_ID',
  SLACK_BOT_USER_ID: 'SLACK_BOT_USER_ID',
  SLACK_TEAM_NAME: 'SLACK_TEAM_NAME',
  TELEGRAM_BOT_TOKEN: 'TELEGRAM_BOT_TOKEN',
  TELEGRAM_WEBHOOK_SECRET: 'TELEGRAM_WEBHOOK_SECRET',
  deleteSlackInstall: async () => {},
  listProjectsForWorkspace: async () => ['proj-1'],
  loadSlackInstall: async () => null,
  loadSlackBotUserIdForProject: async () => 'B1',
  loadSlackSigningSecretForProject: async () => null,
  loadSlackTeamNameForProject: async () => null,
  loadSlackTokenForProject: async () => 'xoxb-test',
  loadTelegramWebhookSecretForProject: async () => null,
  saveSlackInstall: async () => ({ workspaceId: 'T1', workspaceName: 'Test', botUserId: 'B1', installedAt: new Date().toISOString() }),
  saveSlackOauthInstall: async () => ({ workspaceId: 'T1', workspaceName: 'Test', botUserId: 'B1', installedAt: new Date().toISOString() }),
}));
mock.module('../channels/slack-api', () => ({
  addReaction: async () => {},
  appendStream: async () => {},
  deleteMessage: async () => {},
  getChannelName: async () => 'general',
  joinChannel: async () => true,
  openDmChannel: async () => 'D1',
  postBlocks: async () => 'ts',
  postEphemeral: async () => true,
  postMessage: async () => 'ts',
  publishHomeView: async () => {},
  removeReaction: async () => {},
  startStream: async () => 'ts',
  stopStream: async () => {},
  updateBlocks: async () => {},
  updateMessage: async () => {},
}));

const { spawnAgentTurn } = await import('../channels/slack/dispatch');
const { config } = await import('../config');
const { resetSlackSessionLifecycleForTest, setSlackSessionLifecycleForTest } = await import('../channels/slack/session');
const originalRequireIdentity = config.SLACK_REQUIRE_USER_IDENTITY;

const project = { projectId: 'proj-1', accountId: 'acc-1', defaultBranch: 'main', repoUrl: 'r', name: 'P', manifestPath: 'kortix.yaml' };
const envelope = { team_id: 'T1', event: undefined } as any;
const event = { type: 'app_mention', channel: 'C1', ts: '100.1', user: 'U1', thread_ts: '90.0', text: 'hi' } as any;

afterAll(() => {
  config.SLACK_REQUIRE_USER_IDENTITY = originalRequireIdentity;
  resetSlackSessionLifecycleForTest();
  mock.restore();
});

// Brand-new thread, claim won → createProjectSession runs exactly once.
function newThreadFifo() {
  dbResults = [
    [project], // spawnAgentTurn project lookup
    [], // chat_threads lookup → brand-new thread
    [project], // projects lookup
    [{ eventId: 'claim' }], // claimThreadCreate → WON
    [], // re-check chat_threads → none
    [], // chat_threads insert
  ];
}

beforeEach(() => {
  config.SLACK_REQUIRE_USER_IDENTITY = false;
  lastBody = null;
  selection = null;
  setSlackSessionLifecycleForTest({
    continueSession: async () => 'delivered',
    createSession: async (input: { body: Record<string, unknown> }) => {
      lastBody = input.body;
      return { status: 'created', sessionId: 'new-sess', row: fakeSessionRow('new-sess') };
    },
    resolveProjectAutomationActor: async () => 'user-1',
  });
});

test('channel agent + model override flow into the session body', async () => {
  selection = { projectId: 'proj-1', agentName: 'reviewer', opencodeModel: 'anthropic/claude-opus-4-8' };
  newThreadFifo();
  await spawnAgentTurn('proj-1', envelope, event);
  expect(lastBody?.agent_name).toBe('reviewer');
  expect(lastBody?.opencode_model).toBe('anthropic/claude-opus-4-8');
});

test('no overrides → agent "default" and NO opencode_model key', async () => {
  selection = { projectId: 'proj-1', agentName: null, opencodeModel: null };
  newThreadFifo();
  await spawnAgentTurn('proj-1', envelope, event);
  expect(lastBody?.agent_name).toBe('default');
  expect('opencode_model' in (lastBody ?? {})).toBe(false);
});

test('unbound channel (null selection) → agent "default", no model', async () => {
  selection = null;
  newThreadFifo();
  await spawnAgentTurn('proj-1', envelope, event);
  expect(lastBody?.agent_name).toBe('default');
  expect('opencode_model' in (lastBody ?? {})).toBe(false);
});
