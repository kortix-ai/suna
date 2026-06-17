import { beforeEach, expect, mock, test } from 'bun:test';

// Guarantee: a Slack-started session inherits the bound channel's agent + model
// overrides (set via `/kortix agents` / `/kortix models`). Before this, every
// Slack session was hardcoded to agent 'default' with no model.

let dbResults: unknown[][] = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'set', 'values', 'onConflictDoUpdate', 'onConflictDoNothing', 'returning']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../shared/db', () => ({
  db: { select: () => makeChain(), insert: () => makeChain(), update: () => makeChain(), delete: () => makeChain() },
  hasDatabase: () => true,
}));

// Capture the body createProjectSession is called with.
let lastBody: Record<string, unknown> | null = null;
mock.module('../projects', () => ({
  createProjectSession: async (input: { body: Record<string, unknown> }) => {
    lastBody = input.body;
    return { row: { sessionId: 'new-sess' } };
  },
  resolveGitTriggerActor: async () => 'user-1',
}));

// The channel's selection — what we assert flows into the session body.
let selection: unknown = null;
mock.module('../channels/slack/selection', () => ({
  currentChannelSelection: async () => selection,
  // session.ts only uses currentChannelSelection; the rest are here so the
  // module shape stays complete for any other importer in the graph.
  setChannelAgent: async () => true,
  setChannelModel: async () => true,
  modelLabel: (id: string) => id,
}));

mock.module('../projects/session-delivery', () => ({ deliverPromptToSession: async () => 'delivered' }));
mock.module('../channels/slack/turn', () => ({
  loadTurn: async () => null,
  startTurn: async () => ({ sessionId: '', channel: 'C1', token: 'xoxb', ts: '', steps: [] }),
  saveTurn: async () => {},
  deleteTurn: async () => {},
  finalizeTurn: async () => {},
  buildSlackTurnEnv: () => ({}),
}));
mock.module('../channels/install-store', () => ({
  loadSlackBotUserIdForProject: async () => 'B1',
  loadSlackTokenForProject: async () => 'xoxb-test',
  saveSlackOauthInstall: async () => {},
}));
mock.module('../channels/slack-api', () => ({
  deleteMessage: async () => {},
  getChannelName: async () => 'general',
  postBlocks: async () => 'ts',
  postMessage: async () => 'ts',
}));

const { spawnAgentTurn } = await import('../channels/slack/dispatch');

const project = { projectId: 'proj-1', accountId: 'acc-1', defaultBranch: 'main', repoUrl: 'r', name: 'P', manifestPath: 'kortix.toml' };
const envelope = { team_id: 'T1', event: undefined } as any;
const event = { type: 'app_mention', channel: 'C1', ts: '100.1', user: 'U1', thread_ts: '90.0', text: 'hi' } as any;

// Brand-new thread, claim won → createProjectSession runs exactly once.
function newThreadFifo() {
  dbResults = [
    [], // chat_threads lookup → brand-new thread
    [project], // projects lookup
    [{ eventId: 'claim' }], // claimThreadCreate → WON
    [], // re-check chat_threads → none
    [], // chat_threads insert
  ];
}

beforeEach(() => {
  lastBody = null;
  selection = null;
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
