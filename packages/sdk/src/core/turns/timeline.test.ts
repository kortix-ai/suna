import { describe, expect, test } from 'bun:test';
import {
  constructTimelineRows,
  reuseTimelineRows,
  MESSAGE_ABORTED_ERROR_NAME,
  type ConstructTimelineRowsOptions,
  type TimelineAssistantPartRow,
  type TimelineDiffSummaryRow,
  type TimelineErrorRow,
  type TimelineMessageLike,
  type TimelineRow,
  type TimelineTurnDividerRow,
} from './timeline';
import { isToolPart } from './parts';
import type { PartLike, ToolPartLike } from './types';

// ============================================================================
// Fixtures
// ============================================================================

type Part = PartLike & Record<string, unknown>;

interface Msg extends TimelineMessageLike {
  info: {
    id: string;
    role: string;
    parentID?: string;
    error?: unknown;
    time?: { created?: number };
    summary?: { diffs?: unknown[] };
  };
  parts: Part[];
}

/** A well-formed wire id so `compareMessagesForDisplay` treats it as PLACED. */
function wireId(n: number): string {
  return `msg_${n.toString(16).padStart(12, '0')}`;
}

function text(t: string, id?: string): Part {
  return id === undefined ? { type: 'text', text: t } : { type: 'text', text: t, id };
}

function reasoning(t: string, id?: string): Part {
  return id === undefined ? { type: 'reasoning', text: t } : { type: 'reasoning', text: t, id };
}

function tool(name: string, id?: string, callID = `call_${id ?? name}`): Part {
  const base: Part = { type: 'tool', tool: name, callID, state: { status: 'completed' } };
  if (id !== undefined) base.id = id;
  return base;
}

function compaction(id = 'cmp'): Part {
  return { type: 'compaction', id };
}

function user(
  id: string,
  parts: Part[] = [text('hi', `${id}-p0`)],
  summary?: { diffs?: unknown[] },
): Msg {
  return { info: summary ? { id, role: 'user', summary } : { id, role: 'user' }, parts };
}

function assistant(id: string, parentID: string, parts: Part[] = [], error?: unknown): Msg {
  return {
    info:
      error === undefined
        ? { id, role: 'assistant', parentID }
        : { id, role: 'assistant', parentID, error },
    parts,
  };
}

const ABORT = { name: MESSAGE_ABORTED_ERROR_NAME, message: 'aborted' };

/** Groups the four OpenCode "context" tools — injected, never tabled in the SDK. */
const CONTEXT_TOOLS = new Set(['read', 'glob', 'grep', 'list']);
const groupContextTools: ConstructTimelineRowsOptions<Msg>['groupPart'] = (part) => {
  if (!isToolPart(part)) return undefined;
  return CONTEXT_TOOLS.has((part as PartLike as ToolPartLike).tool) ? 'context' : undefined;
};

function kinds(rows: readonly TimelineRow[]): string[] {
  return rows.map((r) => r.kind);
}

function keys(rows: readonly TimelineRow[]): string[] {
  return rows.map((r) => r.key);
}

function partRows(rows: readonly TimelineRow[]): TimelineAssistantPartRow[] {
  return rows.filter((r): r is TimelineAssistantPartRow => r.kind === 'assistant-part');
}

function groupPartIds(row: TimelineAssistantPartRow): string[] {
  return row.group.type === 'context'
    ? row.group.refs.map((r) => r.partID)
    : [row.group.ref.partID];
}

function rowOfKind<K extends TimelineRow['kind']>(
  rows: readonly TimelineRow[],
  kind: K,
): Extract<TimelineRow, { kind: K }> | undefined {
  return rows.find((r): r is Extract<TimelineRow, { kind: K }> => r.kind === kind);
}

// ============================================================================

describe('constructTimelineRows — row kinds', () => {
  test('emits exactly one user-message row per turn, and nothing else, for a bare user message', () => {
    const rows = constructTimelineRows([user(wireId(1))]);
    expect(kinds(rows)).toEqual(['user-message']);
    expect(rows[0].userMessageID).toBe(wireId(1));
  });

  test('emits a turn-gap before every turn after the first, and never before the first', () => {
    const rows = constructTimelineRows([user(wireId(1)), user(wireId(2)), user(wireId(3))]);
    expect(kinds(rows)).toEqual([
      'user-message',
      'turn-gap',
      'user-message',
      'turn-gap',
      'user-message',
    ]);
    expect(rows[1].userMessageID).toBe(wireId(2));
    expect(rows[3].userMessageID).toBe(wireId(3));
  });

  test('emits one assistant-part row per renderable part, at part granularity', () => {
    const rows = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1'), text('b', 'p2'), text('c', 'p3')]),
    ]);
    expect(kinds(rows)).toEqual([
      'user-message',
      'assistant-part',
      'assistant-part',
      'assistant-part',
    ]);
    expect(partRows(rows).map(groupPartIds)).toEqual([['p1'], ['p2'], ['p3']]);
  });

  test('emits a turn-divider{compaction} between the user message and the assistant parts when a user part is a compaction', () => {
    const rows = constructTimelineRows([
      user(wireId(1), [compaction(), text('go', 'u1')]),
      assistant(wireId(2), wireId(1), [text('a', 'p1')]),
    ]);
    expect(kinds(rows)).toEqual(['user-message', 'turn-divider', 'assistant-part']);
    expect((rows[1] as TimelineTurnDividerRow).label).toBe('compaction');
  });

  test('emits turn-divider{interrupted} INSIDE the assistant run, at the aborted message position', () => {
    const rows = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1')]),
      assistant(wireId(3), wireId(1), [text('b', 'p2')], ABORT),
    ]);
    expect(kinds(rows)).toEqual([
      'user-message',
      'assistant-part',
      'turn-divider',
      'assistant-part',
    ]);
    expect((rows[2] as TimelineTurnDividerRow).label).toBe('interrupted');
  });

  test('a compaction turn suppresses the interrupted divider even when an abort exists', () => {
    const rows = constructTimelineRows([
      user(wireId(1), [compaction()]),
      assistant(wireId(2), wireId(1), [text('a', 'p1')], ABORT),
    ]);
    const dividers = rows.filter((r): r is TimelineTurnDividerRow => r.kind === 'turn-divider');
    expect(dividers).toHaveLength(1);
    expect(dividers[0].label).toBe('compaction');
  });

  test('an abort renders as the interrupted divider and never as an error row', () => {
    const rows = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1')], ABORT),
    ]);
    expect(kinds(rows)).toEqual(['user-message', 'turn-divider', 'assistant-part']);
    expect(rowOfKind(rows, 'error')).toBeUndefined();
    // The abort literal is an OpenCode wire string, not a repo constant. Pin it.
    expect(MESSAGE_ABORTED_ERROR_NAME).toBe('MessageAbortedError');
  });

  test('emits an error row carrying unwrapError() text for the last assistant message error', () => {
    const rows = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1')], {
        name: 'ProviderError',
        message: 'Insufficient credits',
      }),
    ]);
    const error = rowOfKind(rows, 'error');
    expect(error).toBeDefined();
    expect((error as TimelineErrorRow).text).toBe('Insufficient credits');
    expect(rows[rows.length - 1]).toBe(error as TimelineRow);
  });

  test('a later clean assistant message clears the error row entirely', () => {
    const rows = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1')], { name: 'X', message: 'boom' }),
      assistant(wireId(3), wireId(1), [text('b', 'p2')]),
    ]);
    expect(kinds(rows)).toEqual(['user-message', 'assistant-part', 'assistant-part']);
    expect(rowOfKind(rows, 'error')).toBeUndefined();
  });

  test('emits a thinking row only while the ACTIVE turn is busy with no error', () => {
    const messages = [
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1')]),
      user(wireId(3)),
      assistant(wireId(4), wireId(3), [text('b', 'p2')]),
    ];
    const thinking = constructTimelineRows(messages, {
      status: 'busy',
      activeUserMessageID: wireId(3),
    }).filter((r) => r.kind === 'thinking');
    expect(thinking).toHaveLength(1);
    expect(thinking[0].userMessageID).toBe(wireId(3));

    // Idle: no thinking anywhere.
    expect(
      constructTimelineRows(messages, { status: 'idle', activeUserMessageID: wireId(3) }).filter(
        (r) => r.kind === 'thinking',
      ),
    ).toHaveLength(0);

    // Busy with an error on the active turn: no thinking.
    const withError = [
      messages[0],
      messages[1],
      messages[2],
      assistant(wireId(4), wireId(3), [text('b', 'p2')], { message: 'boom' }),
    ];
    expect(
      constructTimelineRows(withError, { status: 'busy', activeUserMessageID: wireId(3) }).filter(
        (r) => r.kind === 'thinking',
      ),
    ).toHaveLength(0);
  });

  test('showReasoning suppresses the thinking row once the turn has a renderable part', () => {
    const messages = [user(wireId(1)), assistant(wireId(2), wireId(1), [text('a', 'p1')])];
    const opts = { status: 'busy' as const, activeUserMessageID: wireId(1) };
    expect(constructTimelineRows(messages, opts).some((r) => r.kind === 'thinking')).toBe(true);
    expect(
      constructTimelineRows(messages, { ...opts, showReasoning: true }).some(
        (r) => r.kind === 'thinking',
      ),
    ).toBe(false);
    // …but with no renderable part yet, showReasoning still shows it.
    expect(
      constructTimelineRows([user(wireId(1))], { ...opts, showReasoning: true }).some(
        (r) => r.kind === 'thinking',
      ),
    ).toBe(true);
  });

  test('emits a retry row only when the active turn status is retry', () => {
    const messages = [user(wireId(1)), user(wireId(2))];
    const retry = constructTimelineRows(messages, {
      status: 'retry',
      activeUserMessageID: wireId(2),
    }).filter((r) => r.kind === 'retry');
    expect(retry).toHaveLength(1);
    expect(retry[0].userMessageID).toBe(wireId(2));
    expect(
      constructTimelineRows(messages, { status: 'busy', activeUserMessageID: wireId(2) }).some(
        (r) => r.kind === 'retry',
      ),
    ).toBe(false);
  });

  test('thinking and error never coexist, and thinking and retry never coexist', () => {
    const withError = constructTimelineRows(
      [user(wireId(1)), assistant(wireId(2), wireId(1), [text('a', 'p1')], { message: 'boom' })],
      { status: 'busy', activeUserMessageID: wireId(1) },
    );
    expect(withError.some((r) => r.kind === 'error')).toBe(true);
    expect(withError.some((r) => r.kind === 'thinking')).toBe(false);

    const onRetry = constructTimelineRows([user(wireId(1))], {
      status: 'retry',
      activeUserMessageID: wireId(1),
    });
    expect(onRetry.some((r) => r.kind === 'retry')).toBe(true);
    expect(onRetry.some((r) => r.kind === 'thinking')).toBe(false);
  });

  test('emits a diff-summary row on a settled turn and suppresses it on a busy active turn', () => {
    const messages = [
      user(wireId(1), [text('go', 'u1')], {
        diffs: [{ file: 'a.ts', additions: 3, deletions: 1 }],
      }),
    ];
    expect(
      constructTimelineRows(messages, { status: 'idle', activeUserMessageID: wireId(1) }).some(
        (r) => r.kind === 'diff-summary',
      ),
    ).toBe(true);
    expect(
      constructTimelineRows(messages, { status: 'busy', activeUserMessageID: wireId(1) }).some(
        (r) => r.kind === 'diff-summary',
      ),
    ).toBe(false);
    // Busy, but this turn is NOT the active one → still shown.
    const twoTurns = [...messages, user(wireId(2))];
    const rows = constructTimelineRows(twoTurns, {
      status: 'busy',
      activeUserMessageID: wireId(2),
    });
    expect(rows.filter((r) => r.kind === 'diff-summary').map((r) => r.userMessageID)).toEqual([
      wireId(1),
    ]);
  });

  test('diff-summary dedupes by file, last write wins, original order preserved', () => {
    const rows = constructTimelineRows([
      user(wireId(1), [text('go', 'u1')], {
        diffs: [
          { file: 'a.ts', additions: 1, deletions: 0 },
          { file: 'b.ts', additions: 2, deletions: 0 },
          { file: 'a.ts', additions: 9, deletions: 4 },
        ],
      }),
    ]);
    const summary = rowOfKind(rows, 'diff-summary') as TimelineDiffSummaryRow;
    expect(summary.diffs).toEqual([
      { file: 'b.ts', additions: 2, deletions: 0 },
      { file: 'a.ts', additions: 9, deletions: 4 },
    ]);
  });

  test('diff-summary projects file/additions/deletions and DROPS before, after, and patch', () => {
    const rows = constructTimelineRows([
      user(wireId(1), [text('go', 'u1')], {
        diffs: [
          {
            file: 'a.ts',
            additions: 3,
            deletions: 1,
            status: 'modified',
            before: 'x'.repeat(1000),
            after: 'y'.repeat(1000),
            patch: 'z'.repeat(1000),
          },
        ],
      }),
    ]);
    const summary = rowOfKind(rows, 'diff-summary') as TimelineDiffSummaryRow;
    expect(summary.diffs).toHaveLength(1);
    expect(Object.keys(summary.diffs[0]).sort()).toEqual([
      'additions',
      'deletions',
      'file',
      'status',
    ]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('xxx');
    expect(serialized).not.toContain('yyy');
    expect(serialized).not.toContain('zzz');
  });
});

describe('constructTimelineRows — ordering', () => {
  test('a full turn emits turn-gap, user-message, compaction divider, parts, thinking, retry, diff-summary, error in that exact order', () => {
    // The canonical per-turn order. Three of these kinds are mutually
    // exclusive by construction — `thinking` needs status 'busy', `retry`
    // needs status 'retry', and `thinking` needs NO error — so no single call
    // can emit all eight. Each variant below must be a SUBSEQUENCE of the
    // canonical order, and the three variants together cover all eight kinds.
    const CANONICAL = [
      'turn-gap',
      'user-message',
      'turn-divider',
      'assistant-part',
      'thinking',
      'retry',
      'diff-summary',
      'error',
    ];
    const isSubsequence = (got: string[]): boolean => {
      let i = 0;
      for (const kind of got) {
        while (i < CANONICAL.length && CANONICAL[i] !== kind) i++;
        if (i === CANONICAL.length) return false;
        i++;
      }
      return true;
    };

    const base = (extra?: unknown) => [
      user(wireId(1)),
      user(wireId(2), [compaction(), text('go', 'u2')], {
        diffs: [{ file: 'a.ts', additions: 1, deletions: 0 }],
      }),
      assistant(wireId(3), wireId(2), [text('a', 'p1')], extra),
    ];

    const busy = constructTimelineRows(base(), {
      status: 'busy',
      activeUserMessageID: wireId(2),
    }).slice(1);
    expect(kinds(busy)).toEqual([
      'turn-gap',
      'user-message',
      'turn-divider',
      'assistant-part',
      'thinking',
    ]);
    expect(isSubsequence(kinds(busy))).toBe(true);

    const retrying = constructTimelineRows(base(), {
      status: 'retry',
      activeUserMessageID: wireId(2),
    }).slice(1);
    expect(kinds(retrying)).toEqual([
      'turn-gap',
      'user-message',
      'turn-divider',
      'assistant-part',
      'retry',
    ]);
    expect(isSubsequence(kinds(retrying))).toBe(true);

    const failed = constructTimelineRows(base({ message: 'boom' }), {
      status: 'idle',
      activeUserMessageID: wireId(2),
    }).slice(1);
    expect(kinds(failed)).toEqual([
      'turn-gap',
      'user-message',
      'turn-divider',
      'assistant-part',
      'diff-summary',
      'error',
    ]);
    expect(isSubsequence(kinds(failed))).toBe(true);

    const covered = new Set([...kinds(busy), ...kinds(retrying), ...kinds(failed)]);
    expect([...covered].sort()).toEqual([...CANONICAL].sort());
  });

  test('rows follow display order across turns — the second turn rows all follow the first turn', () => {
    // Deliberately handed over out of order; display order is by wire id.
    const rows = constructTimelineRows([
      assistant(wireId(4), wireId(3), [text('b', 'p2')]),
      user(wireId(3)),
      assistant(wireId(2), wireId(1), [text('a', 'p1')]),
      user(wireId(1)),
    ]);
    const lastOfFirst = rows.map((r) => r.userMessageID).lastIndexOf(wireId(1));
    const firstOfSecond = rows.findIndex((r) => r.userMessageID === wireId(3));
    expect(firstOfSecond).toBeGreaterThan(lastOfFirst);
    expect(rows.map((r) => r.userMessageID)).toEqual([
      wireId(1),
      wireId(1),
      wireId(3),
      wireId(3),
      wireId(3),
    ]);
  });

  test('previousAssistantPart is false only on the first part row of a turn, and the interrupted divider does not advance the counter', () => {
    const rows = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1'), text('b', 'p2')], ABORT),
    ]);
    expect(kinds(rows)).toEqual([
      'user-message',
      'turn-divider',
      'assistant-part',
      'assistant-part',
    ]);
    expect(partRows(rows).map((r) => r.previousAssistantPart)).toEqual([false, true]);
  });

  test('a hidden tool part produces no row and does not split a group', () => {
    const rows = constructTimelineRows(
      [
        user(wireId(1)),
        assistant(wireId(2), wireId(1), [
          tool('read', 'p1'),
          tool('todoread', 'p2'),
          tool('read', 'p3'),
        ]),
      ],
      { groupPart: groupContextTools },
    );
    const parts = partRows(rows);
    expect(parts).toHaveLength(1);
    expect(parts[0].group.type).toBe('context');
    expect(groupPartIds(parts[0])).toEqual(['p1', 'p3']);
  });

  test('reasoning parts produce rows only when showReasoning is true', () => {
    const messages = [
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [reasoning('hmm', 'p1'), text('a', 'p2')]),
    ];
    expect(partRows(constructTimelineRows(messages))).toHaveLength(1);
    expect(partRows(constructTimelineRows(messages, { showReasoning: true }))).toHaveLength(2);
  });
});

describe('constructTimelineRows — keys', () => {
  function bigSession(turnCount: number, partsPerTurn: number): Msg[] {
    const out: Msg[] = [];
    let n = 1;
    for (let t = 0; t < turnCount; t++) {
      const uid = wireId(n++);
      out.push(
        user(uid, [text('go', `${uid}-u`)], {
          diffs: [{ file: `f${t}.ts`, additions: 1, deletions: 0 }],
        }),
      );
      const aid = wireId(n++);
      out.push(
        assistant(
          aid,
          uid,
          Array.from({ length: partsPerTurn }, (_, i) => text(`p${i}`, `${aid}-p${i}`)),
        ),
      );
    }
    return out;
  }

  test('every row key is unique across a 3-turn session with 40 parts', () => {
    const rows = constructTimelineRows(bigSession(3, 40));
    expect(partRows(rows)).toHaveLength(120);
    expect(new Set(keys(rows)).size).toBe(rows.length);
  });

  test('duplicate part ids inside one message still produce unique keys', () => {
    const rows = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'dup'), text('b', 'dup'), text('c', 'dup')]),
    ]);
    expect(partRows(rows)).toHaveLength(3);
    expect(new Set(keys(rows)).size).toBe(rows.length);
  });

  test('every row key encodes its kind, so no two kinds can share a key', () => {
    const rows = constructTimelineRows(
      [
        user(wireId(1)),
        user(wireId(2), [compaction(), text('go', 'u2')], {
          diffs: [{ file: 'a.ts', additions: 1, deletions: 0 }],
        }),
        assistant(wireId(3), wireId(2), [text('a', 'p1')], { message: 'boom' }),
      ],
      { status: 'idle', activeUserMessageID: wireId(2) },
    );
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) expect(row.key.startsWith(`${row.kind}:`)).toBe(true);
  });

  test('a key contains no index — appending a turn leaves every earlier key byte-identical', () => {
    const before = constructTimelineRows(bigSession(2, 3));
    const after = constructTimelineRows([...bigSession(2, 3), user(wireId(99))]);
    expect(before.length).toBe(11);
    expect(after.length).toBe(13);
    expect(keys(after).slice(0, before.length)).toEqual(keys(before));
    for (const key of keys(before)) expect(/:\d+$/.test(key)).toBe(false);
  });

  test('the two turn-dividers of one turn get distinct keys via their label', () => {
    // They can never co-occur (compaction suppresses interrupted), so the
    // label must still be part of the key formula. Same userMessageID, two
    // sessions, two labels → two distinct keys.
    const compacted = constructTimelineRows([
      user(wireId(1), [compaction()]),
      assistant(wireId(2), wireId(1), [text('a', 'p1')]),
    ]);
    const interrupted = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1')], ABORT),
    ]);
    const a = rowOfKind(compacted, 'turn-divider') as TimelineTurnDividerRow;
    const b = rowOfKind(interrupted, 'turn-divider') as TimelineTurnDividerRow;
    expect(a.userMessageID).toBe(b.userMessageID);
    expect(a.key).not.toBe(b.key);
    expect(a.key).toContain('compaction');
    expect(b.key).toContain('interrupted');
  });

  test('a context group key is pinned to its first member', () => {
    const rows = constructTimelineRows(
      [
        user(wireId(1)),
        assistant(wireId(2), wireId(1), [
          tool('read', 'p1'),
          tool('grep', 'p2'),
          tool('list', 'p3'),
        ]),
      ],
      { groupPart: groupContextTools },
    );
    const parts = partRows(rows);
    expect(parts).toHaveLength(1);
    expect(parts[0].group.key).toBe(`context:${wireId(2)}:p1`);
    expect(parts[0].key).toBe(`assistant-part:${wireId(1)}:context:${wireId(2)}:p1`);
  });
});

// ============================================================================
// reuseTimelineRows
// ============================================================================

describe('reuseTimelineRows — reuse when equal', () => {
  const session = (): Msg[] => [
    user(wireId(1), [text('go', 'u1')], { diffs: [{ file: 'a.ts', additions: 1, deletions: 0 }] }),
    assistant(wireId(2), wireId(1), [text('a', 'p1'), text('b', 'p2')]),
    user(wireId(3)),
    assistant(wireId(4), wireId(3), [text('c', 'p3')]),
  ];

  test('an identical rebuild returns the PREVIOUS ARRAY itself, not a copy', () => {
    const prev = constructTimelineRows(session());
    const next = constructTimelineRows(session());
    expect(next).not.toBe(prev);
    expect(reuseTimelineRows(prev, next)).toBe(prev);
  });

  test('every unchanged row comes back as the previous OBJECT by identity', () => {
    const prev = constructTimelineRows(session());
    const next = constructTimelineRows(session());
    const out = reuseTimelineRows(prev, next);
    expect(prev.length).toBe(7);
    expect(out).toHaveLength(prev.length);
    out.forEach((row, i) => expect(row).toBe(prev[i]));
  });

  test('a re-allocated but structurally identical diff-summary row is still reused', () => {
    const prev = constructTimelineRows(session());
    const next = constructTimelineRows(session());
    const prevSummary = rowOfKind(prev, 'diff-summary');
    const nextSummary = rowOfKind(next, 'diff-summary');
    expect(prevSummary).toBeDefined();
    expect(nextSummary).not.toBe(prevSummary);
    const out = reuseTimelineRows(prev, next);
    expect(rowOfKind(out, 'diff-summary') as TimelineRow | undefined).toBe(prevSummary);
  });

  test('a streaming text part whose body changes does NOT change its row — the row holds only ids', () => {
    const prev = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('Hel', 'p1')]),
    ]);
    const next = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('Hello world, much longer now', 'p1')]),
    ]);
    expect(reuseTimelineRows(prev, next)).toBe(prev);
  });

  test('it is idempotent, so a StrictMode double render yields the same objects', () => {
    const prev = constructTimelineRows(session());
    const next = constructTimelineRows([
      ...session().slice(0, 3),
      assistant(wireId(4), wireId(3), [text('c', 'p3'), text('d', 'p4')]),
    ]);
    const once = reuseTimelineRows(prev, next);
    expect(once).toHaveLength(prev.length + 1);
    const twice = reuseTimelineRows(once, next);
    expect(twice).toBe(once);
    twice.forEach((row, i) => expect(row).toBe(once[i]));
  });
});

describe('reuseTimelineRows — take new when changed', () => {
  test('a changed error text takes the new row and leaves every sibling reused', () => {
    const build = (msg: string) =>
      constructTimelineRows([
        user(wireId(1)),
        assistant(wireId(2), wireId(1), [text('a', 'p1')], { message: msg }),
      ]);
    const prev = build('boom');
    const next = build('kaboom');
    const out = reuseTimelineRows(prev, next);
    expect(out).not.toBe(prev);
    const changedIndex = out.findIndex((r) => r.kind === 'error');
    out.forEach((row, i) => {
      if (i === changedIndex) {
        expect(row).toBe(next[i]);
        expect(row).not.toBe(prev[i]);
      } else {
        expect(row).toBe(prev[i]);
      }
    });
    expect((out[changedIndex] as TimelineErrorRow).text).toBe('kaboom');
  });

  test('a turn-divider whose label flips takes the new row', () => {
    const prev = constructTimelineRows([
      user(wireId(1), [compaction()]),
      assistant(wireId(2), wireId(1), [text('a', 'p1')]),
    ]);
    const next = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1')], ABORT),
    ]);
    const out = reuseTimelineRows(prev, next);
    const divider = rowOfKind(out, 'turn-divider') as TimelineTurnDividerRow;
    expect(divider.label).toBe('interrupted');
    expect(divider as TimelineRow).toBe(rowOfKind(next, 'turn-divider') as TimelineRow);
  });

  test('a diff-summary whose additions count changes takes the new row', () => {
    const build = (additions: number) =>
      constructTimelineRows([
        user(wireId(1), [text('go', 'u1')], { diffs: [{ file: 'a.ts', additions, deletions: 0 }] }),
      ]);
    const prev = build(1);
    const next = build(2);
    const out = reuseTimelineRows(prev, next);
    expect(kinds(out)).toEqual(['user-message', 'diff-summary']);
    expect(rowOfKind(out, 'diff-summary') as TimelineRow | undefined).toBe(
      rowOfKind(next, 'diff-summary') as TimelineRow | undefined,
    );
    expect(rowOfKind(out, 'user-message') as TimelineRow | undefined).toBe(
      rowOfKind(prev, 'user-message') as TimelineRow | undefined,
    );
  });

  test('a context group that gains a member keeps its KEY but takes the new row', () => {
    const opts = { groupPart: groupContextTools };
    const prev = constructTimelineRows(
      [user(wireId(1)), assistant(wireId(2), wireId(1), [tool('read', 'p1')])],
      opts,
    );
    const next = constructTimelineRows(
      [user(wireId(1)), assistant(wireId(2), wireId(1), [tool('read', 'p1'), tool('grep', 'p2')])],
      opts,
    );
    const out = reuseTimelineRows(prev, next);
    const prevGroup = partRows(prev)[0];
    const outGroup = partRows(out)[0];
    expect(outGroup.key).toBe(prevGroup.key);
    expect(outGroup).not.toBe(prevGroup);
    expect(groupPartIds(outGroup)).toEqual(['p1', 'p2']);
  });

  test('a previousAssistantPart flip takes the new row', () => {
    const prev = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1'), text('b', 'p2')]),
    ]);
    // Drop p1 → p2 becomes the FIRST part row, so its previousAssistantPart flips.
    const next = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('b', 'p2')]),
    ]);
    const prevP2 = partRows(prev)[1];
    expect(prevP2.previousAssistantPart).toBe(true);
    const out = reuseTimelineRows(prev, next);
    const outP2 = partRows(out)[0];
    expect(outP2.key).toBe(prevP2.key);
    expect(outP2.previousAssistantPart).toBe(false);
    expect(outP2).not.toBe(prevP2);
  });

  test('a removed row shortens the list and never re-uses the wrong slot', () => {
    const prev = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1'), text('b', 'p2'), text('c', 'p3')]),
    ]);
    const next = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1'), text('c', 'p3')]),
    ]);
    const out = reuseTimelineRows(prev, next);
    expect(out).toHaveLength(3);
    expect(keys(out)).toEqual(keys(next));
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(prev[1]);
    // p3's row survives by key, and its previousAssistantPart is unchanged
    // (still true), so the previous object is reused — from index 3, not 2.
    expect(out[2]).toBe(prev[3]);
  });

  test('a row whose kind changed under the same userMessageID is never reused, because the key differs', () => {
    const prev = constructTimelineRows([user(wireId(1))], {
      status: 'busy',
      activeUserMessageID: wireId(1),
    });
    const next = constructTimelineRows([user(wireId(1))], {
      status: 'retry',
      activeUserMessageID: wireId(1),
    });
    expect(kinds(prev)).toEqual(['user-message', 'thinking']);
    expect(kinds(next)).toEqual(['user-message', 'retry']);
    const out = reuseTimelineRows(prev, next);
    expect(out[0]).toBe(prev[0]);
    expect(out[1]).toBe(next[1]);
    expect(out[1].kind).toBe('retry');
  });
});

describe('reuseTimelineRows — context key stabilization', () => {
  const opts = { groupPart: groupContextTools };
  const build = (parts: Part[]) =>
    constructTimelineRows([user(wireId(1)), assistant(wireId(2), wireId(1), parts)], opts);

  test('a context group gaining a tail member keeps its original key', () => {
    const prev = build([tool('read', 'p1'), tool('grep', 'p2')]);
    const next = build([tool('read', 'p1'), tool('grep', 'p2'), tool('list', 'p3')]);
    const out = reuseTimelineRows(prev, next);
    expect(partRows(out)[0].key).toBe(partRows(prev)[0].key);
  });

  test('a context group whose FIRST member disappears still keeps its original key', () => {
    const prev = build([tool('read', 'p1'), tool('grep', 'p2'), tool('list', 'p3')]);
    const next = build([tool('grep', 'p2'), tool('list', 'p3')]);
    // Without stabilization the key would rename itself to p2's.
    expect(partRows(next)[0].key).not.toBe(partRows(prev)[0].key);
    const out = reuseTimelineRows(prev, next);
    expect(partRows(out)[0].key).toBe(partRows(prev)[0].key);
    expect(partRows(out)[0].group.key).toBe(partRows(prev)[0].group.key);
    expect(groupPartIds(partRows(out)[0])).toEqual(['p2', 'p3']);
  });

  test('when two prior groups merge, the merged group takes the EARLIEST prior key', () => {
    const prev = build([
      tool('read', 'p1'),
      tool('grep', 'p2'),
      text('divider', 'p3'),
      tool('list', 'p4'),
    ]);
    expect(partRows(prev).map((r) => r.group.type)).toEqual(['context', 'part', 'context']);
    const groupAKey = partRows(prev)[0].key;
    // p1 vanishes AND the splitting text part vanishes → p2 + p4 merge.
    const next = build([tool('grep', 'p2'), tool('list', 'p4')]);
    expect(partRows(next)).toHaveLength(1);
    const out = reuseTimelineRows(prev, next);
    expect(partRows(out)).toHaveLength(1);
    expect(partRows(out)[0].key).toBe(groupAKey);
  });

  test('when a group splits, only the natural owner retains the old key', () => {
    const prev = build([tool('read', 'p1'), tool('grep', 'p2'), tool('list', 'p3')]);
    const oldKey = partRows(prev)[0].key;
    const next = build([
      tool('read', 'p1'),
      tool('grep', 'p2'),
      text('x', 'px'),
      tool('list', 'p3'),
    ]);
    const out = reuseTimelineRows(prev, next);
    const groups = partRows(out).filter((r) => r.group.type === 'context');
    expect(groups).toHaveLength(2);
    expect(groups[0].key).toBe(oldKey);
    expect(groups[1].key).not.toBe(oldKey);
    expect(groups[1].key).toBe(`assistant-part:${wireId(1)}:context:${wireId(2)}:p3`);
  });

  test('context identity is never adopted across user messages', () => {
    const prev = constructTimelineRows(
      [user(wireId(1)), assistant(wireId(2), wireId(1), [tool('read', 'p1'), tool('grep', 'p2')])],
      opts,
    );
    // Same message id and same part ids, but a DIFFERENT user message.
    const next = constructTimelineRows(
      [user(wireId(5)), assistant(wireId(2), wireId(5), [tool('grep', 'p2')])],
      opts,
    );
    const naturalKey = partRows(next)[0].key;
    const out = reuseTimelineRows(prev, next);
    expect(partRows(out)[0].key).toBe(naturalKey);
    expect(partRows(out)[0].key).toContain(wireId(5));
  });

  test('stabilized keys are still unique across the whole list', () => {
    const prev = build([
      tool('read', 'p1'),
      tool('grep', 'p2'),
      text('x', 'px'),
      tool('list', 'p3'),
      tool('read', 'p4'),
    ]);
    const next = build([
      tool('grep', 'p2'),
      text('x', 'px'),
      tool('list', 'p3'),
      tool('read', 'p4'),
      text('y', 'py'),
      tool('glob', 'p5'),
    ]);
    const out = reuseTimelineRows(prev, next);
    expect(partRows(out).filter((r) => r.group.type === 'context')).toHaveLength(3);
    expect(new Set(keys(out)).size).toBe(out.length);
  });
});

describe('reuseTimelineRows — streaming append', () => {
  test('one new assistant part yields exactly ONE new row object; every prior row is reused by identity', () => {
    const prev = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1'), text('b', 'p2')]),
    ]);
    const next = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1'), text('b', 'p2'), text('c', 'p3')]),
    ]);
    const out = reuseTimelineRows(prev, next);
    expect(out).toHaveLength(prev.length + 1);
    prev.forEach((row, i) => expect(out[i]).toBe(row));
    expect(out[out.length - 1]).toBe(next[next.length - 1]);
  });

  test('fifty settled turns keep every row identity while the last turn streams', () => {
    const settled: Msg[] = [];
    let n = 1;
    for (let t = 0; t < 50; t++) {
      const uid = wireId(n++);
      const aid = wireId(n++);
      settled.push(user(uid, [text('go', `${uid}-u`)]));
      settled.push(assistant(aid, uid, [text('done', `${aid}-p0`)]));
    }
    const prev = constructTimelineRows(settled);
    const streamed = [...settled];
    const lastAssistant = streamed[streamed.length - 1];
    streamed[streamed.length - 1] = {
      info: lastAssistant.info,
      parts: [...lastAssistant.parts, text('more', `${lastAssistant.info.id}-p1`)],
    };
    const next = constructTimelineRows(streamed);
    const out = reuseTimelineRows(prev, next);
    expect(out).toHaveLength(prev.length + 1);
    prev.forEach((row, i) => expect(out[i]).toBe(row));
  });

  test('a new turn appended leaves every earlier turn rows identical', () => {
    const before = [user(wireId(1)), assistant(wireId(2), wireId(1), [text('a', 'p1')])];
    const prev = constructTimelineRows(before);
    const next = constructTimelineRows([...before, user(wireId(3))]);
    const out = reuseTimelineRows(prev, next);
    prev.forEach((row, i) => expect(out[i]).toBe(row));
    expect(out).toHaveLength(prev.length + 2); // turn-gap + user-message
  });

  test('with grouping enabled, a part joining the trailing context group changes exactly ONE row', () => {
    const opts = { groupPart: groupContextTools };
    const base = [tool('read', 'p1'), text('mid', 'p2'), tool('grep', 'p3')];
    const prev = constructTimelineRows(
      [user(wireId(1)), assistant(wireId(2), wireId(1), base)],
      opts,
    );
    const next = constructTimelineRows(
      [user(wireId(1)), assistant(wireId(2), wireId(1), [...base, tool('list', 'p4')])],
      opts,
    );
    const out = reuseTimelineRows(prev, next);
    expect(out).toHaveLength(prev.length);
    const changed = out.filter((row, i) => row !== prev[i]);
    expect(changed).toHaveLength(1);
    expect(changed[0].kind).toBe('assistant-part');
    expect(changed[0].key).toBe(prev[prev.length - 1].key);
  });

  test('the array reference changes when the length changes, even though every prior element is reused', () => {
    const prev = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1')]),
    ]);
    const next = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a', 'p1'), text('b', 'p2')]),
    ]);
    const out = reuseTimelineRows(prev, next);
    expect(prev).toHaveLength(2);
    expect(out).toHaveLength(3);
    expect(out).not.toBe(prev);
    prev.forEach((row, i) => expect(out[i]).toBe(row));
  });
});

describe('empty and degenerate input', () => {
  test('an empty message list returns an empty row array', () => {
    expect(constructTimelineRows([])).toEqual([]);
  });

  test('reuseTimelineRows(undefined, rows) returns rows unchanged', () => {
    const rows = constructTimelineRows([user(wireId(1))]);
    expect(kinds(rows)).toEqual(['user-message']);
    expect(reuseTimelineRows(undefined, rows)).toBe(rows);
    expect(reuseTimelineRows([], rows)).toBe(rows);
  });

  test('reuseTimelineRows(prev, []) returns an empty array and never returns prev', () => {
    const prev = constructTimelineRows([user(wireId(1))]);
    expect(kinds(prev)).toEqual(['user-message']);
    const out = reuseTimelineRows(prev, []);
    expect(out).toEqual([]);
    expect(out).not.toBe(prev);
  });

  test('a session with only assistant messages renders the synthetic turn groupMessagesIntoTurns produces', () => {
    const rows = constructTimelineRows([
      assistant(wireId(2), 'nope', [text('orphan', 'p1')], { message: 'session init failed' }),
    ]);
    expect(kinds(rows)).toEqual(['user-message']);
    expect(rows[0].userMessageID).toBe(wireId(2));
  });

  test('a user message with no assistant reply emits only turn-gap and user-message', () => {
    const rows = constructTimelineRows([user(wireId(1)), user(wireId(2))]);
    expect(kinds(rows).slice(1)).toEqual(['turn-gap', 'user-message']);
  });

  test('a turn whose every part is unrenderable emits no assistant-part rows', () => {
    const rows = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [
        text('   ', 'p1'),
        tool('todoread', 'p2'),
        reasoning('r', 'p3'),
      ]),
    ]);
    expect(partRows(rows)).toHaveLength(0);
    expect(kinds(rows)).toEqual(['user-message']);
  });

  test('a part with no id falls back to a positional id and still keys uniquely', () => {
    const rows = constructTimelineRows([
      user(wireId(1)),
      assistant(wireId(2), wireId(1), [text('a'), text('b'), text('c')]),
    ]);
    const parts = partRows(rows);
    expect(parts).toHaveLength(3);
    expect(parts.map(groupPartIds)).toEqual([
      [`${wireId(2)}:#0`],
      [`${wireId(2)}:#1`],
      [`${wireId(2)}:#2`],
    ]);
    expect(new Set(keys(rows)).size).toBe(rows.length);

    // …and `getPartId` overrides it.
    const overridden = constructTimelineRows(
      [user(wireId(1)), assistant(wireId(2), wireId(1), [text('a'), text('b')])],
      { getPartId: (_part, message, index) => `${message.info.id}/custom-${index}` },
    );
    expect(partRows(overridden).map(groupPartIds)).toEqual([
      [`${wireId(2)}/custom-0`],
      [`${wireId(2)}/custom-1`],
    ]);
  });

  test('a duplicated user message id produces ONE turn and one set of rows', () => {
    const rows = constructTimelineRows([user(wireId(1)), user(wireId(1))]);
    expect(kinds(rows)).toEqual(['user-message']);
  });

  test('a malformed summary.diffs entry with a non-string file is dropped, not thrown on', () => {
    const rows = constructTimelineRows([
      user(wireId(1), [text('go', 'u1')], {
        diffs: [
          { additions: 1, deletions: 0, patch: 'x' },
          null,
          'nonsense',
          { file: 'ok.ts', additions: 2, deletions: 1 },
        ],
      }),
    ]);
    const summary = rowOfKind(rows, 'diff-summary') as TimelineDiffSummaryRow;
    expect(summary.diffs).toEqual([{ file: 'ok.ts', additions: 2, deletions: 1 }]);

    // Every entry malformed → no diff-summary row at all.
    expect(
      constructTimelineRows([
        user(wireId(1), [text('go', 'u1')], { diffs: [{ additions: 1, deletions: 0 }] }),
      ]).some((r) => r.kind === 'diff-summary'),
    ).toBe(false);
  });
});

describe('purity', () => {
  const messages = (): Msg[] => [
    user(wireId(1), [compaction(), text('go', 'u1')], {
      diffs: [{ file: 'a.ts', additions: 1, deletions: 0 }],
    }),
    assistant(wireId(2), wireId(1), [tool('read', 'p1'), text('a', 'p2')]),
    user(wireId(3)),
    assistant(wireId(4), wireId(3), [text('b', 'p3')], { message: 'boom' }),
  ];

  test('the same input built twice produces structurally equal rows in the same order', () => {
    const opts = {
      status: 'idle' as const,
      activeUserMessageID: wireId(3),
      groupPart: groupContextTools,
    };
    const a = constructTimelineRows(messages(), opts);
    const b = constructTimelineRows(messages(), opts);
    expect(kinds(a)).toEqual([
      'user-message',
      'turn-divider',
      'assistant-part',
      'assistant-part',
      'diff-summary',
      'turn-gap',
      'user-message',
      'assistant-part',
      'error',
    ]);
    expect(a).toEqual(b);
    expect(keys(a)).toEqual(keys(b));
  });

  test('constructTimelineRows does not mutate the input messages or their parts arrays', () => {
    const input = messages();
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    const partsArrays = input.map((m) => m.parts);
    expect(
      constructTimelineRows(input, { groupPart: groupContextTools, showReasoning: true }).length,
    ).toBe(9);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
    input.forEach((m, i) => expect(m.parts).toBe(partsArrays[i]));
  });
});
