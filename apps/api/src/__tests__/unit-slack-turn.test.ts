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
  updateBlocks: async (...a: unknown[]) => {
    record('updateBlocks')(...a);
    return true; // chat.update succeeded (real updateBlocks returns a boolean)
  },
  updateMessage: async (...a: unknown[]) => record('updateMessage')(...a),
}));

mock.module('../channels/install-store', () => ({
  loadSlackTokenForProject: async () => 'xoxb-test',
  saveSlackOauthInstall: async () => {},
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
    delete: () => {
      dbWrites.push({ op: 'delete' });
      return makeChain('delete');
    },
  },
  hasDatabase: () => true,
}));

const fakeDb = {
  select: () => makeChain('select'),
  insert: () => makeChain('insert'),
  update: () => makeChain('update'),
  delete: () => {
    dbWrites.push({ op: 'delete' });
    return makeChain('delete');
  },
};

mock.module('../shared/effect', () => ({
  sharedConfig: {
    FRONTEND_URL: 'https://dev.kortix.com',
  },
  sharedDb: fakeDb,
  sharedSupabase: {},
  sharedFetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  sharedSleep: async () => {},
  runSharedTimeout: () => ({}) as never,
  runSharedInterval: () => ({}) as never,
  stopSharedTimer: () => {},
}));

const { finalizeTurn, repaintLivePlan, relayTurnAnswer, relayTurnEnd, relayTurnStep, relayProvisioningFailure } =
  await import('../channels/slack/turn');

function liveHandle(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'C1',
    ts: '11.11',
    token: 'xoxb-test',
    triggerTs: '10.10',
    steps: [
      { type: 'task_update', id: 'step-0', title: 'Reading logs', status: 'in_progress' },
    ],
    expiry: Date.now() + 60_000,
    finalized: false,
    projectId: 'proj-1',
    sessionId: 'sess-1',
    teamId: 'T1',
    originatingEvent: { type: 'app_mention', channel: 'C1', ts: '10.10', user: 'U1' },
    ...overrides,
  } as any;
}

// DB row shape for loadTurn (chat_turn_streams select).
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

describe('finalizeTurn (chat.update only — no streaming)', () => {
  test('silent close completes the last step and renders plan-only; adds nothing', async () => {
    const handle = liveHandle();
    await finalizeTurn(handle, {});

    expect(calls('stopStream').length).toBe(0); // streaming is gone
    const updates = calls('updateBlocks');
    expect(updates.length).toBe(1);
    expect(updates[0]!.args[3]).toBe('Task complete');
    const blocks = updates[0]!.args[4] as Array<{ type: string; tasks?: Array<{ status: string }> }>;
    // silent close invents no answer body; 'context' = the "Open session" footer
    expect(blocks.map((b) => b.type)).toEqual(['plan', 'context']);
    expect(blocks[0]!.tasks![0]!.status).toBe('complete'); // last step closed

    expect(calls('removeReaction').length).toBe(1);
    expect(calls('addReaction').length).toBe(0); // ✅ reserved for a real answer
  });

  test('answer close renders plan + answer section via chat.update and adds ✅', async () => {
    const handle = liveHandle();
    await finalizeTurn(handle, { answer: 'All done.' });

    expect(calls('stopStream').length).toBe(0);
    const updates = calls('updateBlocks');
    expect(updates.length).toBe(1);
    expect(updates[0]!.args[3]).toBe('Task complete');
    const blocks = updates[0]!.args[4] as Array<{ type: string; tasks?: Array<{ status: string }> }>;
    expect(blocks[0]!.type).toBe('plan');
    expect(blocks[0]!.tasks![0]!.status).toBe('complete');
    expect(blocks.map((b) => b.type)).toEqual(['plan', 'section', 'context']);
    expect(calls('addReaction').length).toBe(1);
  });

  test('error close marks the last step error and titles the plan Run failed', async () => {
    const handle = liveHandle();
    await finalizeTurn(handle, { error: '_It broke._' });

    expect(calls('stopStream').length).toBe(0);
    const update = calls('updateBlocks')[0]!;
    expect(update.args[3]).toBe('Run failed');
    const blocks = update.args[4] as Array<{ type: string; tasks?: Array<{ status: string }> }>;
    expect(blocks[0]!.tasks![0]!.status).toBe('error');
    expect(blocks.map((b) => b.type)).toEqual(['plan', 'section', 'context']);
    expect(calls('addReaction').length).toBe(0);
  });

  test('no plan message + an answer → posts the reply fresh in-thread', async () => {
    const handle = liveHandle({ ts: '', steps: [] });
    await finalizeTurn(handle, { answer: 'Quick reply.' });

    expect(calls('updateBlocks').length).toBe(0);
    expect(calls('postMessage').length).toBe(1);
    expect(String(calls('postMessage')[0]!.args[2])).toBe('Quick reply.');
    expect(calls('addReaction').length).toBe(1);
  });

  test('silent close with no plan message leaves the thread untouched (just clears ⏳)', async () => {
    const handle = liveHandle({ ts: '', steps: [] });
    await finalizeTurn(handle, {});

    expect(calls('updateBlocks').length).toBe(0);
    expect(calls('postMessage').length).toBe(0);
    expect(calls('removeReaction').length).toBe(1);
  });
});

describe('repaintLivePlan', () => {
  test('paints the current steps with a working title via chat.update', async () => {
    const handle = liveHandle();
    await repaintLivePlan(handle);
    const update = calls('updateBlocks')[0]!;
    expect(update.args[3]).toBe('Working on it…');
    const blocks = update.args[4] as Array<{ type: string; title: string }>;
    expect(blocks[0]!.title).toBe('Working on it…');
  });
});

describe('relayTurnStep (chat.update model)', () => {
  test('first step creates the plan message (startStream → immediate stopStream → chat.update)', async () => {
    dbResults = [
      [streamRow({ messageTs: null, steps: [] })], // loadTurn → no plan message yet
      [], // saveTurn upsert
    ];

    const ok = await relayTurnStep('sess-1', 'Reading logs');
    expect(ok).toBe(true);
    // Native plan message is opened then immediately closed; never left streaming.
    expect(calls('startStream').length).toBe(1);
    expect(calls('stopStream').length).toBe(1);
    expect(calls('appendStream').length).toBe(0); // the streaming-append path is gone
    expect(calls('updateBlocks').length).toBe(1);
  });

  test('subsequent step appends + repaints via chat.update, never appendStream/startStream', async () => {
    dbResults = [
      [streamRow()], // loadTurn → plan message already exists
      [], // saveTurn upsert
    ];

    const ok = await relayTurnStep('sess-1', 'Next step');
    expect(ok).toBe(true);
    expect(calls('appendStream').length).toBe(0);
    expect(calls('startStream').length).toBe(0);
    const update = calls('updateBlocks')[0]!;
    expect(update.args[3]).toBe('Working on it…');
    const blocks = update.args[4] as Array<{ tasks: Array<{ title: string; status: string }> }>;
    expect(blocks[0]!.tasks.map((t) => t.title)).toEqual(['Reading logs', 'Next step']);
  });
});

describe('expired turn rows', () => {
  test('drops a late answer relay without posting — but clears the stranded ⏳', async () => {
    dbResults = [
      [streamRow({ expiresAt: new Date(Date.now() - 60_000) })], // loadTurn (expired)
      [], // delete expired turn
    ];

    const ok = await relayTurnAnswer('sess-1', 'Late answer.');
    expect(ok).toBe(false);
    expect(dbWrites.map((w) => w.op)).toEqual(['delete']);
    expect(calls('postMessage').length).toBe(0);
    expect(calls('postBlocks').length).toBe(0);
    expect(calls('updateBlocks').length).toBe(0);
    expect(calls('addReaction').length).toBe(0);
    // The expired un-finalized row had a ⏳ on the user's message — reaping it now
    // clears that reaction so it doesn't linger forever.
    expect(calls('removeReaction').length).toBe(1);
  });
});

describe('relayTurnEnd', () => {
  test('idle gracefully closes a turn as Task complete via chat.update', async () => {
    dbResults = [
      [streamRow()], // loadTurn
      [{ sessionId: 'sess-1' }], // claimFinalize
      [], // deleteTurn
    ];

    const ok = await relayTurnEnd('sess-1', 'idle');
    expect(ok).toBe(true);
    expect(calls('stopStream').length).toBe(0);
    expect(calls('updateBlocks')[0]!.args[3]).toBe('Task complete');
    expect(calls('removeReaction').length).toBe(1);
    expect(calls('addReaction').length).toBe(0);
  });

  // The server no longer re-checks the relayed opencode id against the DB pin —
  // the sandbox filters subagents by parentID before relaying, and a stale-pin
  // re-check here is exactly what used to drop a real turn's idle and spin the ⏳
  // forever. So a relayed root idle ALWAYS finalizes, with no pin lookup.
  test('finalizes unconditionally — no pin lookup gates the close', async () => {
    dbResults = [
      [streamRow()], // loadTurn
      [{ sessionId: 'sess-1' }], // claimFinalize
      [], // deleteTurn
    ];

    const ok = await relayTurnEnd('sess-1', 'idle');
    expect(ok).toBe(true);
    expect(calls('removeReaction').length).toBe(1);
  });

  test('idle on a turn with no plan message + no steps just clears ⏳', async () => {
    dbResults = [
      [streamRow({ messageTs: null, steps: [] })], // loadTurn
      [{ sessionId: 'sess-1' }], // claimFinalize
      [], // deleteTurn
    ];

    const ok = await relayTurnEnd('sess-1', 'idle');
    expect(ok).toBe(true);
    expect(calls('updateBlocks').length).toBe(0);
    expect(calls('postMessage').length).toBe(0);
    expect(calls('removeReaction').length).toBe(1);
  });

  test('error close on a turn with no plan message posts failure copy + session footer', async () => {
    dbResults = [
      [streamRow({ messageTs: null, steps: [] })], // loadTurn
      [{ sessionId: 'sess-1' }], // claimFinalize
      [], // deleteTurn
    ];

    const ok = await relayTurnEnd('sess-1', 'error');
    expect(ok).toBe(true);
    // No plan stream → fresh post, now as blocks so it carries an "Open session" footer.
    expect(calls('postMessage').length).toBe(0);
    const posted = calls('postBlocks')[0]!;
    expect(String(posted.args[2])).toContain('error');
    const blocks = posted.args[3] as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['section', 'context']);
    expect(calls('addReaction').length).toBe(0);
  });

  test('out-of-credits error renders the credits copy + "Out of credits" title', async () => {
    dbResults = [
      [streamRow()], // loadTurn (has a plan message)
      [{ sessionId: 'sess-1' }], // claimFinalize
      [], // deleteTurn
    ];

    const ok = await relayTurnEnd('sess-1', 'error', {
      name: 'APIError',
      statusCode: 402,
      message: 'Payment Required: Insufficient credits. Balance: $-0.06',
    });
    expect(ok).toBe(true);
    const update = calls('updateBlocks')[0]!;
    expect(update.args[3]).toBe('Out of credits');
    const blocks = update.args[4] as Array<{ type: string; text?: { text: string } }>;
    const section = blocks.find((b) => b.type === 'section');
    expect(section?.text?.text.toLowerCase()).toContain('out of credits');
    expect(section?.text?.text).toContain('$-0.06');
    expect(calls('addReaction').length).toBe(0); // ✅ is reserved for real answers
  });

  test('usage-limit error renders the rate-limit copy + "Usage limit reached" title', async () => {
    dbResults = [
      [streamRow()], // loadTurn
      [{ sessionId: 'sess-1' }], // claimFinalize
      [], // deleteTurn
    ];

    const ok = await relayTurnEnd('sess-1', 'error', { statusCode: 429, message: 'Too Many Requests' });
    expect(ok).toBe(true);
    expect(calls('updateBlocks')[0]!.args[3]).toBe('Usage limit reached');
  });

  test('aborted run closes quietly — retitled, no failure body, no ✅', async () => {
    dbResults = [
      [streamRow()], // loadTurn
      [{ sessionId: 'sess-1' }], // claimFinalize
      [], // deleteTurn
    ];

    const ok = await relayTurnEnd('sess-1', 'error', { name: 'MessageAbortedError', message: 'aborted' });
    expect(ok).toBe(true);
    const update = calls('updateBlocks')[0]!;
    expect(update.args[3]).toBe('Run stopped');
    const blocks = update.args[4] as Array<{ type: string; tasks?: Array<{ status: string }> }>;
    // No failure section — just the (re-titled) plan + the footer.
    expect(blocks.map((b) => b.type)).toEqual(['plan', 'context']);
    expect(blocks[0]!.tasks![0]!.status).toBe('complete'); // not 'error'
    expect(calls('addReaction').length).toBe(0);
  });
});

describe('relayProvisioningFailure', () => {
  test('posts the platform reason AS-IS (no re-classification) with a "Couldn\'t start" title', async () => {
    dbResults = [
      [streamRow()], // loadTurn — turn row was saved at session-create time
      [{ sessionId: 'sess-1' }], // claimFinalize
      [], // deleteTurn
    ];

    const ok = await relayProvisioningFailure('sess-1', 'The sandbox provider is at capacity right now. Try again in a minute.');
    expect(ok).toBe(true);
    const update = calls('updateBlocks')[0]!;
    expect(update.args[3]).toBe("Couldn't start");
    const blocks = update.args[4] as Array<{ type: string; text?: { text: string } }>;
    const section = blocks.find((b) => b.type === 'section');
    expect(section?.text?.text).toContain('at capacity');
    expect(calls('removeReaction').length).toBe(1); // ⏳ cleared
    expect(calls('addReaction').length).toBe(0); // not a success
  });

  test('no open turn (non-Slack session) → no-op', async () => {
    dbResults = [[]]; // loadTurn finds nothing
    const ok = await relayProvisioningFailure('sess-unknown', 'whatever');
    expect(ok).toBe(false);
    expect(calls('updateBlocks').length).toBe(0);
    expect(calls('postMessage').length).toBe(0);
  });
});
