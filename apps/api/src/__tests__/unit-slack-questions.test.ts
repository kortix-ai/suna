import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Covers the interactive `question` tool path in Slack: options render as
// clickable buttons (buildQuestionBlocks via postQuestion), and a button click
// resumes the thread's session with the chosen answer (handleBlockAction →
// spawnAgentTurn). Before this, options were a dead bullet list and the only way
// to answer was a free-form reply — the "question thing doesn't work" bug.

// ─── Slack API spy ────────────────────────────────────────────────────────────
type Call = { fn: string; args: unknown[] };
let slackCalls: Call[] = [];
const record = (fn: string) => (...args: unknown[]) => {
  slackCalls.push({ fn, args });
};

let postBlocksResult: string | null = '99.99';
let postMessageResult: string | null = '88.88';
mock.module('../channels/slack-api', () => ({
  openDmChannel: async () => null,
  postEphemeral: async (...a: unknown[]) => record('postEphemeral')(...a),
  postBlocks: async (...a: unknown[]) => {
    record('postBlocks')(...a);
    return postBlocksResult;
  },
  postMessage: async (...a: unknown[]) => {
    record('postMessage')(...a);
    return postMessageResult;
  },
  updateMessage: async (...a: unknown[]) => record('updateMessage')(...a),
}));

// ─── turn.ts (consumed by questions.ts) ───────────────────────────────────────
let activeTurn: Record<string, unknown> | null = null;
mock.module('../channels/slack/turn', () => ({
  loadTurn: async () => activeTurn,
  finalizeTurn: async (...a: unknown[]) => record('finalizeTurn')(...a),
  deleteTurn: async (...a: unknown[]) => record('deleteTurn')(...a),
}));

// ─── dispatch.ts (consumed by interactivity.ts) ───────────────────────────────
let spawnArgs: unknown[] | null = null;
mock.module('../channels/slack/dispatch', () => ({
  spawnAgentTurn: async (...a: unknown[]) => {
    spawnArgs = a;
  },
  dispatchSlackEvent: async () => {},
  pendingPickers: new Map(),
}));

mock.module('../channels/install-store', () => ({
  loadSlackTokenForProject: async () => 'xoxb-test',
  saveSlackOauthInstall: async () => {},
}));

// ─── DB mock (FIFO) ───────────────────────────────────────────────────────────
let dbResults: unknown[][] = [];
function makeChain(): any {
  const chain: any = {};
  for (const m of ['from', 'where', 'limit', 'values', 'set', 'onConflictDoUpdate', 'returning']) {
    chain[m] = () => chain;
  }
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(dbResults.shift() ?? []));
  return chain;
}
mock.module('../shared/db', () => ({
  db: { select: () => makeChain(), insert: () => makeChain(), update: () => makeChain(), delete: () => makeChain() },
  hasDatabase: () => true,
}));

// No real network for respondViaUrl's fetch.
globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;

const { postQuestion } = await import('../channels/slack/questions');
const { handleBlockAction } = await import('../channels/slack/interactivity');

beforeEach(() => {
  slackCalls = [];
  dbResults = [];
  spawnArgs = null;
  postBlocksResult = '99.99';
  postMessageResult = '88.88';
  activeTurn = { token: 'xoxb-test', channel: 'C1', triggerTs: '10.10', sessionId: 'sess-1' };
});

describe('postQuestion → interactive buttons', () => {
  test('each option becomes a clickable button carrying {q,a}; descriptions surfaced', async () => {
    const res = await postQuestion('sess-1', [
      {
        question: 'What asset should I make?',
        options: [
          { label: 'Blog post', description: 'Long-form writeup' },
          { label: 'Tweet thread' },
        ],
      },
    ] as any);

    expect(res.ok).toBe(true);
    // Sentinel returned so the agent ends the turn instead of blocking.
    expect(res.answers?.[0]?.[0]).toContain('Posted to the Slack thread');

    const post = slackCalls.find((c) => c.fn === 'postBlocks');
    expect(post).toBeTruthy();
    const blocks = post!.args[3] as Array<Record<string, any>>;

    const actions = blocks.find((b) => b.type === 'actions');
    expect(actions).toBeTruthy();
    expect(actions!.elements).toHaveLength(2);

    const [b0, b1] = actions!.elements as Array<Record<string, any>>;
    expect(b0.type).toBe('button');
    expect(b0.action_id).toBe('qa_0_0');
    expect(b0.text.text).toBe('Blog post');
    expect(JSON.parse(b0.value)).toEqual({ q: 'What asset should I make?', a: 'Blog post' });
    expect(b1.action_id).toBe('qa_0_1');
    expect(JSON.parse(b1.value).a).toBe('Tweet thread');

    // The described option is surfaced (a button shows only its label).
    const described = blocks.some(
      (b) => b.type === 'section' && typeof b.text?.text === 'string' && b.text.text.includes('Long-form writeup'),
    );
    expect(described).toBe(true);
  });

  test('multiple questions get distinct action_id prefixes (qa_0_*, qa_1_*)', async () => {
    await postQuestion('sess-1', [
      { question: 'Q1?', options: [{ label: 'A' }] },
      { question: 'Q2?', options: [{ label: 'B' }] },
    ] as any);

    const blocks = slackCalls.find((c) => c.fn === 'postBlocks')!.args[3] as Array<Record<string, any>>;
    const ids = blocks
      .filter((b) => b.type === 'actions')
      .flatMap((b) => (b.elements as Array<Record<string, any>>).map((e) => e.action_id));
    expect(ids).toEqual(['qa_0_0', 'qa_1_0']);
  });

  test('no live turn → ok:false (renders nothing; the sandbox auto-answers locally)', async () => {
    activeTurn = null;
    const res = await postQuestion('sess-1', [{ question: 'Q?', options: [{ label: 'A' }] }] as any);
    expect(res.ok).toBe(false);
    expect(slackCalls.find((c) => c.fn === 'postBlocks')).toBeUndefined();
  });

  test('block render rejected → plain-text fallback so the question is not lost', async () => {
    postBlocksResult = null; // Slack rejected the blocks (e.g. invalid_blocks)
    const res = await postQuestion('sess-1', [
      { question: 'Ship it?', options: [{ label: 'Yes', description: 'go now' }, { label: 'No' }] },
    ] as any);

    // Still ok (the question reached the thread) so the agent ends cleanly.
    expect(res.ok).toBe(true);
    const plain = slackCalls.find((c) => c.fn === 'postMessage');
    expect(plain).toBeTruthy();
    const text = String(plain!.args[2]);
    expect(text).toContain('Ship it?');
    expect(text).toContain('Yes');
    expect(text).toContain('Reply in this thread');
  });

  test('both block AND plain renders fail → ok:false', async () => {
    postBlocksResult = null;
    postMessageResult = null;
    const res = await postQuestion('sess-1', [{ question: 'Q?', options: [{ label: 'A' }] }] as any);
    expect(res.ok).toBe(false);
  });
});

describe('handleBlockAction → question answer click resumes the session', () => {
  test('a qa_ click spawns a follow-up turn carrying the chosen answer', async () => {
    dbResults = [[{ projectId: 'proj-1' }]]; // chat_threads lookup

    await handleBlockAction({
      type: 'block_actions',
      team: { id: 'T1' },
      channel: { id: 'C1' },
      user: { id: 'U1' },
      message: { ts: '50.0', thread_ts: '10.0' },
      response_url: 'https://hooks.slack.test/x',
      actions: [
        {
          action_id: 'qa_0_1',
          text: { type: 'plain_text', text: 'Blog post' },
          value: JSON.stringify({ q: 'What asset should I make?', a: 'Blog post' }),
        },
      ],
    } as any);

    expect(spawnArgs).toBeTruthy();
    expect(spawnArgs![0]).toBe('proj-1');
    const event = spawnArgs![2] as { text: string; thread_ts: string };
    expect(event.thread_ts).toBe('10.0');
    expect(event.text).toContain('Blog post');
    expect(event.text).toContain('What asset should I make?');
  });

  test('unknown thread (no mapping) does not spawn a turn', async () => {
    dbResults = [[]]; // no chat_threads row

    await handleBlockAction({
      type: 'block_actions',
      team: { id: 'T1' },
      channel: { id: 'C1' },
      user: { id: 'U1' },
      message: { ts: '50.0', thread_ts: '10.0' },
      response_url: 'https://hooks.slack.test/x',
      actions: [{ action_id: 'qa_0_0', text: { type: 'plain_text', text: 'A' }, value: '{"q":"Q?","a":"A"}' }],
    } as any);

    expect(spawnArgs).toBeNull();
  });
});
