import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';

// `/new` in a Teams chat. A personal or group chat is one conversation id for
// its whole life, and a conversation maps permanently to one session — so
// before this, every task anyone ever asked in a chat shared one session.
// These pin what a fresh start removes, what it leaves alone, and who may do it.

const TENANT = 'tenant-1';
const CONVO = 'a:synthetic-chat';

const { chatEventDedup, chatThreadParticipants, chatThreads } = await import('@kortix/db');

let threadRow: { sessionId: string; status: string | null; metadata: Record<string, unknown> | null } | undefined;
let participantRow: { status: string } | undefined;
let participantThrows = false;
const deleted: unknown[] = [];

function chain(result: () => unknown[] | Promise<unknown[]>): any {
  const c: any = {};
  for (const m of ['from', 'leftJoin', 'innerJoin', 'where', 'limit']) c[m] = () => c;
  c.then = (resolve: (rows: unknown[]) => unknown, reject: (err: unknown) => unknown) =>
    Promise.resolve()
      .then(result)
      .then(resolve, reject);
  c.catch = () => Promise.resolve([]);
  return c;
}

mock.module('../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (shape: Record<string, unknown>) =>
      'sessionId' in shape
        ? chain(() => (threadRow ? [threadRow] : []))
        : chain(() => {
            if (participantThrows) throw new Error('pool exhausted');
            return participantRow ? [participantRow] : [];
          }),
    delete: (table: unknown) => {
      deleted.push(table);
      return chain(() => []);
    },
  },
}));

let requireIdentity = true;
mock.module('../config', () => ({
  SANDBOX_VERSION: 'test',
  config: {
    FRONTEND_URL: 'https://dev.kortix.com',
    get TEAMS_REQUIRE_USER_IDENTITY() {
      return requireIdentity;
    },
  },
}));

let turn: Record<string, unknown> | null = null;
const closed: string[] = [];
const turnDeletes: string[] = [];
mock.module('../channels/teams/turn', () => ({
  loadTurn: async () => turn,
  closeAbandonedTurn: async (h: { sessionId: string }) => {
    closed.push(h.sessionId);
  },
  deleteTurn: async (id: string) => {
    turnDeletes.push(id);
  },
}));

const { messageAfterFreshStart, startFreshTeamsConversation } = await import('../channels/teams/fresh-start');

const fresh = (over: Partial<Parameters<typeof startFreshTeamsConversation>[0]> = {}) =>
  startFreshTeamsConversation({
    tenantId: TENANT,
    conversationId: CONVO,
    scope: 'personal',
    teamsUserId: 'aad-owner',
    ...over,
  });

beforeEach(() => {
  threadRow = { sessionId: 'sess-old', status: 'running', metadata: { teams: { conversation_policy: 'owner_only' } } };
  participantRow = undefined;
  participantThrows = false;
  requireIdentity = true;
  turn = null;
  deleted.length = 0;
  closed.length = 0;
  turnDeletes.length = 0;
});

afterAll(() => {
  mock.restore();
});

describe('startFreshTeamsConversation', () => {
  test('detaches the conversation from its session and clears what was decided for it', async () => {
    const outcome = await fresh();

    expect(outcome).toEqual({ reset: true, previousSessionId: 'sess-old' });
    // The mapping, the join decisions made for THAT session, and the
    // thread-create claim + error marker.
    expect(deleted).toEqual([chatThreads, chatThreadParticipants, chatEventDedup]);
  });

  test('a chat with no session yet is already fresh, and nothing is deleted', async () => {
    threadRow = undefined;

    expect(await fresh()).toEqual({ reset: true, previousSessionId: null });
    // The claim is kept: with no mapping it can only belong to a session
    // that is being created right now.
    expect(deleted).toEqual([]);
  });

  test('a channel is refused: every new post there is already its own session', async () => {
    const outcome = await fresh({ scope: 'channel' });

    expect(outcome.reset).toBe(false);
    expect(outcome.reset === false && outcome.notice).toContain('new post');
    expect(deleted).toEqual([]);
  });

  test('a run still going is refused, and pointed at /stop', async () => {
    turn = { sessionId: 'sess-old', finalized: false, updatedAt: Date.now() };

    const outcome = await fresh();

    expect(outcome.reset).toBe(false);
    expect(outcome.reset === false && outcome.notice).toContain('/stop');
    expect(deleted).toEqual([]);
  });

  test('an unfinished turn that stopped moving is closed, not left for the 30-minute sweep', async () => {
    turn = { sessionId: 'sess-old', finalized: false, updatedAt: Date.now() - 11 * 60 * 1000 };

    expect((await fresh()).reset).toBe(true);
    expect(closed).toEqual(['sess-old']);
  });

  test('an unfinished turn on a session that is not running is closed too', async () => {
    threadRow = { sessionId: 'sess-old', status: 'stopped', metadata: null };
    turn = { sessionId: 'sess-old', finalized: false, updatedAt: Date.now() };

    expect((await fresh()).reset).toBe(true);
    expect(closed).toEqual(['sess-old']);
  });

  test('a finalized turn row is removed quietly', async () => {
    turn = { sessionId: 'sess-old', finalized: true, updatedAt: Date.now() };

    await fresh();

    expect(closed).toEqual([]);
    expect(turnDeletes).toEqual(['sess-old']);
  });
});

describe('who may start fresh in a group chat', () => {
  test('in a personal chat, the one person in it', async () => {
    participantRow = undefined;
    expect((await fresh({ scope: 'personal', teamsUserId: 'aad-anyone' })).reset).toBe(true);
  });

  test('an approved participant — which includes the owner — may', async () => {
    participantRow = { status: 'approved' };
    expect((await fresh({ scope: 'groupChat' })).reset).toBe(true);
  });

  test('under an owner-only session, anyone else may not: it would make them the next owner', async () => {
    participantRow = { status: 'pending' };

    const outcome = await fresh({ scope: 'groupChat', teamsUserId: 'aad-bystander' });

    expect(outcome.reset).toBe(false);
    expect(deleted).toEqual([]);
  });

  test('under project_open anyone may, as anyone may continue the session', async () => {
    threadRow = { sessionId: 'sess-old', status: 'running', metadata: { teams: { conversation_policy: 'project_open' } } };
    expect((await fresh({ scope: 'groupChat', teamsUserId: 'aad-anyone' })).reset).toBe(true);
  });

  test('a session that froze no policy falls back to the conversation`s', async () => {
    threadRow = { sessionId: 'sess-old', status: 'running', metadata: null };

    expect((await fresh({ scope: 'groupChat', teamsUserId: 'aad-anyone', channelPolicy: 'owner_approval' })).reset).toBe(false);
    expect((await fresh({ scope: 'groupChat', teamsUserId: 'aad-anyone', channelPolicy: 'project_open' })).reset).toBe(true);
  });

  test('a participant lookup that fails refuses rather than assumes', async () => {
    participantThrows = true;
    expect((await fresh({ scope: 'groupChat' })).reset).toBe(false);
  });

  test('without linked identities no policy is enforced, so none is here', async () => {
    requireIdentity = false;
    expect((await fresh({ scope: 'groupChat', teamsUserId: 'aad-anyone' })).reset).toBe(true);
  });
});

describe('messageAfterFreshStart', () => {
  test('a bare /new carries no message', () => {
    expect(messageAfterFreshStart({ text: '/new' })).toBe('');
    expect(messageAfterFreshStart({ text: '/reset  ' })).toBe('');
  });

  test('the rest of the message starts the new session, line breaks intact', () => {
    expect(messageAfterFreshStart({ text: '/new summarize this log:\n12:00 boot\n12:01 crash' })).toBe(
      'summarize this log:\n12:00 boot\n12:01 crash',
    );
  });

  test('a message on the line after the command is kept', () => {
    expect(messageAfterFreshStart({ text: '/new\nwhat changed in main today?' })).toBe('what changed in main today?');
  });

  test('the bot mention in a group chat is not part of the message', () => {
    expect(
      messageAfterFreshStart({
        text: '<at>Kortix</at> /new plan the sprint',
        entities: [{ type: 'mention', mentioned: { id: '28:bot' }, text: '<at>Kortix</at>' }],
        recipient: { id: '28:bot' },
      }),
    ).toBe('plan the sprint');
  });

  test('a word that only starts with "new" is not the command', () => {
    expect(messageAfterFreshStart({ text: '/newsletter draft' })).toBe('/newsletter draft');
  });
});
