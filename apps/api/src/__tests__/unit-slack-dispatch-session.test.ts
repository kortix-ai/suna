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
let authorizeAllowed = true;
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
    folderId: null,
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
const realIam = await import('../iam');
mock.module('../iam', () => ({
  ...realIam,
  authorize: async () => ({ allowed: authorizeAllowed }),
  assertAuthorized: async () => {},
  filterAccessibleProjectResources: async (_u: string, _a: string, _p: string, _t: string, ids: readonly string[]) => [...ids],
  unscopedResourceIds: async (_p: string, _t: string, ids: readonly string[]) => [...ids],
  hasAnyResourceGrants: async () => false,
}));

const realGit = await import('../projects/git');
mock.module('../projects/git', () => ({
  ...realGit,
  readRepoFile: async () => null,
}));

// ─── Lifecycle delivery: the outcome under test ───────────────────────────────
let deliverOutcome: SessionDeliveryOutcome = 'delivered';
let deliverCalls = 0;

// ─── lifecycle seam: spy on createSession (the "second session") ─────────────
let createSessionCalls = 0;
let createSessionInputs: any[] = [];
mock.module('../projects/session-lifecycle', () => ({
  continueSession: async () => {
    deliverCalls++;
    return deliverOutcome;
  },
  createSession: async (input: any) => {
    createSessionInputs.push(input);
    createSessionCalls++;
    return { status: 'created', sessionId: 'replacement-sess', row: fakeSessionRow('replacement-sess') };
  },
  resolveProjectAutomationActor: async () => 'user-1',
}));

// ─── streams: fakes so spawnAgentTurn touches no real Slack/DB here ───────────
let finalizeCalls: Array<{ error?: string; answer?: string }> = [];
let ephemerals: Array<{ channel: string; user: string; text: string; threadTs?: string }> = [];
let messages: Array<{ channel: string; text: string; threadTs?: string }> = [];
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
  openDmChannel: async () => 'D1',
  postBlocks: async () => 'ts',
  postEphemeral: async (_token: string, channel: string, user: string, text: string, _blocks?: unknown[], threadTs?: string) => {
    ephemerals.push({ channel, user, text, threadTs });
    return true;
  },
  postMessage: async (_token: string, channel: string, text: string, threadTs?: string) => {
    messages.push({ channel, text, threadTs });
    return 'ts';
  },
  publishHomeView: async () => {},
  removeReaction: async () => {},
  startStream: async () => 'ts',
  stopStream: async () => {},
  updateBlocks: async () => {},
  updateMessage: async () => {},
}));

const { spawnAgentTurn, dispatchSlackEvent } = await import('../channels/slack/dispatch');
const { config } = await import('../config');
const { inboundMessageKey } = await import('../channels/slack/dedup');
const { resetSlackSessionLifecycleForTest, setSlackSessionLifecycleForTest } = await import('../channels/slack/session');
const originalRequireIdentity = config.SLACK_REQUIRE_USER_IDENTITY;

const envelope = { team_id: 'T1', event: undefined } as any;
const event = { type: 'app_mention', channel: 'C1', ts: '100.1', user: 'U1', thread_ts: '90.0', text: 'hi' } as any;
const project = { projectId: 'proj-1', accountId: 'acc-1', defaultBranch: 'main', repoUrl: 'r', name: 'P', manifestPath: 'kortix.toml' };

afterAll(() => {
  config.SLACK_REQUIRE_USER_IDENTITY = originalRequireIdentity;
  resetSlackSessionLifecycleForTest();
  mock.restore();
});

beforeEach(() => {
  config.SLACK_REQUIRE_USER_IDENTITY = false;
  dbResults = [];
  authorizeAllowed = true;
  finalizeCalls = [];
  ephemerals = [];
  messages = [];
  createSessionCalls = 0;
  createSessionInputs = [];
  deliverCalls = 0;
  setSlackSessionLifecycleForTest({
    continueSession: async () => {
      deliverCalls++;
      return deliverOutcome;
    },
    createSession: async (input: any) => {
      createSessionInputs.push(input);
      createSessionCalls++;
      return { status: 'created', sessionId: 'replacement-sess', row: fakeSessionRow('replacement-sess') };
    },
    resolveProjectAutomationActor: async () => 'user-1',
  });
});

describe('Slack authorization matrix — project access and session visibility', () => {
  test('linked Slack user without project access gets request-access UX and no session starts', async () => {
    config.SLACK_REQUIRE_USER_IDENTITY = true;
    dbResults = [
      [project], // project account lookup
      [{ userId: 'outsider-user' }], // Slack identity exists
      [], // account membership miss -> not_member
    ];

    await spawnAgentTurn('proj-1', envelope, {
      type: 'app_mention',
      channel: 'C1',
      ts: '110.1',
      user: 'Uoutsider',
      text: '<@B1> show me secrets',
    } as any);

    expect(createSessionCalls).toBe(0);
    expect(deliverCalls).toBe(0);
    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0]).toMatchObject({
      channel: 'C1',
      user: 'Uoutsider',
      text: "You're connected, but don't have access to this project yet.",
    });
  });

  test('new Slack sessions default to project-wide sharing for linked project members', async () => {
    config.SLACK_REQUIRE_USER_IDENTITY = true;
    dbResults = [
      [project], // project account lookup
      [{ userId: 'user-1' }], // Slack identity exists
      [{ userId: 'user-1' }], // account membership hit
      [], // no existing chat thread
      [project], // createOrJoinThreadSession project lookup
      [{ eventId: 'claim' }], // claimThreadCreate won
      [], // re-check chat_threads -> none
      [], // channel selection -> default policy
      [], // remember owner participant
    ];

    await spawnAgentTurn('proj-1', envelope, {
      type: 'app_mention',
      channel: 'C1',
      ts: '120.1',
      user: 'U1',
      text: '<@B1> do the thing',
    } as any);

    expect(createSessionCalls).toBe(1);
    expect(createSessionInputs[0]?.visibility).toBe('project');
    expect(createSessionInputs[0]?.metadata?.slack?.conversation_policy).toBe('project_open');
  });

  test('manual owner-approval policy creates a restricted Slack session', async () => {
    config.SLACK_REQUIRE_USER_IDENTITY = true;
    dbResults = [
      [project], // project account lookup
      [{ userId: 'user-1' }], // Slack identity exists
      [{ userId: 'user-1' }], // account membership hit
      [], // no existing chat thread
      [project], // createOrJoinThreadSession project lookup
      [{ eventId: 'claim' }], // claimThreadCreate won
      [], // re-check chat_threads -> none
      [{ projectId: 'proj-1', agentName: null, opencodeModel: null, conversationPolicy: 'owner_approval' }],
      [], // remember owner participant
    ];

    await spawnAgentTurn('proj-1', envelope, {
      type: 'app_mention',
      channel: 'C1',
      ts: '130.1',
      user: 'U1',
      text: '<@B1> private task',
    } as any);

    expect(createSessionCalls).toBe(1);
    expect(createSessionInputs[0]?.visibility).toBe('restricted');
    expect(createSessionInputs[0]?.metadata?.slack?.conversation_policy).toBe('owner_approval');
  });

  test('private existing session blocks a linked project member until owner approval', async () => {
    config.SLACK_REQUIRE_USER_IDENTITY = true;
    deliverOutcome = 'delivered';
    dbResults = [
      [project], // project account lookup
      [{ userId: 'requester-user' }], // Slack identity exists
      [{ userId: 'requester-user' }], // account membership hit
      [{ sessionId: 'sess-private', createdBy: null, metadata: { slack: { conversation_policy: 'owner_approval' } } }],
      [], // channel selection
      [], // approvedParticipantExists -> no
      [], // loadParticipant -> none
      [{ participantId: 'pending-1' }], // insert pending participant
    ];

    await spawnAgentTurn('proj-1', envelope, {
      type: 'app_mention',
      channel: 'C1',
      ts: '140.1',
      thread_ts: '90.0',
      user: 'Urequester',
      text: '<@B1> let me in',
    } as any);

    expect(deliverCalls).toBe(0);
    expect(createSessionCalls).toBe(0);
    expect(ephemerals[0]?.user).toBe('Urequester');
    expect(ephemerals[0]?.text).toContain('approve access to this private thread');
  });
});

describe('spawnAgentTurn — unauthenticated Slack prompt placement', () => {
  test('top-level unauthenticated mention posts an in-channel ephemeral, not a thread reply', async () => {
    config.SLACK_REQUIRE_USER_IDENTITY = true;
    try {
      dbResults = [
        [project], // project account lookup
        [], // resolveSlackActor identity lookup → unlinked
      ];
      await spawnAgentTurn('proj-1', envelope, {
        type: 'app_mention',
        channel: 'C1',
        ts: '100.1',
        user: 'U1',
        text: '<@B1> works?',
      } as any);

      expect(createSessionCalls).toBe(0);
      expect(ephemerals).toHaveLength(1);
      expect(ephemerals[0]).toMatchObject({
        channel: 'C1',
        user: 'U1',
        text: 'Kortix needs a linked Kortix account to continue.',
      });
      expect(ephemerals[0].threadTs).toBeUndefined();
    } finally {
      config.SLACK_REQUIRE_USER_IDENTITY = false;
    }
  });

  test('threaded unauthenticated mention keeps the prompt in the existing thread', async () => {
    config.SLACK_REQUIRE_USER_IDENTITY = true;
    try {
      dbResults = [
        [project], // project account lookup
        [], // resolveSlackActor identity lookup → unlinked
      ];
      await spawnAgentTurn('proj-1', envelope, {
        type: 'app_mention',
        channel: 'C1',
        ts: '100.1',
        user: 'U1',
        thread_ts: '90.0',
        text: '<@B1> works?',
      } as any);

      expect(createSessionCalls).toBe(0);
      expect(ephemerals).toHaveLength(1);
      expect(ephemerals[0].threadTs).toBe('90.0');
    } finally {
      config.SLACK_REQUIRE_USER_IDENTITY = false;
    }
  });
});

describe('spawnAgentTurn — permanent 1:1 thread↔session, never a second session', () => {
  test('delivered → routes into the existing session, no new session', async () => {
    deliverOutcome = 'delivered';
    dbResults = [[project], [{ sessionId: 'sess-1', createdBy: 'user-1', metadata: {} }], []];
    await spawnAgentTurn('proj-1', envelope, event);
    expect(deliverCalls).toBe(1);
    expect(createSessionCalls).toBe(0);
  });

  test('pending (session waking) → keep mapping, NEVER recreate', async () => {
    deliverOutcome = 'pending';
    dbResults = [[project], [{ sessionId: 'sess-1', createdBy: 'user-1', metadata: {} }]];
    await spawnAgentTurn('proj-1', envelope, event);
    expect(createSessionCalls).toBe(0);
    expect(finalizeCalls.at(-1)?.error).toContain('waking');
  });

  test('failed (genuine error) → surface it ONCE with a session link, keep mapping, NEVER recreate', async () => {
    deliverOutcome = 'failed';
    dbResults = [
      [project],
      [{ sessionId: 'sess-1', createdBy: 'user-1', metadata: {} }], // chat_threads lookup (known thread)
      [{ eventId: 'notice' }], // claimThreadErrorNotice → WON (first failure for this thread)
    ];
    await spawnAgentTurn('proj-1', envelope, event);
    expect(createSessionCalls).toBe(0);
    expect(finalizeCalls.at(-1)?.error).toContain('error');
    // The notice links straight to the session so the thread isn't a dead end.
    expect(finalizeCalls.at(-1)?.error).toContain('proj-1/sessions/sess-1');
    expect(finalizeCalls.at(-1)?.error).toContain('Open it in Kortix');
  });

  test('failed AGAIN → notice already claimed → stay silent (no repeat, the thread isn’t spammed)', async () => {
    deliverOutcome = 'failed';
    dbResults = [
      [project],
      [{ sessionId: 'sess-1', createdBy: 'user-1', metadata: {} }], // chat_threads lookup (known thread)
      [], // claimThreadErrorNotice → LOST (we already told this thread once)
    ];
    await spawnAgentTurn('proj-1', envelope, event);
    expect(createSessionCalls).toBe(0);
    // We still finalize (to clear the ⏳ ack) but with NO error — silence, not a repeat.
    expect(finalizeCalls.length).toBe(1);
    expect(finalizeCalls.at(-1)?.error).toBeUndefined();
  });

  test('no-session (session deleted) → replace it (the ONLY create path for a known thread)', async () => {
    deliverOutcome = 'no-session';
    dbResults = [
      [project],
      [{ sessionId: 'sess-1', createdBy: 'user-1', metadata: {} }], // chat_threads lookup (known thread)
      [], // delete the stale chat_threads mapping
      [], // clearThreadErrorNotice → re-arm the failure notice for the new session
      [project], // projects lookup
      [{ eventId: 'claim' }], // claimThreadCreate → WON
      [], // re-check chat_threads → none
      [], // channel selection → defaults
      [], // remember owner participant
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
  test('claim WON, no existing mapping → creates EXACTLY one session, no follow-up', async () => {
    dbResults = [
      [project], // spawnAgentTurn project lookup
      [], // chat_threads lookup → brand-new thread
      [project], // projects lookup
      [{ eventId: 'claim' }], // claimThreadCreate → WON (a row came back)
      [], // re-check chat_threads → still none
      [], // channel selection → defaults
      [], // remember owner participant
    ];
    await spawnAgentTurn('proj-1', envelope, event);
    expect(createSessionCalls).toBe(1);
    expect(deliverCalls).toBe(0); // the winner creates with the initial prompt; no follow-up
  });

  test('claim LOST → joins the winner’s session as a follow-up, NEVER creates a second', async () => {
    dbResults = [
      [project], // spawnAgentTurn project lookup
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

// The exactly-once gate is THE regression guard for "@Kortix answered the same
// question 3×". Slack delivers one user message as several events (a channel
// @mention arrives as BOTH `app_mention` and `message`), can retry it with a
// fresh event_id, and fans it across replicas — every one of which shares the
// message's (team, channel, ts). The key collapses them to one identity, and
// dispatchSlackEvent claims it atomically before ever spawning the turn.
describe('inboundMessageKey — one message ⇒ one identity', () => {
  test('app_mention and message of the SAME message yield the SAME key', () => {
    const k1 = inboundMessageKey('T1', { channel: 'C1', ts: '100.1' }); // app_mention
    const k2 = inboundMessageKey('T1', { channel: 'C1', ts: '100.1' }); // sibling message
    expect(k1).toBe('slack:msg:T1:C1:100.1');
    expect(k2).toBe(k1);
  });

  test('distinct messages → distinct keys; missing coordinates → null (no gate)', () => {
    expect(inboundMessageKey('T1', { channel: 'C1', ts: '100.1' })).not.toBe(
      inboundMessageKey('T1', { channel: 'C1', ts: '200.2' }),
    );
    expect(inboundMessageKey('T1', { ts: '100.1' })).toBeNull();
    expect(inboundMessageKey('', { channel: 'C1', ts: '100.1' })).toBeNull();
  });
});

describe('dispatchSlackEvent — exactly-once per inbound user message', () => {
  const mention = (ts: string) =>
    ({ team_id: 'T1', event: { type: 'app_mention', channel: 'C1', ts, user: 'U1', thread_ts: '90.0', text: 'hi' } }) as any;

  test('a LOST message claim → the agent does NOT run (duplicate suppressed)', async () => {
    deliverOutcome = 'delivered';
    dbResults = [[]]; // claimInboundMessage → LOST: a sibling delivery already owns this message
    await dispatchSlackEvent('proj-1', mention('100.1'));
    expect(deliverCalls).toBe(0);
    expect(createSessionCalls).toBe(0);
  });

  test('bare unauthenticated mention prompts auth once instead of posting help twice', async () => {
    config.SLACK_REQUIRE_USER_IDENTITY = true;
    const bareMention = {
      team_id: 'T1',
      event: { type: 'app_mention', channel: 'C1', ts: '200.1', user: 'U1', text: '<@B1>' },
    } as any;

    dbResults = [
      [], // ensureProjectChannelBinding
      [{ eventId: 'slack:msg:T1:C1:200.1' }], // claimInboundMessage → WON
      [project], // project account lookup before empty-mention help
      [], // resolveSlackActor identity lookup → unlinked
    ];
    await dispatchSlackEvent('proj-1', bareMention);

    expect(messages).toHaveLength(0);
    expect(ephemerals).toHaveLength(1);
    expect(ephemerals[0]).toMatchObject({
      channel: 'C1',
      user: 'U1',
      text: 'Kortix needs a linked Kortix account to continue.',
    });

    dbResults = [
      [], // ensureProjectChannelBinding
      [], // same Slack message delivered again → duplicate suppressed
    ];
    await dispatchSlackEvent('proj-1', bareMention);
    expect(messages).toHaveLength(0);
    expect(ephemerals).toHaveLength(1);
  });

  test('WON claim runs once; an immediate redelivery (LOST claim) does NOT answer again', async () => {
    deliverOutcome = 'delivered';
    // Delivery #1 — claim WON, known thread, delivered into the existing session.
    dbResults = [
      [], // ensureProjectChannelBinding
      [{ eventId: 'slack:msg:T1:C1:100.1' }], // claimInboundMessage → WON
      [project],
      [{ sessionId: 'sess-1', createdBy: 'user-1', metadata: {} }], // chat_threads lookup (known thread)
      [], // update lastMessageAt
    ];
    await dispatchSlackEvent('proj-1', mention('100.1'));
    expect(deliverCalls).toBe(1);

    // Delivery #2 — the SAME message redelivered (fan-out / retry / other replica):
    // a fresh event_id slips past the envelope dedup, but the message claim is lost.
    dbResults = [
      [], // ensureProjectChannelBinding
      [], // claimInboundMessage → LOST
    ];
    await dispatchSlackEvent('proj-1', mention('100.1'));
    expect(deliverCalls).toBe(1); // still ONE — no second answer for the same question
    expect(createSessionCalls).toBe(0);
  });
});
