import { describe, expect, test } from 'bun:test';
import {
  type RawCallTurn,
  mergeCallRecord,
  toCallRecordEntries,
  unrecordedLive,
} from './call-record';
import type { CallRecordEntry, LiveUtterance } from './types';

function turn(partial: Partial<RawCallTurn> & { cursor: number }): RawCallTurn {
  return {
    role: 'user',
    speaker: null,
    text: 'hi',
    at: '2026-07-26T10:00:00.000Z',
    ...partial,
  };
}

function entry(partial: Partial<CallRecordEntry> & { cursor: number }): CallRecordEntry {
  return {
    kind: 'human',
    name: 'Guest',
    text: 'hi',
    outcome: null,
    at: '2026-07-26T10:00:00.000Z',
    ...partial,
  };
}

function utterance(partial: Partial<LiveUtterance> & { id: string }): LiveUtterance {
  return {
    name: 'You',
    isLocal: true,
    text: 'hi',
    final: true,
    firstReceivedTime: 0,
    ...partial,
  };
}

describe('toCallRecordEntries — who actually said it', () => {
  test('role=user is a human, named by speaker when the worker knows one', () => {
    const [named, anonymous] = toCallRecordEntries([
      turn({ cursor: 1, role: 'user', speaker: 'Marko', text: 'ship it' }),
      turn({ cursor: 2, role: 'user', speaker: null, text: 'ship it' }),
    ]);
    expect(named).toMatchObject({ kind: 'human', name: 'Marko', text: 'ship it' });
    // The worker posts the user side with no speaker — it has no name for
    // whoever is in the room — so this is the common case.
    expect(anonymous).toMatchObject({ kind: 'human', name: 'Guest' });
  });

  test('role=agent + speaker=kortix is the KORTIX agent, not the voice', () => {
    const [e] = toCallRecordEntries([
      turn({ cursor: 1, role: 'agent', speaker: 'kortix', text: 'The deploy finished.' }),
    ]);
    expect(e).toMatchObject({ kind: 'kortix', name: 'Kortix agent', text: 'The deploy finished.' });
  });

  test('role=agent with any other speaker is the voice itself', () => {
    const [named, anonymous] = toCallRecordEntries([
      turn({ cursor: 1, role: 'agent', speaker: 'Kortix Voice', text: 'Sure thing.' }),
      turn({ cursor: 2, role: 'agent', speaker: null, text: 'Sure thing.' }),
    ]);
    expect(named).toMatchObject({ kind: 'voice', name: 'Kortix Voice' });
    expect(anonymous).toMatchObject({ kind: 'voice', name: 'Kortix' });
  });

  test('the two agent-side sources stay distinguishable — the whole point of reading speaker', () => {
    const entries = toCallRecordEntries([
      turn({ cursor: 1, role: 'agent', speaker: 'kortix', text: 'Tests are green.' }),
      turn({
        cursor: 2,
        role: 'agent',
        speaker: 'Kortix Voice',
        text: 'Good news, tests are green!',
      }),
    ]);
    expect(entries.map((e) => e.kind)).toEqual(['kortix', 'voice']);
  });

  test('drops rows with no text rather than rendering an empty bubble', () => {
    expect(toCallRecordEntries([turn({ cursor: 1, text: '   ' })])).toEqual([]);
  });

  test('preserves cursor and timestamp verbatim — the cursor is the key and the poll position', () => {
    const [e] = toCallRecordEntries([turn({ cursor: 42, at: '2026-07-26T11:22:33.000Z' })]);
    expect(e!.cursor).toBe(42);
    expect(e!.at).toBe('2026-07-26T11:22:33.000Z');
  });
});

describe('toCallRecordEntries — tool calls are not speech', () => {
  test('run_command splits into tool name, command, and outcome', () => {
    const [e] = toCallRecordEntries([
      turn({ cursor: 1, role: 'tool', speaker: 'run_command', text: 'run_command: bun test → ok' }),
    ]);
    expect(e).toMatchObject({ kind: 'tool', name: 'run_command', text: 'bun test', outcome: 'ok' });
  });

  for (const [text, outcome] of [
    ['run_command: bun test → exit 1', 'exit 1'],
    ['run_command: sleep 999 → timed out', 'timed out'],
    ['run_command: deploy → failed', 'failed'],
    ['run_command: deploy → exit -1', 'exit -1'],
  ] as const) {
    test(`recognises the outcome vocabulary: ${outcome}`, () => {
      const [e] = toCallRecordEntries([
        turn({ cursor: 1, role: 'tool', speaker: 'run_command', text }),
      ]);
      expect(e!.outcome).toBe(outcome);
      expect(e!.text).not.toContain('→');
    });
  }

  test('ask_kortix has no outcome and keeps its whole request', () => {
    const [e] = toCallRecordEntries([
      turn({
        cursor: 1,
        role: 'tool',
        speaker: 'ask_kortix',
        text: 'ask_kortix: what broke the build?',
      }),
    ]);
    expect(e).toMatchObject({
      kind: 'tool',
      name: 'ask_kortix',
      text: 'what broke the build?',
      outcome: null,
    });
  });

  test('the settle row that closes a hand-off renders as name + outcome, nothing doubled', () => {
    // `ask_kortix_done` is written by apps/api's `settleAsk` when a hand-off
    // finishes, however it finishes — it is what lets the call ask again
    // (channels/voice/ask-ledger.ts). It follows the same `<tool>: <detail>`
    // convention as every other tool row precisely so it needs no special case
    // here: the prefix is stripped and the reader sees just the outcome.
    for (const outcome of ['answered', 'failed', 'nothing to say', 'timed out']) {
      const [e] = toCallRecordEntries([
        turn({
          cursor: 1,
          role: 'tool',
          speaker: 'ask_kortix_done',
          text: `ask_kortix_done: ${outcome}`,
        }),
      ]);
      expect(e).toMatchObject({ kind: 'tool', name: 'ask_kortix_done', text: outcome });
    }
  });

  test('an arrow inside the text is NOT torn off as an outcome', () => {
    // The bug the fixed outcome vocabulary exists to prevent: "arrow" is not a
    // result, so the request must survive whole.
    const [e] = toCallRecordEntries([
      turn({
        cursor: 1,
        role: 'tool',
        speaker: 'ask_kortix',
        text: 'ask_kortix: rename a → b in the schema',
      }),
    ]);
    expect(e!.text).toBe('rename a → b in the schema');
    expect(e!.outcome).toBeNull();
  });

  test('only the FINAL arrow segment is treated as the outcome', () => {
    const [e] = toCallRecordEntries([
      turn({
        cursor: 1,
        role: 'tool',
        speaker: 'run_command',
        text: 'run_command: echo a → b → ok',
      }),
    ]);
    expect(e!.text).toBe('echo a → b');
    expect(e!.outcome).toBe('ok');
  });

  test('falls back to a generic name when the tool row lost its speaker', () => {
    const [e] = toCallRecordEntries([
      turn({ cursor: 1, role: 'tool', speaker: null, text: 'something happened' }),
    ]);
    expect(e).toMatchObject({ kind: 'tool', name: 'tool', text: 'something happened' });
  });
});

describe('mergeCallRecord', () => {
  test('appends new cursors in order', () => {
    const merged = mergeCallRecord(
      [entry({ cursor: 1 })],
      [entry({ cursor: 2 }), entry({ cursor: 3 })],
    );
    expect(merged.map((e) => e.cursor)).toEqual([1, 2, 3]);
  });

  test('a re-delivered row replaces rather than duplicates — a retried poll must not double the transcript', () => {
    const merged = mergeCallRecord(
      [entry({ cursor: 1, text: 'hello' })],
      [entry({ cursor: 1, text: 'hello' }), entry({ cursor: 2, text: 'again' })],
    );
    expect(merged).toHaveLength(2);
    expect(merged.map((e) => e.text)).toEqual(['hello', 'again']);
  });

  test('an empty page leaves the record untouched — an idle poll is a no-op', () => {
    const existing = [entry({ cursor: 1 })];
    expect(mergeCallRecord(existing, [])).toBe(existing);
  });

  test('out-of-order arrivals still sort by cursor', () => {
    const merged = mergeCallRecord([], [entry({ cursor: 5 }), entry({ cursor: 2 })]);
    expect(merged.map((e) => e.cursor)).toEqual([2, 5]);
  });
});

describe('unrecordedLive — the tail must not repeat the record', () => {
  test('a final utterance drops once the record holds the same words', () => {
    const live = [utterance({ id: 's1', text: 'ship it' })];
    expect(unrecordedLive(live, [entry({ cursor: 1, text: 'ship it' })])).toEqual([]);
  });

  test('an utterance the record does not have yet is kept — a gap is never hidden', () => {
    const live = [utterance({ id: 's1', text: 'ship it' })];
    expect(unrecordedLive(live, [])).toHaveLength(1);
  });

  test('never retires an utterance still being revised', () => {
    // An interim result matching a recorded line is a coincidence, not the
    // same sentence — it has not finished being said.
    const live = [utterance({ id: 's1', text: 'ship it', final: false })];
    expect(unrecordedLive(live, [entry({ cursor: 1, text: 'ship it' })])).toHaveLength(1);
  });

  test('matches on normalized text — trimming, whitespace and case must not resurrect a line', () => {
    const live = [utterance({ id: 's1', text: '  Ship   It  ' })];
    expect(unrecordedLive(live, [entry({ cursor: 1, text: 'ship it' })])).toEqual([]);
  });

  test('matching is one-for-one, so saying the same thing twice retires two lines', () => {
    const live = [utterance({ id: 's1', text: 'yes' }), utterance({ id: 's2', text: 'yes' })];
    expect(unrecordedLive(live, [entry({ cursor: 1, text: 'yes' })]).map((u) => u.id)).toEqual([
      's2',
    ]);
    expect(
      unrecordedLive(live, [entry({ cursor: 1, text: 'yes' }), entry({ cursor: 2, text: 'yes' })]),
    ).toEqual([]);
  });

  test('a tool line can never retire a spoken one — nobody said it', () => {
    const live = [utterance({ id: 's1', text: 'bun test' })];
    const record = [
      entry({ cursor: 1, kind: 'tool', name: 'run_command', text: 'bun test', outcome: 'ok' }),
    ];
    expect(unrecordedLive(live, record)).toHaveLength(1);
  });

  test("the Kortix agent's own recorded line retires the voice echo of it", () => {
    // Both are role 'agent' server-side; either one landing means the words
    // are in the record, so the live copy is redundant.
    const live = [
      utterance({ id: 's1', text: 'The deploy finished.', isLocal: false, name: 'Kortix' }),
    ];
    const record = [
      entry({ cursor: 1, kind: 'kortix', name: 'Kortix agent', text: 'The deploy finished.' }),
    ];
    expect(unrecordedLive(live, record)).toEqual([]);
  });
});
