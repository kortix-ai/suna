import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ─── Slack API spy ────────────────────────────────────────────────────────────
// Every Slack call the stream lifecycle can make, recorded for assertions.
type Call = { fn: string; args: unknown[] };
let slackCalls: Call[] = [];
let appendStreamResult: { ok: boolean; error?: string } = { ok: true };

const record = (fn: string) => (...args: unknown[]) => {
  slackCalls.push({ fn, args });
};

mock.module('../channels/slack-api', () => ({
  addReaction: async (...a: unknown[]) => record('addReaction')(...a),
  appendStream: async (...a: unknown[]) => {
    record('appendStream')(...a);
    return appendStreamResult;
  },
  deleteMessage: async (...a: unknown[]) => record('deleteMessage')(...a),
  joinChannel: async (...a: unknown[]) => {
    record('joinChannel')(...a);
    return true;
  },
  postBlocks: async (...a: unknown[]) => {
    record('postBlocks')(...a);
    return '99.99';
  },
  postMessage: async (...a: unknown[]) => {
    record('postMessage')(...a);
    return '99.99';
  },
  removeReaction: async (...a: unknown[]) => record('removeReaction')(...a),
  startStream: async (...a: unknown[]) => {
    record('startStream')(...a);
    return '11.11';
  },
  stopStream: async (...a: unknown[]) => record('stopStream')(...a),
  updateBlocks: async (...a: unknown[]) => record('updateBlocks')(...a),
  updateMessage: async (...a: unknown[]) => record('updateMessage')(...a),
}));

mock.module('../channels/install-store', () => ({
  loadSlackTokenForProject: async () => 'xoxb-test',
}));

mock.module('../channels/slack/interactivity', () => ({
  respondViaUrl: async () => {},
}));

mock.module('../channels/slack/app', () => ({
  STREAM_TTL_MS: 15 * 60 * 1000,
  ASK_TTL_MS: 15 * 60 * 1000,
  WORKING_EMOJI: 'hourglass_flowing_sand',
  FIVE_MINUTES: 300,
  EVENT_DEDUPE_TTL_MS: 5 * 60 * 1000,
  PICKER_TTL_MS: 60 * 60 * 1000,
}));

// ─── DB mock ──────────────────────────────────────────────────────────────────
// One FIFO of results; every awaited query chain pops the next entry. Tests
// enqueue results in the exact order the code under test issues queries.
let dbResults: unknown[][] = [];
let dbWrites: Array<{ op: string; payload?: unknown }> = [];

function makeChain(op: string): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'onConflictDoUpdate', 'returning']) {
    chain[m] = () => chain;
  }
  chain.values = (payload: unknown) => {
    dbWrites.push({ op: `${op}.values`, payload });
    return chain;
  };
  chain.set = (payload: unknown) => {
    dbWrites.push({ op: `${op}.set`, payload });
    return chain;
  };
  chain.then = (resolve: (rows: unknown[]) => unknown, reject?: (err: unknown) => unknown) => {
    void reject;
    return Promise.resolve(resolve(dbResults.shift() ?? []));
  };
  return chain;
}

mock.module('../shared/db', () => ({
  db: {
    select: () => makeChain('select'),
    insert: () => makeChain('insert'),
    update: () => makeChain('update'),
    delete: () => makeChain('delete'),
  },
  hasDatabase: () => true,
}));

const { finalizeStream, isDeadStream, markStreamDead, repaintLivePlan } = await import(
  '../channels/slack/streams'
);
const { relayTurnEnd, relayTurnStep } = await import('../channels/slack/questions');

function liveHandle(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'C1',
    ts: '11.11',
    token: 'xoxb-test',
    triggerTs: '10.10',
    steps: [
      { type: 'task_update', id: 'step-0', title: 'Reading logs', status: 'in_progress' },
    ],
    streaming: true,
    placeholderActive: false,
    expiry: Date.now() + 60_000,
    finalized: false,
    projectId: 'proj-1',
    sessionId: 'sess-1',
    teamId: 'T1',
    originatingEvent: { type: 'app_mention', channel: 'C1', ts: '10.10', user: 'U1' },
    ...overrides,
  } as any;
}

// DB row shape for loadStream (chat_turn_streams select).
function streamRow(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'sess-1',
    projectId: 'proj-1',
    teamId: 'T1',
    channel: 'C1',
    triggerTs: '10.10',
    messageTs: '11.11',
    streaming: true,
    placeholderActive: false,
    finalized: false,
    steps: [
      { type: 'task_update', id: 'step-0', title: 'Reading logs', status: 'in_progress' },
    ],
    originatingEvent: { type: 'app_mention', channel: 'C1', ts: '10.10', user: 'U1' },
    expiresAt: new Date(Date.now() + 60_000),
    updatedAt: new Date(),
    ...overrides,
  };
}

const calls = (fn: string) => slackCalls.filter((c) => c.fn === fn);

beforeEach(() => {
  slackCalls = [];
  dbResults = [];
  dbWrites = [];
  appendStreamResult = { ok: true };
});

describe('finalizeStream', () => {
  test('silent close completes the last step, skips the answer chunk, adds ✅', async () => {
    const handle = liveHandle();
    await finalizeStream(handle, {});

    const stops = calls('stopStream');
    expect(stops.length).toBe(1);
    const chunks = stops[0]!.args[3] as Array<Record<string, unknown>>;
    expect(chunks).toEqual([
      { type: 'task_update', id: 'step-0', title: 'Reading logs', status: 'complete' },
    ]);

    const updates = calls('updateBlocks');
    expect(updates.length).toBe(1);
    expect(updates[0]!.args[3]).toBe('Task complete');
    const blocks = updates[0]!.args[4] as Array<{ type: string }>;
    // Plan only — a silent close must not invent an answer body.
    expect(blocks.map((b) => b.type)).toEqual(['plan']);

    expect(calls('removeReaction').length).toBe(1);
    // ✅ is reserved for a real answer — a silent close leaves no trace.
    expect(calls('addReaction').length).toBe(0);
  });

  test('dead stream close skips stopStream but repaints via chat.update', async () => {
    const handle = liveHandle({ streaming: false });
    expect(isDeadStream(handle)).toBe(true);

    await finalizeStream(handle, { answer: 'All done.' });

    expect(calls('stopStream').length).toBe(0);
    const updates = calls('updateBlocks');
    expect(updates.length).toBe(1);
    expect(updates[0]!.args[3]).toBe('Task complete');
    const blocks = updates[0]!.args[4] as Array<{ type: string; tasks?: Array<{ status: string }> }>;
    expect(blocks[0]!.type).toBe('plan');
    expect(blocks[0]!.tasks![0]!.status).toBe('complete');
    expect(blocks.map((b) => b.type)).toEqual(['plan', 'section']);
  });

  test('error close marks the last step error and titles the plan Run failed', async () => {
    const handle = liveHandle();
    await finalizeStream(handle, { error: '_It broke._' });

    const chunks = calls('stopStream')[0]!.args[3] as Array<{ type: string; status?: string; text?: string }>;
    expect(chunks[0]!.status).toBe('error');
    expect(chunks[1]).toEqual({ type: 'markdown_text', text: '_It broke._' });
    expect(calls('updateBlocks')[0]!.args[3]).toBe('Run failed');
    expect(calls('addReaction').length).toBe(0);
  });
});

describe('markStreamDead / isDeadStream', () => {
  test('placeholder and fresh handles are not dead; marked handles are', () => {
    const placeholder = liveHandle({ streaming: false, placeholderActive: true });
    expect(isDeadStream(placeholder)).toBe(false);

    const handle = liveHandle();
    expect(isDeadStream(handle)).toBe(false);
    markStreamDead(handle);
    expect(isDeadStream(handle)).toBe(true);
  });
});

describe('repaintLivePlan', () => {
  test('paints the current steps with a working title', async () => {
    const handle = liveHandle();
    await repaintLivePlan(handle);
    const update = calls('updateBlocks')[0]!;
    expect(update.args[3]).toBe('Working on it…');
    const blocks = update.args[4] as Array<{ type: string; title: string }>;
    expect(blocks[0]!.title).toBe('Working on it…');
  });
});

describe('relayTurnStep append failure', () => {
  test('falls back to repaint mode when Slack already completed the stream', async () => {
    appendStreamResult = { ok: false, error: 'message_not_streaming' };
    dbResults = [
      [streamRow()], // loadStream
      [], // saveStream upsert
    ];

    const ok = await relayTurnStep('sess-1', 'Next step');
    expect(ok).toBe(true);

    // The failed append must trigger a chat.update repaint…
    expect(calls('appendStream').length).toBe(1);
    const update = calls('updateBlocks')[0]!;
    expect(update.args[3]).toBe('Working on it…');
    const blocks = update.args[4] as Array<{ tasks: Array<{ title: string; status: string }> }>;
    expect(blocks[0]!.tasks.map((t) => t.title)).toEqual(['Reading logs', 'Next step']);

    // …and the row must be saved in dead-stream mode so later steps repaint too.
    const saved = dbWrites.find((w) => w.op === 'insert.values')?.payload as
      | { streaming: boolean; placeholderActive: boolean }
      | undefined;
    expect(saved?.streaming).toBe(false);
    expect(saved?.placeholderActive).toBe(false);
  });

  test('dead-stream rows repaint directly without trying to append', async () => {
    dbResults = [
      [streamRow({ streaming: false })], // loadStream → dead-stream row
      [], // saveStream upsert
    ];

    const ok = await relayTurnStep('sess-1', 'Another step');
    expect(ok).toBe(true);
    expect(calls('appendStream').length).toBe(0);
    expect(calls('startStream').length).toBe(0);
    expect(calls('updateBlocks')[0]!.args[3]).toBe('Working on it…');
  });
});

describe('relayTurnEnd', () => {
  test('idle gracefully closes a streaming turn as Task complete', async () => {
    dbResults = [
      [streamRow()], // loadStream
      [{ pinned: 'oc-root' }], // canonical pin lookup
      [{ sessionId: 'sess-1' }], // claimFinalize
      [], // deleteStream
    ];

    const ok = await relayTurnEnd('sess-1', 'idle', 'oc-root');
    expect(ok).toBe(true);
    expect(calls('updateBlocks')[0]!.args[3]).toBe('Task complete');
    // Silent close — the working reaction clears, nothing else is added.
    expect(calls('removeReaction').length).toBe(1);
    expect(calls('addReaction').length).toBe(0);
  });

  test('a subagent session cannot close the stream', async () => {
    dbResults = [
      [streamRow()], // loadStream
      [{ pinned: 'oc-root' }], // pin lookup — mismatch
    ];

    const ok = await relayTurnEnd('sess-1', 'idle', 'oc-subagent');
    expect(ok).toBe(false);
    expect(slackCalls.length).toBe(0);
  });

  test('idle on a silent turn (legacy placeholder, no steps) just cleans up', async () => {
    dbResults = [
      [streamRow({ streaming: false, placeholderActive: true, steps: [] })], // loadStream
      [{ pinned: 'oc-root' }], // pin lookup
      [{ sessionId: 'sess-1' }], // claimFinalize
      [], // deleteStream
    ];

    const ok = await relayTurnEnd('sess-1', 'idle', 'oc-root');
    expect(ok).toBe(true);
    // Legacy placeholder removed, nothing posted in its place.
    expect(calls('deleteMessage').length).toBe(1);
    expect(calls('postMessage').length).toBe(0);
    expect(calls('removeReaction').length).toBe(1);
  });

  test('error closes even a placeholder turn with failure copy', async () => {
    dbResults = [
      [streamRow({ streaming: false, placeholderActive: true, steps: [] })], // loadStream
      [{ pinned: 'oc-root' }], // pin lookup
      [{ sessionId: 'sess-1' }], // claimFinalize
      [], // deleteStream
    ];

    const ok = await relayTurnEnd('sess-1', 'error', 'oc-root');
    expect(ok).toBe(true);
    expect(calls('deleteMessage').length).toBe(1); // placeholder removed
    const posted = calls('postMessage')[0]!;
    expect(String(posted.args[2])).toContain('error');
    expect(calls('addReaction').length).toBe(0);
  });
});
