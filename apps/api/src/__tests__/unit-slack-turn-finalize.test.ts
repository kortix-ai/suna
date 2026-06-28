import { afterEach, describe, expect, mock, test } from 'bun:test';

// Capture every slack-api side effect so we can assert exactly what a turn
// finalization posts to Slack. finalizeTurn only talks to slack-api (never the
// DB), so mocking this module is enough to unit-test its behavior.
const calls: Array<{ fn: string; args: unknown[] }> = [];
let failFn: string | null = null; // set to a fn name to make that slack-api call reject
const overrides: Record<string, unknown> = {}; // force a specific resolved value per fn
const rec = (fn: string) => (...args: unknown[]) => {
  calls.push({ fn, args });
  if (fn === failFn) return Promise.reject(new Error(`${fn} boom`));
  if (fn in overrides) return Promise.resolve(overrides[fn]);
  // startStream/postMessage/postBlocks return a ts; updateBlocks returns a
  // success boolean; others return void.
  if (fn === 'startStream' || fn === 'postMessage' || fn === 'postBlocks') return Promise.resolve('ts.posted');
  if (fn === 'updateBlocks') return Promise.resolve(true);
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
  failFn = null;
  for (const k of Object.keys(overrides)) delete overrides[k];
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
    // no "_Done._" filler section; 'context' = the "Open session" footer link
    expect(blocks.map((b) => b.type)).toEqual(['plan', 'context']);
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
    // error rendered as a section; 'context' = the "Open session" footer link
    expect(blocks.map((b) => b.type)).toEqual(['plan', 'section', 'context']);
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
    // answer section + 'context' = the "Open session" footer link
    expect(blocks.map((b) => b.type)).toEqual(['plan', 'section', 'context']);
    expect(calls.some((c) => c.fn === 'addReaction' && c.args[3] === 'white_check_mark')).toBe(true);
  });

  test('already finalized is a no-op', async () => {
    await finalizeTurn(makeHandle({ finalized: true }), { answer: 'ignored' });
    expect(calls.length).toBe(0);
  });

  test('clears ⏳ even when the plan render throws — never strands the reaction', async () => {
    failFn = 'updateBlocks'; // simulate a Slack API hiccup mid-render
    const handle = makeHandle({
      ts: 'plan.ts',
      steps: [{ type: 'task_update', id: 'step-0', title: 'Working', status: 'in_progress' }],
    });
    // Must NOT reject — the row is already claimed-finalized, so throwing would
    // skip the caller's deleteTurn and (before the fix) leave the ⏳ forever,
    // unreachable by the GC (which only sweeps un-finalized rows).
    await finalizeTurn(handle, { answer: 'done!' });
    expect(calls.some((c) => c.fn === 'updateBlocks')).toBe(true); // render was attempted (and threw)
    expect(fns()).toContain('removeReaction'); // ⏳ cleared despite the failure
  });
});

describe('finalizeTurn — silent-loss guards (block render rejected / answer too long)', () => {
  const planHandle = () =>
    makeHandle({
      ts: 'plan.ts',
      steps: [{ type: 'task_update', id: 'step-0', title: 'Working', status: 'in_progress' }],
    });

  test('chat.update rejects the blocks → falls back to a plain postMessage so the answer is not lost', async () => {
    overrides.updateBlocks = false; // e.g. invalid_blocks / msg_too_long, not a throw
    await finalizeTurn(planHandle(), { answer: 'the real answer text' });
    const post = calls.find((c) => c.fn === 'postMessage');
    expect(post).toBeDefined();
    expect(String(post!.args[2])).toContain('the real answer text');
    // The fallback posted, so the ✅ is still earned.
    expect(calls.some((c) => c.fn === 'addReaction' && c.args[3] === 'white_check_mark')).toBe(true);
  });

  test('✅ is withheld when both the block render AND the plain fallback fail', async () => {
    overrides.updateBlocks = false;
    overrides.postMessage = null; // fallback post also fails
    await finalizeTurn(planHandle(), { answer: 'nothing reached the thread' });
    expect(calls.some((c) => c.fn === 'addReaction' && c.args[3] === 'white_check_mark')).toBe(false);
    expect(fns()).toContain('removeReaction'); // ⏳ still cleared
  });

  test('a long answer is split into ≤3000-char sections with a truncation note (never one oversized section)', async () => {
    const long = 'x'.repeat(12000); // > MAX_BODY (11000), forces truncation
    await finalizeTurn(planHandle(), { answer: long });
    const upd = calls.find((c) => c.fn === 'updateBlocks')!;
    const blocks = upd.args[4] as Array<{
      type: string;
      text?: { text: string };
      elements?: Array<{ text: string }>;
    }>;
    const sections = blocks.filter((b) => b.type === 'section');
    expect(sections.length).toBeGreaterThan(1); // chunked, not one giant section
    for (const s of sections) expect(s.text!.text.length).toBeLessThanOrEqual(3000);
    // A context block carries the truncation note (separate from the session footer).
    const noted = blocks.some(
      (b) => b.type === 'context' && (b.elements?.[0]?.text ?? '').toLowerCase().includes('truncated'),
    );
    expect(noted).toBe(true);
  });

  test('no-plan error with no plan message still posts (via postBlocks) and clears ⏳', async () => {
    await finalizeTurn(makeHandle(), { error: ':warning: out of credits', title: 'Out of credits' });
    expect(calls.some((c) => c.fn === 'postBlocks')).toBe(true);
    expect(fns()).toContain('removeReaction');
  });
});
