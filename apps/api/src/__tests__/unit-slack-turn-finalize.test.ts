import { afterEach, describe, expect, mock, test } from 'bun:test';

// Capture every slack-api side effect so we can assert exactly what a turn
// finalization posts to Slack. finalizeStream only talks to slack-api (never the
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

const { finalizeStream } = await import('../channels/slack/streams');
import type { TurnStream } from '../channels/slack/types';

function makeHandle(over: Partial<TurnStream> = {}): TurnStream {
  return {
    channel: 'C1',
    ts: '',
    token: 'xoxb-test',
    triggerTs: '100.1',
    steps: [],
    streaming: false,
    placeholderActive: false,
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

describe('finalizeStream — silent turn (the stuck "On it…" fix)', () => {
  test('bare handle + no content posts NOTHING to the thread', async () => {
    await finalizeStream(makeHandle(), {});
    // No message, no blocks, no stream — only the working reaction is cleared.
    expect(fns()).not.toContain('postMessage');
    expect(fns()).not.toContain('postBlocks');
    expect(fns()).not.toContain('stopStream');
    expect(fns()).toContain('removeReaction');
  });

  test('bare handle + answer posts the reply + check reaction', async () => {
    await finalizeStream(makeHandle(), { answer: 'here you go' });
    const post = calls.find((c) => c.fn === 'postMessage');
    expect(post).toBeDefined();
    expect(post!.args[2]).toBe('here you go');
    expect(fns()).toContain('removeReaction');
    // success reaction only on a real answer
    expect(calls.some((c) => c.fn === 'addReaction' && c.args[3] === 'white_check_mark')).toBe(true);
  });

  test('streaming handle + no content closes the plan WITHOUT a filler message', async () => {
    const handle = makeHandle({
      streaming: true,
      ts: 'stream.ts',
      steps: [{ type: 'task_update', id: 'step-0', title: 'Working', status: 'in_progress' }],
    });
    await finalizeStream(handle, {});
    expect(fns()).toContain('stopStream');
    // The stop chunks must not contain a markdown_text body (no "_Done._").
    const stop = calls.find((c) => c.fn === 'stopStream')!;
    const chunks = stop.args[3] as Array<{ type: string }>;
    expect(chunks.some((ch) => ch.type === 'markdown_text')).toBe(false);
    // Last in-progress step is closed as complete.
    expect(chunks.some((ch) => ch.type === 'task_update')).toBe(true);
  });

  test('streaming handle + error closes the plan as error with the message', async () => {
    const handle = makeHandle({
      streaming: true,
      ts: 'stream.ts',
      steps: [{ type: 'task_update', id: 'step-0', title: 'Working', status: 'in_progress' }],
    });
    await finalizeStream(handle, { error: 'boom' });
    const stop = calls.find((c) => c.fn === 'stopStream')!;
    const chunks = stop.args[3] as Array<{ type: string; status?: string }>;
    expect(chunks.some((ch) => ch.type === 'markdown_text')).toBe(true);
    expect(chunks.some((ch) => ch.status === 'error')).toBe(true);
    // an error is not a success — no check reaction
    expect(calls.some((c) => c.fn === 'addReaction' && c.args[3] === 'white_check_mark')).toBe(false);
  });

  test('legacy placeholder still up + no content is deleted (cross-deploy cleanup)', async () => {
    await finalizeStream(makeHandle({ placeholderActive: true, ts: 'old.placeholder' }), {});
    expect(fns()).toContain('deleteMessage');
    expect(fns()).not.toContain('postMessage');
  });

  test('already finalized is a no-op', async () => {
    await finalizeStream(makeHandle({ finalized: true }), { answer: 'ignored' });
    expect(calls.length).toBe(0);
  });
});
