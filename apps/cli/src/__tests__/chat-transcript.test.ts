/**
 * The reducer is where the two bugs that would look fine in every short demo
 * live: a stale part frame duplicating text, and a reconnect silently eating
 * the middle of a turn. Both are covered here.
 */

import { describe, expect, test } from 'bun:test';

import type { OpencodeMessageWithParts } from '../api/sandbox-proxy.ts';
import type { ChatEvent, ChatPart } from '../chat/events.ts';
import {
  applyEvent,
  createTranscriptState,
  reconcile,
  statusText,
  suppressMessage,
  type RenderOp,
  type TranscriptState,
} from '../chat/transcript.ts';
import { stripAnsi } from '../style.ts';

function partEvent(part: ChatPart): ChatEvent {
  return { type: 'message.part.updated', sessionID: 'ses', part };
}

function drive(
  state: TranscriptState,
  events: ChatEvent[],
): { state: TranscriptState; ops: RenderOp[] } {
  let next = state;
  const ops: RenderOp[] = [];
  for (const event of events) {
    const result = applyEvent(next, event);
    next = result.state;
    ops.push(...result.ops);
  }
  return { state: next, ops };
}

function appends(ops: RenderOp[]): string[] {
  return ops.filter((o) => o.kind === 'append').map((o) => stripAnsi((o as { text: string }).text));
}

function commits(ops: RenderOp[]): string[] {
  return ops
    .filter((o) => o.kind === 'commit')
    .flatMap((o) => (o as { lines: string[] }).lines)
    .map(stripAnsi);
}

const assistantMessage: ChatEvent = {
  type: 'message.updated',
  sessionID: 'ses',
  message: { id: 'm1', role: 'assistant' },
};

describe('streaming text', () => {
  test('writes only the suffix of each cumulative frame', () => {
    const { ops } = drive(createTranscriptState(), [
      assistantMessage,
      partEvent({ id: 'p1', messageID: 'm1', type: 'text', text: 'He' }),
      partEvent({ id: 'p1', messageID: 'm1', type: 'text', text: 'Hello' }),
      partEvent({ id: 'p1', messageID: 'm1', type: 'text', text: 'Hello there' }),
    ]);

    expect(appends(ops)).toEqual(['He', 'llo', ' there']);
  });

  test('a non-prefix frame is dropped — never printed, never rewound', () => {
    const { state, ops } = drive(createTranscriptState(), [
      assistantMessage,
      partEvent({ id: 'p1', messageID: 'm1', type: 'text', text: 'He' }),
      partEvent({ id: 'p1', messageID: 'm1', type: 'text', text: 'Hello' }),
      // Stale/out-of-order snapshot.
      partEvent({ id: 'p1', messageID: 'm1', type: 'text', text: 'Hel' }),
      partEvent({ id: 'p1', messageID: 'm1', type: 'text', text: 'Hello there' }),
    ]);

    expect(appends(ops)).toEqual(['He', 'llo', ' there']);
    expect(state.written.p1).toBe('Hello there');
  });

  test('the assistant header is written once per turn, not once per frame', () => {
    const { ops } = drive(createTranscriptState(), [
      assistantMessage,
      partEvent({ id: 'p1', messageID: 'm1', type: 'text', text: 'a' }),
      partEvent({ id: 'p1', messageID: 'm1', type: 'text', text: 'ab' }),
    ]);

    expect(commits(ops).filter((l) => l === 'assistant')).toHaveLength(1);
  });

  test('a message this client submitted is never echoed back', () => {
    const state = suppressMessage(createTranscriptState(), 'mine');
    const { ops } = drive(state, [
      partEvent({ id: 'p9', messageID: 'mine', type: 'text', text: 'what I typed' }),
    ]);

    expect(ops).toEqual([]);
  });

  test('a user-role message from the server is not echoed either', () => {
    const { ops } = drive(createTranscriptState(), [
      { type: 'message.updated', sessionID: 'ses', message: { id: 'u1', role: 'user' } },
      partEvent({ id: 'p2', messageID: 'u1', type: 'text', text: 'hi' }),
    ]);

    expect(appends(ops)).toEqual([]);
  });

  test('reasoning is folded away by default and streamed under verbose', () => {
    const quiet = drive(createTranscriptState(false), [
      assistantMessage,
      partEvent({ id: 'r1', messageID: 'm1', type: 'reasoning', text: 'pondering' }),
    ]);
    const loud = drive(createTranscriptState(true), [
      assistantMessage,
      partEvent({ id: 'r1', messageID: 'm1', type: 'reasoning', text: 'pondering' }),
    ]);

    expect(appends(quiet.ops)).toEqual([]);
    expect(quiet.state.working).toBe(true);
    expect(appends(loud.ops)).toEqual(['pondering']);
  });

  test('a synthetic text part is not rendered', () => {
    const { ops } = drive(createTranscriptState(), [
      assistantMessage,
      partEvent({ id: 'p3', messageID: 'm1', type: 'text', text: 'x', synthetic: true }),
    ]);

    expect(appends(ops)).toEqual([]);
  });
});

describe('tool lifecycle', () => {
  const running: ChatPart = {
    id: 't1',
    messageID: 'm1',
    type: 'tool',
    tool: 'bash',
    state: { status: 'running', input: { command: 'ls -la' }, time: { start: 1_000 } },
  };

  test('a running tool lives in the tail, then collapses into scrollback', () => {
    const first = drive(createTranscriptState(), [assistantMessage, partEvent(running)]);
    const tail = first.ops.filter((o) => o.kind === 'tail').pop() as { lines: string[] };

    expect(tail.lines.map(stripAnsi)).toEqual(['  ⋯ bash  ls -la']);
    expect(first.state.activeTool).toBe('bash');

    const done = drive(first.state, [
      partEvent({
        ...running,
        state: { status: 'completed', input: { command: 'ls -la' }, output: 'a\nb', time: { start: 1_000, end: 2_200 } },
      }),
    ]);
    const finalTail = done.ops.filter((o) => o.kind === 'tail').pop() as { lines: string[] };

    expect(commits(done.ops)).toEqual(['  ✓ bash  1.2s']);
    // Output collapsed at default verbosity, and the line has left the tail.
    expect(finalTail.lines).toEqual([]);
    expect(done.state.activeTool).toBeNull();
  });

  test('a failed tool always shows its output', () => {
    const first = drive(createTranscriptState(), [assistantMessage, partEvent(running)]);
    const failed = drive(first.state, [
      partEvent({
        ...running,
        state: { status: 'error', error: 'exit 1', output: 'boom', time: { start: 1_000, end: 1_100 } },
      }),
    ]);

    expect(commits(failed.ops)).toEqual(['  ✗ bash  exit 1', '    boom']);
  });

  test('verbose shows a successful tool output too, capped at 8 lines', () => {
    const first = drive(createTranscriptState(true), [assistantMessage, partEvent(running)]);
    const done = drive(first.state, [
      partEvent({
        ...running,
        state: {
          status: 'completed',
          output: Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n'),
          time: { start: 1_000, end: 1_100 },
        },
      }),
    ]);

    expect(commits(done.ops)).toHaveLength(9);
  });

  test('a tool still pending at idle is committed rather than left in the tail forever', () => {
    const first = drive(createTranscriptState(), [assistantMessage, partEvent(running)]);
    const idle = drive(first.state, [{ type: 'session.idle', sessionID: 'ses' }]);

    expect(commits(idle.ops)[0]).toContain('bash');
    expect(idle.state.tools).toEqual([]);
    expect(idle.state.working).toBe(false);
  });
});

describe('status line', () => {
  test('names the running tool, then the generic wait, then goes quiet', () => {
    let state = createTranscriptState();
    expect(statusText(state)).toBeNull();

    state = { ...state, working: true };
    expect(statusText(state)).toBe('thinking…');

    state = { ...state, activeTool: 'bash' };
    expect(statusText(state)).toBe('running bash…');

    state = { ...state, activeTool: null, streamingText: true };
    expect(statusText(state)).toBeNull();
  });
});

describe('reconcile after a gap', () => {
  function message(id: string, role: string, parts: ChatPart[]): OpencodeMessageWithParts {
    return { info: { id, role, sessionID: 'ses' }, parts } as unknown as OpencodeMessageWithParts;
  }

  test('emits only the suffix beyond what is already on screen', () => {
    // A turn streamed "Hel", the connection dropped, and the server now has
    // the whole reply. The terminal must receive "lo there" and nothing else.
    const streamed = drive(createTranscriptState(), [
      assistantMessage,
      partEvent({ id: 'p1', messageID: 'm1', type: 'text', text: 'Hel' }),
    ]);
    const result = reconcile(streamed.state, [
      message('m1', 'assistant', [{ id: 'p1', type: 'text', text: 'Hello there' }]),
    ]);

    expect(appends(result.ops)).toEqual(['lo there']);
  });

  test('reconciling twice over the same window prints nothing the second time', () => {
    const history = [message('m1', 'assistant', [{ id: 'p1', type: 'text', text: 'done' }])];
    const first = reconcile(createTranscriptState(), history);
    const second = reconcile(first.state, history);

    expect(appends(first.ops)).toEqual(['done']);
    expect(appends(second.ops)).toEqual([]);
    expect(commits(second.ops)).toEqual([]);
  });

  test('a settled tool in history is committed once, not on every reconcile', () => {
    const history = [
      message('m1', 'assistant', [
        {
          id: 't1',
          type: 'tool',
          tool: 'read',
          state: { status: 'completed', input: { filePath: 'a.ts' }, time: { start: 0, end: 500 } },
        },
      ]),
    ];
    const first = reconcile(createTranscriptState(), history);
    const second = reconcile(first.state, history);

    expect(commits(first.ops).some((l) => l.includes('read'))).toBe(true);
    expect(commits(second.ops)).toEqual([]);
  });

  test('replaying history renders both roles', () => {
    const result = reconcile(createTranscriptState(), [
      message('u1', 'user', [{ id: 'up', type: 'text', text: 'hi' }]),
      message('m1', 'assistant', [{ id: 'ap', type: 'text', text: 'hello' }]),
    ]);

    expect(commits(result.ops).filter((l) => l === 'you' || l === 'assistant')).toEqual([
      'you',
      'assistant',
    ]);
    expect(appends(result.ops)).toEqual(['hi', 'hello']);
  });

  test('a message this client already echoed is skipped on replay', () => {
    const state = suppressMessage(createTranscriptState(), 'u1');
    const result = reconcile(state, [message('u1', 'user', [{ id: 'up', type: 'text', text: 'hi' }])]);

    expect(appends(result.ops)).toEqual([]);
  });
});
