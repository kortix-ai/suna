import { describe, expect, test } from 'bun:test';
import { getChildSessionId } from '@kortix/sdk';

import {
  childReadFailureLog,
  childSessionIdOf,
  childSessionReferences,
  childSessionsToCapture,
  readChildTranscripts,
} from './session-transcript-mirror';
import { TranscriptReadError } from './runtime-read-failure';

/**
 * A sub-agent runs in its own OpenCode session, and its row in the parent
 * opens that session's transcript. Saved history must hold those transcripts
 * too, or the row opens onto nothing while the computer is off. The capture
 * finds them by the SAME rule the renderer opens them by.
 */

const call = (tool: string, state: Record<string, unknown>) => ({ type: 'tool', tool, state });

describe('the capture finds a sub-agent session exactly as the SDK does', () => {
  const cases: Array<[string, ReturnType<typeof call>]> = [
    ['task, metadata', call('task', { status: 'completed', metadata: { sessionId: 'ses_meta1' } })],
    ['agent_spawn, metadata', call('agent_spawn', { status: 'running', metadata: { sessionId: 'ses_meta2' } })],
    ['agent-task, title', call('agent-task', { status: 'completed', title: 'Delegated to ses_title1' })],
    ['task_start, output', call('task_start', { status: 'completed', output: 'started ses_output1 ok' })],
    ['session_spawn, output', call('session_spawn', { status: 'completed', output: '- **Session:** ses_spawn1' })],
    ['session-start-background, output', call('session-start-background', { status: 'completed', output: 'Session: ses_spawn2' })],
    ['task, error-only child', call('task', { status: 'error', error: 'Subagent failed (task_id: ses_failed1)' })],
    ['task, metadata wins over error', call('task', { status: 'error', metadata: { sessionId: 'ses_meta1' }, error: 'Subagent failed (task_id: ses_failed1)' })],
    ['task, error excludes legacy title', call('task', { status: 'error', error: 'Request failed', title: 'Delegated to ses_title1' })],
    ['task, error absent, legacy title ignored', call('task', { status: 'error', title: 'Delegated to ses_title1' })],
    ['task, unrelated error mention', call('task', { status: 'error', error: 'Parent ses_parent failed' })],
    ['bash, task-id error', call('bash', { status: 'error', error: 'task_id: ses_notachild' })],
    ['task, nothing', call('task', { status: 'completed', metadata: {} })],
    ['bash naming a session', call('bash', { status: 'completed', output: 'ses_notachild', title: 'ses_notachild' })],
    ['session_spawn without the label', call('session_spawn', { status: 'completed', output: 'ses_unlabelled' })],
  ];
  for (const [label, part] of cases) {
    test(label, () => {
      expect(childSessionIdOf(part)).toBe(getChildSessionId(part as never));
    });
  }
});

describe('which sub-agent transcripts a capture reads', () => {
  const rows = [
    { parts: [call('task', { status: 'completed', metadata: { sessionId: 'ses_done' } })] },
    { parts: [call('task', { status: 'running', metadata: { sessionId: 'ses_live' } })] },
    { parts: [call('task', { status: 'completed', metadata: { sessionId: 'ses_new' } }), { type: 'text', text: 'x' }] },
  ];

  test('references carry whether the dispatching call has settled', () => {
    expect(childSessionReferences(rows)).toEqual([
      { id: 'ses_done', settled: true },
      { id: 'ses_live', settled: false },
      { id: 'ses_new', settled: true },
    ]);
  });

  test('a call referenced twice is settled only when every reference is', () => {
    const twice = [
      { parts: [call('task', { status: 'completed', metadata: { sessionId: 'ses_a' } })] },
      { parts: [call('agent_task_update', { status: 'running', metadata: { sessionId: 'ses_a' } })] },
    ];
    expect(childSessionReferences(twice)).toEqual([{ id: 'ses_a', settled: false }]);
  });

  test('reads a new sub-agent, a running one, and one whose saved copy has an open message; skips a finished one', () => {
    const stored = new Map([
      ['ses_done', { settled: true }],
      ['ses_live', { settled: true }],
    ]);
    expect(
      childSessionsToCapture({ references: childSessionReferences(rows), stored }),
    ).toEqual(['ses_live', 'ses_new']);
    const open = new Map([['ses_done', { settled: false }]]);
    expect(
      childSessionsToCapture({
        references: [{ id: 'ses_done', settled: true }],
        stored: open,
      }),
    ).toEqual(['ses_done']);
  });

});

describe('readChildTranscripts: which sub-agents one capture saves, and whether another capture saves more', () => {
  const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `ses_c${from + i}`);
  const refs = (list: string[]) => list.map((id) => ({ id, settled: true }));
  const message = (id: string) => ({ info: { id: `msg_${id}`, sessionID: id, role: 'user' }, parts: [] });
  /** A box: every sub-agent has one message, except `empty` (200, no rows) and `failing` (throws). */
  const box = (opts: { empty?: string[]; failing?: string[] } = {}) => {
    const reads: string[] = [];
    const read = async (id: string) => {
      reads.push(id);
      if (opts.failing?.includes(id)) throw new Error('404');
      return { rows: opts.empty?.includes(id) ? [] : [message(id)], complete: true };
    };
    return { reads, read };
  };

  test('reads at most `cap` sub-agents with rows and says more when it saved a new one', async () => {
    const { read } = box();
    const out = await readChildTranscripts({ references: refs(ids(16)), stored: new Map(), cap: 12, read });
    expect(out.children.map((c) => c.opencodeSessionId)).toEqual(ids(12));
    expect(out.more).toBe(true);
  });

  test('every sub-agent read: nothing more', async () => {
    const { read } = box();
    const out = await readChildTranscripts({ references: refs(ids(5)), stored: new Map(), cap: 12, read });
    expect(out.children).toHaveLength(5);
    expect(out.more).toBe(false);
  });

  test('an empty sub-agent (200, no rows) neither takes a slot nor counts as saved', async () => {
    // 12 empty sub-agents ahead of 4 with rows: the 4 are still read in this capture.
    const empty = ids(12);
    const { read } = box({ empty });
    const out = await readChildTranscripts({ references: refs(ids(16)), stored: new Map(), cap: 12, read });
    expect(out.children.map((c) => c.opencodeSessionId)).toEqual(ids(4, 12));
    expect(out.more).toBe(false);
    // Unread sub-agents cannot be known empty: one new save asks for one more capture, which
    // then saves nothing and asks for none.
    const onlyEmpty = await readChildTranscripts({ references: refs(ids(14)), stored: new Map(), cap: 1, read: box({ empty: ids(13, 1) }).read });
    expect(onlyEmpty.more).toBe(true);
    const savedNothing = await readChildTranscripts({ references: refs(ids(14)), stored: new Map(), cap: 12, read: box({ empty: ids(14) }).read });
    expect(savedNothing.children).toEqual([]);
    expect(savedNothing.more).toBe(false);
  });

  test('a failing sub-agent neither takes a slot nor starves the ones after it', async () => {
    const failing = ids(12);
    const { read, reads } = box({ failing });
    const out = await readChildTranscripts({ references: refs(ids(16)), stored: new Map(), cap: 12, read });
    expect(reads).toEqual(ids(16));
    expect(out.children.map((c) => c.opencodeSessionId)).toEqual(ids(4, 12));
    expect(out.more).toBe(false);
  });

  test('an expected runtime failure stops the walk: every sibling would fail the same way', async () => {
    // A stopped box answers 503 through the proxy, and a box that came back
    // without its sub-agent sessions answers 404 — both for EVERY child, not
    // one. The walk stops at the first expected failure instead of paying the
    // same failure per child (one prod capture failed 60 reads in a row).
    const stopped = box({});
    stopped.read = async (id) => {
      stopped.reads.push(id);
      throw new TranscriptReadError(503);
    };
    const out = await readChildTranscripts({ references: refs(ids(8)), stored: new Map(), cap: 12, read: stopped.read });
    expect(stopped.reads).toEqual(['ses_c0']);
    expect(out.children).toEqual([]);
    expect(out.failures).toEqual({ missing: 0, unavailable: 1, other: 0, first: 'Transcript read failed: HTTP 503' });

    const replaced = box({});
    replaced.read = async (id) => {
      replaced.reads.push(id);
      throw new TranscriptReadError(404);
    };
    const gone = await readChildTranscripts({ references: refs(ids(8)), stored: new Map(), cap: 12, read: replaced.read });
    expect(replaced.reads).toEqual(['ses_c0']);
    expect(gone.failures).toEqual({ missing: 1, unavailable: 0, other: 0, first: 'Transcript read failed: HTTP 404' });
  });

  test('an expected transport failure (timeout, dead box) also stops the walk', async () => {
    const slow = box({});
    slow.read = async (id) => {
      slow.reads.push(id);
      const timeout = new Error('The operation timed out.');
      timeout.name = 'TimeoutError';
      throw timeout;
    };
    const out = await readChildTranscripts({ references: refs(ids(8)), stored: new Map(), cap: 12, read: slow.read });
    expect(slow.reads).toEqual(['ses_c0']);
    expect(out.failures).toEqual({ missing: 0, unavailable: 1, other: 0, first: 'The operation timed out.' });
  });

  test('an unsettled sub-agent saved before is read again but is not new: no next capture for it alone', async () => {
    const stored = new Map(ids(14).map((id) => [id, { settled: false }]));
    const { read } = box();
    const out = await readChildTranscripts({ references: refs(ids(14)), stored, cap: 12, read });
    expect(out.children).toHaveLength(12);
    expect(out.more).toBe(false);
  });

  test('a sub-agent of a sub-agent is followed; an id that is not a session id is never read', async () => {
    const reads: string[] = [];
    const read = async (id: string) => {
      reads.push(id);
      const parts = id === 'ses_parent' ? [call('task', { status: 'completed', metadata: { sessionId: 'ses_grand' } })] : [];
      return { rows: [{ ...message(id), parts }], complete: true };
    };
    const out = await readChildTranscripts({ references: refs(['ses_parent', '../etc']), stored: new Map(), cap: 12, read });
    expect(reads).toEqual(['ses_parent', 'ses_grand']);
    expect(out.children.map((c) => c.opencodeSessionId)).toEqual(['ses_parent', 'ses_grand']);
  });

});

describe('childReadFailureLog: the one log line a capture\'s failed sub-agent reads earn', () => {
  test('no failures, no line', () => {
    expect(childReadFailureLog({ missing: 0, unavailable: 0, other: 0 })).toBeNull();
  });

  test('expected states — a stopped box, gone transcripts — are info, not warn', () => {
    // The warn on these states was the spike: 637 lines in four days, 284 in
    // one hour, every one an expected fail-open degrade.
    const stopped = childReadFailureLog({ missing: 0, unavailable: 3, other: 0, first: 'Transcript read failed: HTTP 503' });
    expect(stopped?.level).toBe('info');
    expect(stopped?.message).toBe('[transcript-mirror] sub-agent reads deferred');
    expect(stopped?.context).toEqual({ missing: 0, unavailable: 3, first: 'Transcript read failed: HTTP 503' });

    const gone = childReadFailureLog({ missing: 2, unavailable: 0, other: 0, first: 'Transcript read failed: HTTP 404' });
    expect(gone?.level).toBe('info');
  });

  test('an unexpected failure still warns, with the count of unexpected ones', () => {
    const line = childReadFailureLog({ missing: 1, unavailable: 0, other: 2, first: 'boom' });
    expect(line?.level).toBe('warn');
    expect(line?.message).toBe('[transcript-mirror] sub-agent reads failed');
    expect(line?.context).toEqual({ count: 2, first: 'boom' });
  });

  test('a mixed capture warns about the unexpected one, not the expected one', () => {
    // The first failure was expected (a stopped box), so `first` holds the
    // 503; the warn line must name the unexpected failure it counts.
    const line = childReadFailureLog({
      missing: 0,
      unavailable: 3,
      other: 1,
      first: 'Transcript read failed: HTTP 503',
      firstOther: 'Unexpected reply from the runtime daemon',
    });
    expect(line?.level).toBe('warn');
    expect(line?.context).toEqual({ count: 1, first: 'Unexpected reply from the runtime daemon' });
  });
});
