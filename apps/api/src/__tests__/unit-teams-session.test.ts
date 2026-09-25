import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { chatIdentityStub } from './helpers/chat-identity-stub';

/**
 * Time-to-first-card. On dev (2026-09-18) the "Working on it…" card showed a
 * few seconds after the message, because the live card was posted only after
 * the project row, a secret upsert, the identity link, the account membership
 * and the authorization verdict had all been resolved. The card carries no
 * information from any of those, so it goes out first; the identity outcome
 * then REPLACES it in place instead of stacking a second card underneath.
 */

const PROJECT_ID = '40c2e222-c4c2-47f6-ba40-05e8f40098b3';
const TENANT_ID = '36009a52-46d2-44bc-ba56-57a87e485e0a';
const CONVERSATION_ID = 'a:1FQyR2jW1pEUK';

const calls: string[] = [];
let actor: { userId: string } | { reason: 'unlinked' | 'not_member' } = { userId: 'user-1' };
let existingThread: Array<{
  sessionId: string;
  projectId?: string;
  createdBy?: string | null;
  metadata?: Record<string, unknown> | null;
  status?: string | null;
}> = [];
let claimWins = true;
/** Per-call insert results: the thread-create claim first, then the error-notice claim. */
let insertQueue: unknown[][] = [];
let followUpOutcome: string = 'delivered';
let inflightTurn: { finalized: boolean; updatedAt?: number; sessionId?: string } | null = null;
const finalized: Array<Record<string, unknown>> = [];
const notices: string[] = [];
const dbOps: string[] = [];
const created: Array<Record<string, unknown>> = [];
const continued: Array<Record<string, unknown>> = [];
const prompts: Array<Record<string, unknown>> = [];
const saved: Array<{ sessionId: string; messageActivityId: string }> = [];

function chain(result: unknown[]): any {
  const c: any = {};
  for (const m of ['from', 'innerJoin', 'where', 'limit', 'values', 'onConflictDoNothing', 'onConflictDoUpdate', 'returning', 'set']) c[m] = () => c;
  c.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(result));
  c.catch = () => Promise.resolve(result);
  return c;
}

// The real table object: a delete is told apart by the table it targets.
const { chatEventDedup: chatEventDedupTable } = await import('@kortix/db');

let selectCount = 0;
mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: () => {
      selectCount += 1;
      // 1st select: the project row; later selects: chat_threads lookup.
      return selectCount === 1
        ? chain([{ projectId: PROJECT_ID, accountId: 'acct-1', defaultBranch: 'main' }])
        : chain(existingThread);
    },
    insert: () => {
      dbOps.push('insert');
      if (insertQueue.length) return chain(insertQueue.shift()!);
      return chain(claimWins ? [{ eventId: 'claimed' }] : []);
    },
    delete: (table: unknown) => {
      dbOps.push(table === chatEventDedupTable ? 'delete:dedup' : 'delete');
      return chain([]);
    },
    update: () => {
      dbOps.push('update');
      return chain([]);
    },
  },
}));

mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  config: { TEAMS_REQUIRE_USER_IDENTITY: true, FRONTEND_URL: 'https://dev.kortix.com' },
}));

mock.module('../channels/teams/turn', () => ({
  startTurn: async () => {
    calls.push('startTurn');
    return {
      conversationId: CONVERSATION_ID,
      tenantId: TENANT_ID,
      serviceUrl: 'https://smba.trafficmanager.net/emea/',
      triggerActivityId: 'act-1',
      messageActivityId: 'live-card-1',
      steps: [],
      expiry: Date.now() + 60_000,
      finalized: false,
      projectId: PROJECT_ID,
      sessionId: '',
      originatingActivity: {},
    };
  },
  saveTurn: async (h: { sessionId: string; messageActivityId: string }) => {
    calls.push('saveTurn');
    saved.push({ sessionId: h.sessionId, messageActivityId: h.messageActivityId });
  },
  finalizeTurn: async (_h: unknown, opts: Record<string, unknown>) => {
    calls.push('finalizeTurn');
    finalized.push(opts);
  },
  loadTurn: async () => inflightTurn,
  closeAbandonedTurn: async () => {
    calls.push('closeAbandonedTurn');
  },
  deleteTurn: async () => {
    calls.push('deleteTurn');
  },
  noticeOnLiveCard: async (_h: unknown, text: string) => {
    calls.push('noticeOnLiveCard');
    notices.push(text);
  },
  persistServiceUrl: async () => {
    calls.push('persistServiceUrl');
  },
  buildTeamsTurnEnv: () => ({}),
  showStopOnLiveCard: async () => {
    calls.push('showStopOnLiveCard');
  },
}));

mock.module('../channels/teams/identity', () => ({
  teamsUserId: () => 'aad-user-1',
  postTeamsIdentityPrompt: async (input: Record<string, unknown>) => {
    calls.push('postTeamsIdentityPrompt');
    prompts.push(input);
  },
}));
mock.module('../channels/core/identity', () =>
  chatIdentityStub({
  
  // Reached by the AGENT_NOT_DECLARED recovery picker, which scopes its list
  // to the pressing user.
  lookupChatIdentity: async () => null,
  resolveChatActor: async () => {
    calls.push('resolveChatActor');
    return actor;
  },
}),
);

const bindings: Array<Record<string, unknown>> = [];
mock.module('../channels/teams/binding', () => ({
  ensureTeamsConversationBinding: async (input: Record<string, unknown>) => {
    bindings.push(input);
    return true;
  },
  teamsChannelCtx: () => ({ platform: 'teams', teamId: TENANT_ID, channelId: CONVERSATION_ID }),
}));

// `mock.module` REPLACES the module wholesale, so every export the
// session-start path reaches through this file has to be listed. Session start
// pulls `listProjectAgents` through the AGENT_NOT_DECLARED recovery picker
// (channels/teams/agent-picker.ts -> channels/scoped-agents.ts).
mock.module('../channels/slack/selection', () => ({
  currentChannelSelection: async () => null,
  listProjectAgents: async () => [],
}));

let participantVerdict: { allowed: true } | { allowed: false; notice: string } = { allowed: true };
const owners: Array<Record<string, unknown>> = [];
const gateCalls: Array<Record<string, unknown>> = [];
mock.module('../channels/teams/participants', () => ({
  ensureTeamsThreadParticipant: async (input: Record<string, unknown>) => {
    gateCalls.push(input);
    return participantVerdict;
  },
  rememberTeamsThreadOwner: async (input: Record<string, unknown>) => {
    owners.push(input);
  },
  normalizeConversationPolicy: (v: unknown) => (typeof v === 'string' ? v : 'project_open'),
}));

const session = await import('../channels/teams/session');
const { createOrJoinTeamsConversationSession, setTeamsSessionLifecycleForTest, resetTeamsSessionLifecycleForTest } = session;

const activity = {
  type: 'message',
  id: 'act-1',
  text: 'List the files in this repo',
  serviceUrl: 'https://smba.trafficmanager.net/emea/',
  conversation: { id: CONVERSATION_ID, tenantId: TENANT_ID },
  from: { id: '29:abc', name: 'Ivan Bagaric', aadObjectId: 'aad-user-1' },
  recipient: { id: '28:bot' },
};

beforeEach(() => {
  calls.length = 0;
  created.length = 0;
  continued.length = 0;
  prompts.length = 0;
  saved.length = 0;
  selectCount = 0;
  actor = { userId: 'user-1' };
  existingThread = [];
  claimWins = true;
  insertQueue = [];
  followUpOutcome = 'delivered';
  inflightTurn = null;
  finalized.length = 0;
  notices.length = 0;
  dbOps.length = 0;
  bindings.length = 0;
  participantVerdict = { allowed: true };
  owners.length = 0;
  gateCalls.length = 0;
  setTeamsSessionLifecycleForTest({
    createSession: async (input: Record<string, unknown>) => {
      calls.push('createSession');
      created.push(input);
      return { status: 'running', sessionId: 'sess-new' } as never;
    },
    continueSession: async (input: Record<string, unknown>) => {
      calls.push('continueSession');
      continued.push(input);
      return followUpOutcome as never;
    },
    resolveProjectAutomationActor: async () => 'automation-user',
  } as never);
});

afterAll(() => {
  resetTeamsSessionLifecycleForTest();
  mock.restore();
});

describe('createOrJoinTeamsConversationSession — the live card goes out first', () => {
  test('new conversation: the card is posted before identity is resolved, then the session is created once', async () => {
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect(calls.indexOf('startTurn')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('startTurn')).toBeLessThan(calls.indexOf('resolveChatActor'));
    expect(calls.filter((c) => c === 'startTurn')).toHaveLength(1);
    expect(created).toHaveLength(1);
    expect(created[0].userId).toBe('user-1');
    expect(saved).toEqual([{ sessionId: 'sess-new', messageActivityId: 'live-card-1' }]);
    expect(prompts).toHaveLength(0);
  });

  test('follow-up in a bound conversation: the same live card is reused and the session is continued', async () => {
    existingThread = [{ sessionId: 'sess-existing' }];

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect(calls.filter((c) => c === 'startTurn')).toHaveLength(1);
    expect(calls.indexOf('startTurn')).toBeLessThan(calls.indexOf('resolveChatActor'));
    expect(continued).toHaveLength(1);
    expect(continued[0].sessionId).toBe('sess-existing');
    expect(created).toHaveLength(0);
    expect(saved).toEqual([{ sessionId: 'sess-existing', messageActivityId: 'live-card-1' }]);
  });

  test('unlinked sender: the identity prompt REPLACES the live card instead of stacking under it', async () => {
    actor = { reason: 'unlinked' };

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect(calls.indexOf('startTurn')).toBeLessThan(calls.indexOf('resolveChatActor'));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatchObject({ reason: 'unlinked', replaceActivityId: 'live-card-1' });
    expect(created).toHaveLength(0);
    expect(continued).toHaveLength(0);
    expect(saved).toHaveLength(0);
  });

  test('member without project access: same, with the request-access reason', async () => {
    actor = { reason: 'not_member' };

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect(prompts[0]).toMatchObject({ reason: 'not_member', replaceActivityId: 'live-card-1' });
    expect(created).toHaveLength(0);
  });

  test('the service-url bookkeeping never sits in front of the card', async () => {
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    const persist = calls.indexOf('persistServiceUrl');
    expect(persist === -1 || persist > calls.indexOf('startTurn')).toBe(true);
  });
});

describe('mention markup never reaches the session', () => {
  const mentioned = {
    ...activity,
    text: '<at>Kortix Dev</at>summarize the README in two sentences',
  };

  test('the session title source and the agent prompt carry the words, not <at> tags', async () => {
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity: mentioned });
    const body = created[0].body as { title_source: string; initial_prompt: string };
    expect(body.title_source).toBe('summarize the README in two sentences');
    expect(body.initial_prompt).not.toContain('<at>');
    expect(body.initial_prompt).toContain('\nsummarize the README in two sentences');
  });

  test('a follow-up prompt is stripped the same way', () => {
    const prompt = session.renderFollowUpPrompt({ ...mentioned, text: '<at>Kortix Dev</at> now count the lines' });
    expect(prompt).not.toContain('<at>');
    expect(prompt).toContain('\nnow count the lines\n');
  });
});

describe('follow-up outcomes — the conversation is never left on "Working on it…"', () => {
  beforeEach(() => {
    existingThread = [{ sessionId: 'sess-existing' }];
  });

  test('delivered: the thread\'s lastMessageAt is bumped', async () => {
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    expect(continued).toHaveLength(1);
    expect(dbOps).toContain('update');
    expect(finalized).toHaveLength(0);
  });

  test('pending (session still waking): the live card says so and the mapping is kept', async () => {
    followUpOutcome = 'pending';
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    expect(calls).toContain('deleteTurn');
    expect(finalized).toHaveLength(1);
    expect(String(finalized[0].error)).toMatch(/waking/i);
    expect(created).toHaveLength(0);
    expect(dbOps.filter((o) => o === 'delete')).toHaveLength(0);
  });

  test('failed: the error is surfaced once per conversation with the session link, then silently', async () => {
    followUpOutcome = 'failed';
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    expect(finalized).toHaveLength(1);
    expect(String(finalized[0].error)).toContain('sess-existing');
    expect(String(finalized[0].error)).toMatch(/error/i);
    expect(created).toHaveLength(0);

    // Second message on the same jammed thread: the notice claim loses → no repeat.
    finalized.length = 0;
    selectCount = 0;
    insertQueue = [[]];
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    expect(finalized).toHaveLength(1);
    expect(finalized[0].error).toBeUndefined();
    // Silent is not the same as "Task complete". Suppressing the repeated
    // notice must not make the card claim the run succeeded — every later
    // message on a jammed conversation used to close with the default title.
    expect(finalized[0].title).toBe("Couldn't start");
    expect(finalized[0].unfinished).toBe(true);
  });

  test('no-session (deleted): the stale mapping is dropped and a NEW session is created with a revived note', async () => {
    followUpOutcome = 'no-session';
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    expect(dbOps).toContain('delete');
    expect(created).toHaveLength(1);
    const body = created[0].body as { initial_prompt: string };
    expect(body.initial_prompt).toMatch(/^NOTE: This Teams conversation had an earlier session/);
    expect(body.initial_prompt).toContain("You're answering a message on Microsoft Teams as a teammate.");
    // The same live card carries the new session — no second card.
    expect(calls.filter((c) => c === 'startTurn')).toHaveLength(1);
    expect(saved.at(-1)).toEqual({ sessionId: 'sess-new', messageActivityId: 'live-card-1' });
  });

  test('a turn already in flight: the new card becomes a short notice and never replaces the running stream', async () => {
    existingThread = [{ sessionId: 'sess-existing', createdBy: 'user-1', status: 'running' }];
    inflightTurn = { finalized: false, updatedAt: Date.now(), sessionId: 'sess-existing' };
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    expect(calls).toContain('noticeOnLiveCard');
    expect(saved).toHaveLength(0);
    expect(continued).toHaveLength(1);
  });
});

describe('binding names', () => {
  test('a new conversation is bound with a human-readable name and its scope', async () => {
    await createOrJoinTeamsConversationSession({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      activity: { ...activity, conversation: { ...activity.conversation, conversationType: 'personal' } },
    });
    expect(bindings[0]).toMatchObject({ channelName: 'Ivan Bagaric', channelType: 'personal' });
  });
});

describe('join policy on a follow-up', () => {
  beforeEach(() => {
    existingThread = [{ sessionId: 'sess-existing', createdBy: 'owner-1', metadata: { teams: { conversation_policy: 'owner_approval' } } }];
  });

  test('the gate runs with the session owner and its frozen policy before anything is delivered', async () => {
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]).toMatchObject({
      sessionId: 'sess-existing',
      sessionOwnerId: 'owner-1',
      sessionMetadata: { teams: { conversation_policy: 'owner_approval' } },
      teamsUserId: 'aad-user-1',
      actorUserId: 'user-1',
    });
    expect(calls.indexOf('resolveChatActor')).toBeLessThan(calls.indexOf('continueSession'));
  });

  test('not allowed: the requester\'s live card becomes the notice, nothing is delivered, the session is untouched', async () => {
    participantVerdict = { allowed: false, notice: 'This Kortix session is owner-only.' };
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    expect(notices).toEqual(['This Kortix session is owner-only.']);
    expect(continued).toHaveLength(0);
    expect(saved).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  test('a new session remembers its owner as the first approved participant and freezes the policy', async () => {
    existingThread = [];
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    expect(owners).toEqual([
      { tenantId: TENANT_ID, conversationId: CONVERSATION_ID, sessionId: 'sess-new', teamsUserId: 'aad-user-1', userId: 'user-1' },
    ]);
    const meta = created[0].metadata as { teams: { conversation_policy: string } };
    expect(meta.teams.conversation_policy).toBe('project_open');
  });

  test('a channel session records its team', async () => {
    // The turn env carries MS_TEAMS_TEAM_GROUP_ID for one turn only. Graph
    // reads of the channel need the team id after that activity is gone.
    existingThread = [];
    await createOrJoinTeamsConversationSession({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      activity: { ...activity, channelData: { team: { id: '19:general@thread.tacv2', aadGroupId: 'group-1', name: 'Platform' } } },
    });
    expect((created[0].metadata as { teams: Record<string, unknown> }).teams).toMatchObject({
      team_group_id: 'group-1',
      team_name: 'Platform',
    });
  });

  test('a personal or group chat session records no team', async () => {
    existingThread = [];
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    const teams = (created[0].metadata as { teams: Record<string, unknown> }).teams;
    expect(teams).not.toHaveProperty('team_group_id');
    expect(teams).not.toHaveProperty('team_name');
  });
});

describe('a turn that died mid-flight does not wedge the conversation', () => {
  test('stopped session + unfinished turn: the dead card is closed and the new message gets its own', async () => {
    existingThread = [{ sessionId: 'sess-existing', createdBy: 'user-1', status: 'stopped' }];
    inflightTurn = { finalized: false, updatedAt: Date.now(), sessionId: 'sess-existing' };

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect(calls).toContain('closeAbandonedTurn');
    // No "I'll take this after the current step" — that was the wedge.
    expect(notices).toHaveLength(0);
    expect(saved).toEqual([{ sessionId: 'sess-existing', messageActivityId: 'live-card-1' }]);
    expect(continued).toHaveLength(1);
  });

  test('a quiet card over a run the runtime still holds is NOT closed as abandoned', async () => {
    // One long command posts no step. Closing its card as "ended" lost the
    // run's answer: its `teams send` then found no turn.
    setTeamsSessionLifecycleForTest({
      createSession: async () => ({ status: 'running', sessionId: 'sess-new' }) as never,
      continueSession: async (input: Record<string, unknown>) => {
        continued.push(input);
        return 'delivered' as never;
      },
      resolveProjectAutomationActor: async () => 'user-1',
      holdsLiveTurn: async () => true,
    } as never);
    existingThread = [{ sessionId: 'sess-existing', createdBy: 'user-1', status: 'running' }];
    inflightTurn = { finalized: false, updatedAt: Date.now() - 20 * 60 * 1000, sessionId: 'sess-existing' };

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect(calls).not.toContain('closeAbandonedTurn');
    expect(notices).toEqual(['Got it — I’ll take this after the current step.']);
    expect(continued).toHaveLength(1);
  });

  test('running session but the turn has not moved in over 10 minutes: also treated as abandoned', async () => {
    existingThread = [{ sessionId: 'sess-existing', createdBy: 'user-1', status: 'running' }];
    inflightTurn = { finalized: false, updatedAt: Date.now() - 11 * 60 * 1000, sessionId: 'sess-existing' };

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect(calls).toContain('closeAbandonedTurn');
    expect(notices).toHaveLength(0);
  });

  test('an already-finalized row is not closed again', async () => {
    existingThread = [{ sessionId: 'sess-existing', createdBy: 'user-1', status: 'stopped' }];
    inflightTurn = { finalized: true, updatedAt: Date.now(), sessionId: 'sess-existing' };

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect(calls).not.toContain('closeAbandonedTurn');
    expect(saved).toHaveLength(1);
  });
});

// A conversation whose agent was deleted, renamed or disabled is rejected at
// session create with `400 AGENT_NOT_DECLARED`. Teams used to answer that with
// "give it a moment and send your message again" — advice that can never work,
// because every retry re-sends the same dead agent. The conversation had no
// way out at all short of an admin knowing `/agents` existed.
describe('createOrJoinTeamsConversationSession — a start failure says what to do', () => {
  const startFails = (status: number, body: unknown) =>
    setTeamsSessionLifecycleForTest({
      createSession: async () => {
        calls.push('createSession');
        return { error: { status, body } } as never;
      },
    });

  test('AGENT_NOT_DECLARED posts the agent picker, not a line of prose', async () => {
    startFails(400, { code: 'AGENT_NOT_DECLARED', error: 'agent "reviewer" is not declared' });

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect(finalized).toHaveLength(1);
    const opts = finalized[0] as { title?: string; card?: Record<string, unknown>; error?: string };
    expect(opts.title).toBe("Couldn't start — pick an agent");
    expect(opts.card).toBeTruthy();
    expect(opts.error).toBeUndefined();
    // The mocked project declares no agents, so the picker degrades to the
    // notice that names the dead pick and the way back to the default.
    expect(JSON.stringify(opts.card)).toContain('no longer exists');
  });

  test('402 keeps the credits copy', async () => {
    startFails(402, {});

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect((finalized[0] as { error: string }).error.toLowerCase()).toContain('out of credits');
  });

  test('a 403 asks for an admin instead of telling the user to retry forever', async () => {
    startFails(403, {});

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    const error = (finalized[0] as { error: string }).error;
    expect(error.toLowerCase()).toContain('admin');
    expect(error).not.toContain('Give it a moment');
  });

  test('an error CODE beats its HTTP status, and points at the real fix', async () => {
    startFails(503, { code: 'KORTIX_URL_UNREACHABLE', error: 'unreachable' });

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect((finalized[0] as { error: string }).error.toLowerCase()).toContain('sandbox runtime');
  });

  test('a failed start releases the thread-create claim, so the retry it asks for can start', async () => {
    // The claim lives 5 minutes. Held after a failure, every retry inside
    // that window lost it, waited 8 s for a session nobody was creating, and
    // failed with "couldn't start" — including the retry the agent picker
    // asks for ("Pick one, then send your message again").
    startFails(400, { code: 'AGENT_NOT_DECLARED', error: 'agent "reviewer" is not declared' });

    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect(dbOps).toContain('delete:dedup');
  });
});

// The lifecycle keeps an idempotency key forever (a unique index, no
// retention), and a personal or group chat is ONE conversation for life. Under
// a per-conversation key the chat's first create_session command answered
// every later create: a failed first start (dead-lettered) failed every later
// message with the same error, a deleted session answered 409
// IDEMPOTENCY_KEY_SESSION_DELETED, and `/new` got the old session back.
describe('createOrJoinTeamsConversationSession — the create key is per message', () => {
  test('each message that creates a session carries its own key; a redelivery keeps it', async () => {
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });
    created.length = 0;
    selectCount = 0;
    await createOrJoinTeamsConversationSession({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      activity: { ...activity, id: 'act-2' },
    });
    const second = created[0]!.idempotencyKey;
    created.length = 0;
    selectCount = 0;
    await createOrJoinTeamsConversationSession({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      activity: { ...activity, id: 'act-2' },
    });

    expect(second).toBe(`teams:create:${TENANT_ID}:${CONVERSATION_ID}:act-2`);
    expect(created[0]!.idempotencyKey).toBe(second);
  });

  test('why: an existing command under the key answers the create — a failed one forever', async () => {
    const { resultFromExistingCommand } = await import('../projects/session-lifecycle/store');
    const answer = resultFromExistingCommand({
      commandId: 'cmd-1',
      status: 'dead_lettered',
      lastError: 'agent "reviewer" is not declared',
      result: {},
      sessionId: null,
    } as never);
    expect(answer.status).toBe('failed');
    expect(answer.retryable).toBe(false);
  });
});

describe('createOrJoinTeamsConversationSession — a started session keeps its claim', () => {
  test('a session that started does not release the claim a racing message must lose', async () => {
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    expect(created).toHaveLength(1);
    expect(dbOps).not.toContain('delete:dedup');
  });
});

// Stop is only paintable once the card knows which session it would end, so
// the repaint has to follow the bind — otherwise the button appears only when
// the agent reports its first step, which on a slow start is the whole wait.
describe('createOrJoinTeamsConversationSession — Stop appears as soon as the session exists', () => {
  test('the live card is repainted immediately after the turn binds', async () => {
    await createOrJoinTeamsConversationSession({ projectId: PROJECT_ID, tenantId: TENANT_ID, conversationId: CONVERSATION_ID, activity });

    const bind = calls.indexOf('saveTurn');
    const repaint = calls.indexOf('showStopOnLiveCard');
    expect(bind).toBeGreaterThanOrEqual(0);
    expect(repaint).toBeGreaterThan(bind);
  });
});

/**
 * A conversation's session lives in exactly one project (`chat_threads`). A
 * per-project (bring-your-own) bot may reach only its own project, so a
 * conversation whose session another project owns is refused: no card, no
 * identity lookup, no delivery.
 */
describe('createOrJoinTeamsConversationSession — a session owned by another project', () => {
  test('a per-project bot refuses it before posting anything', async () => {
    existingThread = [{ sessionId: 'sess-other', projectId: 'project-other' }];

    await createOrJoinTeamsConversationSession({
      projectId: PROJECT_ID,
      tenantId: TENANT_ID,
      conversationId: CONVERSATION_ID,
      activity,
      ownThreadsOnly: true,
    });

    expect(calls).not.toContain('startTurn');
    expect(calls).not.toContain('resolveChatActor');
    expect(continued).toHaveLength(0);
    expect(created).toHaveLength(0);
  });
});
