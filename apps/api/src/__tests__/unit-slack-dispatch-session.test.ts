import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ProjectSessionRow } from '../projects/lib/serializers';
import type { SessionDeliveryOutcome } from '../projects/session-lifecycle';

// Persist the headline invariant of the Slack channel refactor: a known thread
// maps PERMANENTLY to exactly one session. A follow-up routes into that session
// and must NEVER create a second one — the only path that creates a session for
// a known thread is when the session was genuinely deleted (`no-session`), and
// that is a replacement, not a duplicate. This is the regression guard for the
// "two replies, one from a session you can never find" bug.

// ─── DB mock: FIFO of query results (same pattern as unit-slack-streams) ──────
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

// ─── Lifecycle delivery: the outcome under test ───────────────────────────────
let deliverOutcome: SessionDeliveryOutcome = 'delivered';
let deliverCalls = 0;

// ─── lifecycle seam: spy on createSession (the "second session") ─────────────
let createSessionCalls = 0;

// ─── streams: fakes so spawnAgentTurn touches no real Slack/DB here ───────────
let finalizeCalls: Array<{ error?: string; answer?: string }> = [];
mock.module('../channels/slack/turn', () => ({
  claimFinalize: async () => true,
  openPlanMessage: async () => true,
  repaintLivePlan: async () => {},
  loadTurn: async () => null, // no in-flight turn → we open our own stream
  startTurn: async () => ({ sessionId: '', channel: 'C1', token: 'xoxb', ts: '', steps: [] }),
  saveTurn: async () => {},
  deleteTurn: async () => {},
  finalizeTurn: async (_h: unknown, opts: { error?: string; answer?: string }) => {
    finalizeCalls.push(opts);
  },
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
  postBlocks: async () => 'ts',
  postMessage: async () => 'ts',
  publishHomeView: async () => {},
  removeReaction: async () => {},
  startStream: async () => 'ts',
  stopStream: async () => {},
  updateBlocks: async () => {},
  updateMessage: async () => {},
}));

const { spawnAgentTurn } = await import('../channels/slack/dispatch');
const { resetSlackSessionLifecycleForTest, setSlackSessionLifecycleForTest } = await import('../channels/slack/session');

const envelope = { team_id: 'T1', event: undefined } as any;
const event = { type: 'app_mention', channel: 'C1', ts: '100.1', user: 'U1', thread_ts: '90.0', text: 'hi' } as any;

afterAll(() => {
  resetSlackSessionLifecycleForTest();
  mock.restore();
});

beforeEach(() => {
  dbResults = [];
  finalizeCalls = [];
  createSessionCalls = 0;
  deliverCalls = 0;
  setSlackSessionLifecycleForTest({
    continueSession: async () => {
      deliverCalls++;
      return deliverOutcome;
    },
    createSession: async () => {
      createSessionCalls++;
      return { status: 'created', sessionId: 'replacement-sess', row: fakeSessionRow('replacement-sess') };
    },
    resolveProjectAutomationActor: async () => 'user-1',
  });
});

describe('spawnAgentTurn — permanent 1:1 thread↔session, never a second session', () => {
  test('delivered → routes into the existing session, no new session', async () => {
    deliverOutcome = 'delivered';
    dbResults = [[{ sessionId: 'sess-1' }]]; // chat_threads lookup → known thread
    await spawnAgentTurn('proj-1', envelope, event);
    expect(deliverCalls).toBe(1);
    expect(createSessionCalls).toBe(0);
  });

  test('pending (session waking) → keep mapping, NEVER recreate', async () => {
    deliverOutcome = 'pending';
    dbResults = [[{ sessionId: 'sess-1' }]];
    await spawnAgentTurn('proj-1', envelope, event);
    expect(createSessionCalls).toBe(0);
    expect(finalizeCalls.at(-1)?.error).toContain('waking');
  });

  test('failed (genuine error) → surface it, keep mapping, NEVER recreate', async () => {
    deliverOutcome = 'failed';
    dbResults = [[{ sessionId: 'sess-1' }]];
    await spawnAgentTurn('proj-1', envelope, event);
    expect(createSessionCalls).toBe(0);
    expect(finalizeCalls.at(-1)?.error).toContain('error');
  });

  test('no-session (session deleted) → replace it (the ONLY create path for a known thread)', async () => {
    deliverOutcome = 'no-session';
    dbResults = [
      [{ sessionId: 'sess-1' }], // chat_threads lookup (known thread)
      [], // delete the stale chat_threads mapping
      [{ projectId: 'proj-1', accountId: 'acc-1', defaultBranch: 'main', repoUrl: 'r', name: 'P', manifestPath: 'kortix.toml' }], // projects lookup
      [{ eventId: 'claim' }], // claimThreadCreate → WON
      [], // re-check chat_threads → none
      [], // chat_threads insert (onConflictDoNothing)
    ];
    await spawnAgentTurn('proj-1', envelope, event);
    expect(createSessionCalls).toBe(1);
  });
});

// The atomic thread-create claim is what makes the "shadow session" impossible:
// two near-simultaneous first messages for the SAME new thread can no longer each
// spin up a session. Exactly one handler wins the claim and creates; the rest
// join that session as a follow-up.
describe('createOrJoinThreadSession — atomic claim arbitrates a brand-new thread', () => {
  const project = { projectId: 'proj-1', accountId: 'acc-1', defaultBranch: 'main', repoUrl: 'r', name: 'P', manifestPath: 'kortix.toml' };

  test('claim WON, no existing mapping → creates EXACTLY one session, no follow-up', async () => {
    dbResults = [
      [], // chat_threads lookup → brand-new thread
      [project], // projects lookup
      [{ eventId: 'claim' }], // claimThreadCreate → WON (a row came back)
      [], // re-check chat_threads → still none
      [], // chat_threads insert
    ];
    await spawnAgentTurn('proj-1', envelope, event);
    expect(createSessionCalls).toBe(1);
    expect(deliverCalls).toBe(0); // the winner creates with the initial prompt; no follow-up
  });

  test('claim LOST → joins the winner’s session as a follow-up, NEVER creates a second', async () => {
    dbResults = [
      [], // chat_threads lookup → brand-new thread
      [project], // projects lookup
      [], // claimThreadCreate → LOST (no row; someone else is creating)
      [{ sessionId: 'winner-sess' }], // waitForThreadSession → winner published its mapping
    ];
    await spawnAgentTurn('proj-1', envelope, event);
    expect(createSessionCalls).toBe(0); // never a shadow session
    expect(deliverCalls).toBe(1); // delivered into the winner's session as a follow-up
  });
});
