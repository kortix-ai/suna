/**
 * The over-cap restore slice (`modelViewSliceIds`). A log over `SESSION_LOG_RESTORE_MAX_BYTES` is answered
 * with each thread cut to these messages (`kept: 'model_view'`). The oracle: `threadView` of the cut thread
 * equals `threadView` of the whole thread, for every fixture shape (pi's native summary + tail, OpenCode's
 * compaction pair, a `layout` compaction, no compaction) and for the edge cases below.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalizeView,
  modelViewSliceIds,
  threadView,
  visibleMessageIds,
  type SessionLog,
  type SessionLogMessage,
  type ViewTarget,
} from '../session-log';

const FIXTURES = join(import.meta.dir, 'fixtures', 'session-log');
const load = (name: string) => JSON.parse(readFileSync(join(FIXTURES, `${name}.v2.json`), 'utf8')) as SessionLog;
const NAMES = ['golden', 'golden21', 'pi', 'opencode', 'opencode-v2', 'claude-code', 'codex'] as const;
const OTHER: ViewTarget = { provider: 'nobody', model: 'nothing' };

/** The log as an over-cap restore answers it: each thread keeps only its `modelViewSliceIds`. */
const cut = (log: SessionLog): SessionLog => ({
  ...log,
  threads: log.threads.map((t) => {
    const keep = modelViewSliceIds(t.messages);
    return { ...t, messages: t.messages.filter((m) => keep.has(m.message_id)) };
  }),
});
/** The columns the API reads for every message; only a compaction keeps its blocks. */
const light = (messages: SessionLogMessage[]) =>
  messages.map(({ message_id, seq, kind, in_context, blocks }) => ({ message_id, seq, kind, in_context, ...(kind === 'compaction' && { blocks }) }));
const seqs = (log: SessionLog, ids: Set<string>) =>
  log.threads[0]!.messages.filter((m) => ids.has(m.message_id)).map((m) => m.seq).sort((a, b) => a - b);

describe('the over-cap slice keeps the model view', () => {
  for (const name of NAMES) {
    test(`${name}: threadView of every cut thread equals the whole thread's, for another model and the session's own`, () => {
      const log = load(name);
      const sliced = cut(log);
      for (const t of log.threads) {
        for (const target of [OTHER, log.selection.model ?? OTHER]) {
          const whole = threadView(log, t.thread_id, target);
          const kept = threadView(sliced, t.thread_id, target);
          expect(kept).toEqual(whole);
          expect(canonicalizeView(kept)).toEqual(canonicalizeView(whole));
        }
      }
    });

    test(`${name}: the light columns plus the compaction blocks give the same ids as the whole messages`, () => {
      for (const t of load(name).threads) {
        expect(visibleMessageIds(light(t.messages))).toEqual(visibleMessageIds(t.messages));
        expect(modelViewSliceIds(light(t.messages))).toEqual(modelViewSliceIds(t.messages));
      }
    });
  }

  test('the slice leaves out what the model no longer sees: the turns before the cut point and the out-of-context ones', () => {
    // pi: the summary cuts at seq 5; seq 9 is out of context; seq 1 is the system prompt (the last context record).
    const pi = load('pi');
    expect(seqs(pi, modelViewSliceIds(pi.threads[0]!.messages))).toEqual([1, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17]);
    // OpenCode's compaction pair (seq 13) keeps from its tail_start_id (seq 4); seq 8 is out of context.
    const opencode = load('opencode');
    expect(seqs(opencode, modelViewSliceIds(opencode.threads[0]!.messages))).toEqual([4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
    // A child thread without a compaction keeps every in-context turn.
    const child = pi.threads[1]!;
    expect(modelViewSliceIds(child.messages).size).toBe(child.messages.length);
  });
});

// ─── edge cases on synthetic threads ─────────────────────────────────────────

const AT = '2026-01-01T00:00:00.000Z';
const message = (id: string, seq: number, patch: Partial<SessionLogMessage> = {}): SessionLogMessage =>
  ({
    schema: 'kortix.session/2', v: 1, message_id: id, thread_id: 'root', seq, role: seq % 2 ? 'user' : 'assistant', kind: 'turn', status: 'complete',
    in_context: true, model: null, usage: null, finish: null, error: null, created_at: AT, completed_at: AT,
    producer: { harness: 'test', harness_version: '0', adapter_version: '0' }, blocks: [{ type: 'text', id: `b_${id}`, text: `text of ${id}` }], ...patch,
  }) as SessionLogMessage;
const compaction = (id: string, seq: number, firstKept: string | null, patch: Partial<SessionLogMessage> = {}) =>
  message(id, seq, { role: 'user', kind: 'compaction', blocks: [{ type: 'compaction', id: `b_${id}`, summary: `summary ${id}`, first_kept_message_id: firstKept }], ...patch });
const logOf = (messages: SessionLogMessage[]) =>
  ({ schema: 'kortix.session/2', v: 1, threads: [{ schema: 'kortix.session/2', v: 1, thread_id: 'root', parent_thread_id: null, messages }] }) as unknown as SessionLog;
/** Asserts the oracle on one thread and returns the ids the slice keeps. */
function sliceOf(messages: SessionLogMessage[]): string[] {
  const log = logOf(messages);
  const sliced = cut(log);
  expect(threadView(sliced, 'root', OTHER)).toEqual(threadView(log, 'root', OTHER));
  return sliced.threads[0]!.messages.map((m) => m.message_id);
}

describe('the slice: edge cases', () => {
  test('a cut point the model does not see (out of context) stays in the slice, so threadView still finds where the kept run starts', () => {
    const messages = [
      message('m1', 1),
      message('m2', 2, { in_context: false }),
      message('m3', 3),
      message('m4', 4, { in_context: false }),
      message('m5', 5),
      compaction('c6', 6, 'm2'),
      message('m7', 7),
    ];
    expect([...visibleMessageIds(messages)]).toEqual(['m3', 'm5', 'm7']);
    expect(sliceOf(messages)).toEqual(['m2', 'm3', 'm5', 'c6', 'm7']);
  });

  test('only the last in-context compaction counts: an earlier marker and an out-of-context later one are left out', () => {
    const ids = sliceOf([
      message('m1', 1),
      compaction('c2', 2, 'm1'),
      message('m3', 3),
      message('m4', 4),
      compaction('c5', 5, 'm4'),
      message('m6', 6),
      compaction('c7', 7, 'm6', { in_context: false }),
      message('m8', 8),
    ]);
    expect(ids).toEqual(['m4', 'c5', 'm6', 'm8']);
  });

  test('a compaction that keeps nothing: the marker and the turns after it; the last context record stays for the harness', () => {
    const ids = sliceOf([
      message('s0', 0, { role: 'system', kind: 'context' }),
      message('m1', 1),
      message('m2', 2),
      compaction('c3', 3, null),
      message('m4', 4),
      message('s5', 5, { role: 'system', kind: 'context' }),
    ]);
    expect(ids).toEqual(['c3', 'm4', 's5']);
  });

  test('a layout compaction keeps exactly the messages its layout names, even one out of context', () => {
    const ids = sliceOf([
      message('m1', 1),
      message('m2', 2, { in_context: false }),
      message('m3', 3),
      message('m4', 4, {
        role: 'user', kind: 'compaction',
        blocks: [{ type: 'compaction', id: 'b_m4', summary: 'S', first_kept_message_id: null, layout: [{ message_id: 'm2' }, { summary: true }, { text: 'kept text' }] }],
      }),
      message('m5', 5),
    ]);
    expect(ids).toEqual(['m2', 'm4', 'm5']);
  });
});
