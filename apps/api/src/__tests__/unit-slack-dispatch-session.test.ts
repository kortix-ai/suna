import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Persist the headline invariant of the Slack channel refactor: a known thread
// maps PERMANENTLY to exactly one session. A follow-up routes into that session
// and must NEVER create a second one — the only path that creates a session for
// a known thread is when the session was genuinely deleted (`no-session`), and
// that is a replacement, not a duplicate. This is the regression guard for the
// "two replies, one from a session you can never find" bug.

// ─── DB mock: FIFO of query results (same pattern as unit-slack-streams) ──────
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

// ─── Session-delivery: the outcome under test ─────────────────────────────────
let deliverOutcome = 'delivered';
let deliverCalls = 0;
mock.module('../projects/session-delivery', () => ({
  deliverPromptToSession: async () => {
    deliverCalls++;
    return deliverOutcome;
  },
}));

// ─── projects barrel: spy on createProjectSession (the "second session") ──────
let createSessionCalls = 0;
mock.module('../projects', () => ({
  createProjectSession: async () => {
    createSessionCalls++;
    return { row: { sessionId: 'replacement-sess' } };
  },
  resolveGitTriggerActor: async () => 'user-1',
}));

// ─── streams: fakes so spawnAgentTurn touches no real Slack/DB here ───────────
let finalizeCalls: Array<{ error?: string; answer?: string }> = [];
mock.module('../channels/slack/turn', () => ({
  loadTurn: async () => null, // no in-flight turn → we open our own stream
  startTurn: async () => ({ sessionId: '', channel: 'C1', token: 'xoxb', ts: '', steps: [] }),
  saveTurn: async () => {},
  deleteTurn: async () => {},
  finalizeTurn: async (_h: unknown, opts: { error?: string; answer?: string }) => {
    finalizeCalls.push(opts);
  },
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

const envelope = { team_id: 'T1', event: undefined } as any;
const event = { type: 'app_mention', channel: 'C1', ts: '100.1', user: 'U1', thread_ts: '90.0', text: 'hi' } as any;

beforeEach(() => {
  dbResults = [];
  finalizeCalls = [];
  createSessionCalls = 0;
  deliverCalls = 0;
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
