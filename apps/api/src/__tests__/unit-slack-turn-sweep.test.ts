import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Thirty minutes without a `slack step` is not proof of a dead run: a build, a
// test suite, or a subagent posts nothing while it works. The Slack sweep
// closed the thread as "Run timed out" AND aborted the runtime turn on that
// silence alone, killing healthy work mid-run.

const calls: Array<{ fn: string; args: unknown[] }> = [];
const rec = (fn: string) => (...args: unknown[]) => {
  calls.push({ fn, args });
  if (fn === 'updateBlocks') return Promise.resolve(true);
  if (fn === 'postMessage' || fn === 'postBlocks' || fn === 'startStream') return Promise.resolve('ts.posted');
  return Promise.resolve();
};

mock.module('../channels/slack-api', () => ({
  addReaction: rec('addReaction'),
  removeReaction: rec('removeReaction'),
  joinChannel: rec('joinChannel'),
  postMessage: rec('postMessage'),
  postBlocks: rec('postBlocks'),
  deleteMessage: rec('deleteMessage'),
  startStream: rec('startStream'),
  appendStream: rec('appendStream'),
  stopStream: rec('stopStream'),
  updateBlocks: rec('updateBlocks'),
}));

mock.module('../channels/install-store', () => ({
  loadSlackTokenForProject: async () => 'xoxb-test',
}));

let dbResults: unknown[][] = [];
let dbWrites: Array<{ op: string; payload?: unknown }> = [];

function makeChain(op: string): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'onConflictDoUpdate', 'onConflictDoNothing', 'returning']) chain[m] = () => chain;
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

let runtimeLive: boolean | 'unreadable' = false;
mock.module('../projects/session-lifecycle/inbox-admission', () => ({
  sessionHoldsLiveTurn: async () => {
    if (runtimeLive === 'unreadable') throw new Error('db down');
    return runtimeLive;
  },
}));
const aborted: string[] = [];
mock.module('../projects/session-lifecycle/abort-runtime-turn', () => ({
  abortRuntimeTurn: async (id: string) => {
    aborted.push(id);
    return true;
  },
}));

const { sweepStaleSlackTurns } = await import('../channels/slack/turn');

function staleRow(over: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    projectId: 'proj-1',
    teamId: 'T1',
    channel: 'C1',
    triggerTs: '100.1',
    messageTs: 'plan.ts',
    finalized: false,
    steps: [{ type: 'task_update', id: 'step-0', title: 'On it', status: 'in_progress' }],
    originatingEvent: { channel: 'C1', ts: '100.1', user: 'U1', thread_ts: '100.0' },
    channelRef: null,
    expiresAt: new Date(Date.now() - 16 * 60 * 1000),
    updatedAt: new Date(Date.now() - 31 * 60 * 1000),
    ...over,
  };
}

beforeEach(() => {
  calls.length = 0;
  dbWrites = [];
  dbResults = [];
  runtimeLive = false;
  aborted.length = 0;
});

describe('the Slack stale-turn sweep', () => {
  test('a run the runtime still holds keeps its thread and is not aborted', async () => {
    runtimeLive = true;
    // The stale open turns, then the dedup GC.
    dbResults = [[staleRow()], []];

    await sweepStaleSlackTurns();

    expect(calls).toHaveLength(0);
    expect(aborted).toEqual([]);
    // Touched, so it is not reconsidered on every tick.
    const touch = dbWrites.find((w) => w.op === 'update.set');
    expect(touch).toBeDefined();
    expect(Object.keys(touch!.payload as object)).toEqual(['updatedAt']);
    // Only the dedup GC deletes; the live turn's row stays.
    expect(dbWrites.filter((w) => w.op === 'delete')).toHaveLength(1);
  });

  test('a run the runtime no longer holds is closed, its row deleted, and its runtime turn aborted', async () => {
    runtimeLive = false;
    // Stale rows, the claimFinalize winner, then deleteTurn + dedup GC.
    dbResults = [[staleRow()], [{ sessionId: 'sess-1' }], [], []];

    await sweepStaleSlackTurns();

    const upd = calls.find((c) => c.fn === 'updateBlocks');
    expect(upd).toBeDefined();
    expect(upd!.args[3]).toBe('Run failed');
    expect(JSON.stringify(upd!.args[4])).toContain('This run ended without a reply');
    // No false claim about credits: the sweep cannot know why the run ended.
    expect(JSON.stringify(upd!.args[4])).not.toContain('credits');
    expect(calls.some((c) => c.fn === 'removeReaction')).toBe(true);
    expect(dbWrites.filter((w) => w.op === 'delete')).toHaveLength(2);
    expect(aborted).toEqual(['sess-1']);
  });

  test('a sweep that cannot read the runtime still closes the thread', async () => {
    // Unknown counts as no: a thread left open forever swallows the conversation.
    runtimeLive = 'unreadable';
    dbResults = [[staleRow()], [{ sessionId: 'sess-1' }], [], []];

    await sweepStaleSlackTurns();

    expect(calls.some((c) => c.fn === 'updateBlocks')).toBe(true);
    expect(aborted).toEqual(['sess-1']);
  });

  test('a turn another channel owns is left to that channel', async () => {
    runtimeLive = false;
    dbResults = [[staleRow({ channelRef: { platform: 'teams' } })], []];

    await sweepStaleSlackTurns();

    expect(calls).toHaveLength(0);
    expect(aborted).toEqual([]);
  });
});
