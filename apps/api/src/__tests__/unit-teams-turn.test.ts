import { beforeEach, describe, expect, mock, test } from 'bun:test';

type Call = { fn: string; args: unknown[] };
let apiCalls: Call[] = [];
let nextActivityId: string | null = 'act-1';

const record = (fn: string) => (...args: unknown[]) => {
  apiCalls.push({ fn, args });
};

mock.module('../channels/teams-api', () => ({
  sendCard: async (...a: unknown[]) => {
    record('sendCard')(...a);
    return nextActivityId;
  },
  updateCard: async (...a: unknown[]) => {
    record('updateCard')(...a);
    return true;
  },
  sendTyping: async (...a: unknown[]) => record('sendTyping')(...a),
  sendText: async (...a: unknown[]) => {
    record('sendText')(...a);
    return 'act-x';
  },
  sendActivity: async (...a: unknown[]) => {
    record('sendActivity')(...a);
    return 'act-x';
  },
  updateActivity: async () => true,
  cardActivity: (c: unknown) => ({ type: 'message', attachments: [{ contentType: 'x', content: c }] }),
}));

mock.module('../config', () => ({ config: { FRONTEND_URL: 'https://app', MICROSOFT_APP_ID: 'x' } }));
mock.module('../channels/slack/util', () => ({ sessionWebUrl: () => 'https://app/session' }));
mock.module('../channels/install-store', () => ({
  saveTeamsServiceUrl: async () => {},
  loadTeamsTenantForProject: async () => 'tenant-1',
}));

let dbResults: unknown[][] = [];
let dbWrites: Array<{ op: string; payload?: unknown }> = [];

function makeChain(op: string): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'onConflictDoUpdate', 'returning']) chain[m] = () => chain;
  chain.values = (payload: unknown) => {
    dbWrites.push({ op: `${op}.values`, payload });
    return chain;
  };
  chain.set = (payload: unknown) => {
    dbWrites.push({ op: `${op}.set`, payload });
    return chain;
  };
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  chain.catch = () => chain;
  chain.finally = () => chain;
  return chain;
}

mock.module('../shared/db', () => ({
  db: {
    select: () => makeChain('select'),
    insert: () => makeChain('insert'),
    update: () => makeChain('update'),
    delete: () => {
      dbWrites.push({ op: 'delete' });
      return makeChain('delete');
    },
  },
  hasDatabase: () => true,
}));

const { relayTurnAnswer, relayTurnEnd, relayTurnStep } = await import('../channels/teams/turn');

function streamRow(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    projectId: 'proj-1',
    teamId: 'tenant-1',
    channel: 'conv-1',
    triggerTs: 'msg-1',
    messageTs: null,
    finalized: false,
    steps: [],
    originatingEvent: { type: 'message', id: 'msg-1', conversation: { id: 'conv-1' } },
    channelRef: { platform: 'teams', serviceUrl: 'https://smba/', conversationId: 'conv-1' },
    expiresAt: new Date(Date.now() + 60_000),
    updatedAt: new Date(),
    ...over,
  };
}

beforeEach(() => {
  apiCalls = [];
  dbWrites = [];
  dbResults = [];
  nextActivityId = 'act-1';
});

describe('relayTurnStep', () => {
  test('first step posts a new plan card and persists the message id', async () => {
    dbResults = [[streamRow()], []];
    const ok = await relayTurnStep('sess-1', 'Reading logs');
    expect(ok).toBe(true);
    expect(apiCalls.map((c) => c.fn)).toEqual(['sendCard']);
    const saved = dbWrites.find((w) => w.op === 'insert.values')?.payload as { messageTs?: string };
    expect(saved?.messageTs).toBe('act-1');
  });

  test('a later step repaints the existing card in place (no new post)', async () => {
    dbResults = [[streamRow({ messageTs: 'act-1', steps: [{ type: 'task_update', id: 'step-0', title: 'A', status: 'in_progress' }] })], []];
    const ok = await relayTurnStep('sess-1', 'Drafting');
    expect(ok).toBe(true);
    expect(apiCalls.map((c) => c.fn)).toEqual(['updateCard']);
  });

  test('drops when no open turn exists', async () => {
    dbResults = [[]];
    expect(await relayTurnStep('sess-x', 'x')).toBe(false);
    expect(apiCalls).toHaveLength(0);
  });
});

describe('relayTurnAnswer', () => {
  test('finalizes into the live card and deletes the turn', async () => {
    dbResults = [
      [streamRow({ messageTs: 'act-1', steps: [{ type: 'task_update', id: 'step-0', title: 'A', status: 'in_progress' }] })],
      [{ sessionId: 'sess-1' }],
      [],
    ];
    const ok = await relayTurnAnswer('sess-1', 'Here is the answer.');
    expect(ok).toBe(true);
    expect(apiCalls.map((c) => c.fn)).toEqual(['updateCard']);
    expect(dbWrites.some((w) => w.op === 'delete')).toBe(true);
  });

  test('loses the finalize race → no render', async () => {
    dbResults = [[streamRow({ messageTs: 'act-1' })], []];
    expect(await relayTurnAnswer('sess-1', 'x')).toBe(false);
    expect(apiCalls).toHaveLength(0);
  });
});

describe('relayTurnEnd', () => {
  test('idle with a live card closes it cleanly', async () => {
    dbResults = [
      [streamRow({ messageTs: 'act-1', steps: [{ type: 'task_update', id: 'step-0', title: 'A', status: 'in_progress' }] })],
      [{ sessionId: 'sess-1' }],
      [],
    ];
    const ok = await relayTurnEnd('sess-1', 'idle');
    expect(ok).toBe(true);
    expect(apiCalls.map((c) => c.fn)).toEqual(['updateCard']);
  });
});
