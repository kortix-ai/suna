import { afterEach, describe, expect, mock, test } from 'bun:test';

// Capture every slack-api side effect so we can assert exactly what a turn
// finalization posts to Slack. finalizeTurn only talks to slack-api (never the
// DB), so mocking this module is enough to unit-test its behavior.
const calls: Array<{ fn: string; args: unknown[] }> = [];
const rec = (fn: string) => (...args: unknown[]) => {
  calls.push({ fn, args });
  // startStream/postMessage/postBlocks return a ts; others return void.
  if (fn === 'startStream' || fn === 'postMessage' || fn === 'postBlocks') return Promise.resolve('ts.posted');
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

const { finalizeTurn } = await import('../channels/slack/turn');
import type { LiveTurn } from '../channels/slack/types';

function makeHandle(over: Partial<LiveTurn> = {}): LiveTurn {
  return {
    channel: 'C1',
    ts: '',
    token: 'xoxb-test',
    triggerTs: '100.1',
    steps: [],
    expiry: Date.now() + 60_000,
    finalized: false,
    projectId: 'p1',
    sessionId: 's1',
    teamId: 'T1',
    originatingEvent: { channel: 'C1', ts: '100.1', user: 'U1', thread_ts: '100.0' } as never,
    ...over,
  };
}

const fns = () => calls.map((c) => c.fn);
afterEach(() => {
  calls.length = 0;
});

describe('finalizeTurn — silent turn (the stuck "On it…" fix)', () => {
  test('bare handle + no content posts NOTHING to the thread', async () => {
    await finalizeTurn(makeHandle(), {});
    // No message, no blocks, no stream — only the working reaction is cleared.
    expect(fns()).not.toContain('postMessage');
    expect(fns()).not.toContain('postBlocks');
    expect(fns()).not.toContain('stopStream');
    expect(fns()).toContain('removeReaction');
  });

  test('bare handle + answer posts the reply + check reaction', async () => {
    await finalizeTurn(makeHandle(), { answer: 'here you go' });
    const post = calls.find((c) => c.fn === 'postMessage');
    expect(post).toBeDefined();
    expect(post!.args[2]).toBe('here you go');
    expect(fns()).toContain('removeReaction');
    // success reaction only on a real answer
    expect(calls.some((c) => c.fn === 'addReaction' && c.args[3] === 'white_check_mark')).toBe(true);
  });

  test('plan handle + no content closes the plan via chat.update, WITHOUT a filler message', async () => {
    const handle = makeHandle({
      ts: 'plan.ts',
      steps: [{ type: 'task_update', id: 'step-0', title: 'Working', status: 'in_progress' }],
    });
    await finalizeTurn(handle, {});
    expect(fns()).not.toContain('stopStream'); // no streaming anymore
    const upd = calls.find((c) => c.fn === 'updateBlocks')!;
    expect(upd).toBeDefined();
    expect(upd.args[3]).toBe('Task complete');
    const blocks = upd.args[4] as Array<{ type: string; tasks?: Array<{ status: string }> }>;
    expect(blocks.map((b) => b.type)).toEqual(['plan']); // no "_Done._" filler section
    expect(blocks[0]!.tasks![0]!.status).toBe('complete'); // last step closed
  });

  test('plan handle + error closes the plan via chat.update as Run failed with the message', async () => {
    const handle = makeHandle({
      ts: 'plan.ts',
      steps: [{ type: 'task_update', id: 'step-0', title: 'Working', status: 'in_progress' }],
    });
    await finalizeTurn(handle, { error: 'boom' });
    expect(fns()).not.toContain('stopStream');
    const upd = calls.find((c) => c.fn === 'updateBlocks')!;
    expect(upd.args[3]).toBe('Run failed');
    const blocks = upd.args[4] as Array<{ type: string; tasks?: Array<{ status: string }> }>;
    expect(blocks[0]!.tasks![0]!.status).toBe('error');
    expect(blocks.map((b) => b.type)).toEqual(['plan', 'section']); // error rendered as a section
    // an error is not a success — no check reaction
    expect(calls.some((c) => c.fn === 'addReaction' && c.args[3] === 'white_check_mark')).toBe(false);
  });

  test('plan handle + answer renders the answer INTO the plan message (not a new post) + ✅', async () => {
    const handle = makeHandle({
      ts: 'plan.ts',
      steps: [{ type: 'task_update', id: 'step-0', title: 'Working', status: 'in_progress' }],
    });
    await finalizeTurn(handle, { answer: 'done!' });
    expect(fns()).not.toContain('postMessage'); // answer goes into the plan via chat.update
    const upd = calls.find((c) => c.fn === 'updateBlocks')!;
    expect(upd.args[3]).toBe('Task complete');
    const blocks = upd.args[4] as Array<{ type: string }>;
    expect(blocks.map((b) => b.type)).toEqual(['plan', 'section']);
    expect(calls.some((c) => c.fn === 'addReaction' && c.args[3] === 'white_check_mark')).toBe(true);
  });

  test('already finalized is a no-op', async () => {
    await finalizeTurn(makeHandle({ finalized: true }), { answer: 'ignored' });
    expect(calls.length).toBe(0);
  });
});
