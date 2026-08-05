import type { Part, ToolPart } from '@/ui';
import { describe, expect, test } from 'bun:test';

import { buildTranscriptRows } from './transcript-rows';

// ---------------------------------------------------------------------------
// Fixtures — the shapes `buildTranscriptRows` actually reads, nothing more.
// ---------------------------------------------------------------------------

function tool(id: string, name = 'read'): ToolPart {
  return {
    id,
    type: 'tool',
    tool: name,
    callID: `call_${id}`,
    state: { status: 'completed' },
  } as unknown as ToolPart;
}

function text(id: string, body = 'hello'): Part {
  return { id, type: 'text', text: body } as unknown as Part;
}

/** A turn whose assistant parts alternate text/tool, so `segmentTurn` splits
 *  them into `count` separate segments — the real shape of an agent session. */
function turnWithSegments(turnId: string, count: number) {
  const parts: Part[] = [];
  for (let i = 0; i < count; i++) {
    // A text part closes a burst, so text/tool/text/tool yields one segment each.
    parts.push(i % 2 === 0 ? text(`${turnId}-p${i}`) : tool(`${turnId}-p${i}`));
  }
  return {
    userMessage: { info: { id: turnId, role: 'user' } },
    assistantMessages: [{ info: { id: `${turnId}-a`, role: 'assistant' }, parts }],
  };
}

describe('buildTranscriptRows', () => {
  // ── The regression that PR #6104 shipped ────────────────────────────────
  // Its virtualizer counted TURNS. A Kortix turn spans an entire agent
  // session, so a 324-segment thread was `count: 1` and nothing was ever
  // windowed. This is the assertion that fails on that design.
  test('a single turn with many segments produces many rows, not one', () => {
    const rows = buildTranscriptRows([turnWithSegments('u1', 324)]);

    expect(rows.length).toBeGreaterThan(300);
  });

  test('a turn yields a head row, one row per segment, and a tail row', () => {
    const rows = buildTranscriptRows([turnWithSegments('u1', 3)]);

    expect(rows.map((r) => r.kind)).toEqual([
      'turn-head',
      'segment',
      'segment',
      'segment',
      'turn-tail',
    ]);
  });

  test('every row carries the id of the turn it belongs to', () => {
    const rows = buildTranscriptRows([turnWithSegments('u1', 2), turnWithSegments('u2', 2)]);

    expect(rows.filter((r) => r.turnId === 'u1')).toHaveLength(4);
    expect(rows.filter((r) => r.turnId === 'u2')).toHaveLength(4);
  });

  // ── isTrailing ──────────────────────────────────────────────────────────
  // ActivityBurst renders open-vs-collapsed off `index === segments.length-1`,
  // a 24px <-> 487px difference. Computed from a window slice it would be
  // wrong for every row, so it is resolved against the FULL segment array.
  test('isTrailing is set on the last segment of a turn and no other', () => {
    const rows = buildTranscriptRows([turnWithSegments('u1', 4)]);
    const segments = rows.filter((r) => r.kind === 'segment');

    expect(segments.map((r) => r.isTrailing)).toEqual([false, false, false, true]);
  });

  test('isTrailing is per turn, so an earlier turn still marks its own last segment', () => {
    const rows = buildTranscriptRows([turnWithSegments('u1', 2), turnWithSegments('u2', 2)]);
    const trailing = rows.filter((r) => r.kind === 'segment' && r.isTrailing);

    expect(trailing.map((r) => r.turnId)).toEqual(['u1', 'u2']);
  });

  // ── Keys ────────────────────────────────────────────────────────────────
  test('row keys are unique across the whole transcript', () => {
    const rows = buildTranscriptRows([turnWithSegments('u1', 5), turnWithSegments('u2', 5)]);
    const keys = rows.map((r) => r.key);

    expect(new Set(keys).size).toBe(keys.length);
  });

  // The virtualizer caches measured sizes by key. A key that changes on a
  // streamed token would throw away every measurement each tick.
  test('appending a segment leaves the earlier rows keys untouched', () => {
    const before = buildTranscriptRows([turnWithSegments('u1', 3)]);
    const after = buildTranscriptRows([turnWithSegments('u1', 4)]);

    const beforeSegmentKeys = before.filter((r) => r.kind === 'segment').map((r) => r.key);
    const afterSegmentKeys = after.filter((r) => r.kind === 'segment').map((r) => r.key);

    expect(afterSegmentKeys.slice(0, 3)).toEqual(beforeSegmentKeys);
  });

  // Prepending older history shifts every index. Index-derived keys would
  // remount the entire transcript on a load-older pull.
  test('prepending a turn does not change the later turn row keys', () => {
    const before = buildTranscriptRows([turnWithSegments('u2', 2)]);
    const after = buildTranscriptRows([turnWithSegments('u1', 2), turnWithSegments('u2', 2)]);

    const keysFor = (rows: ReturnType<typeof buildTranscriptRows>, id: string) =>
      rows.filter((r) => r.turnId === id).map((r) => r.key);

    expect(keysFor(after, 'u2')).toEqual(keysFor(before, 'u2'));
  });

  // ── Edges ───────────────────────────────────────────────────────────────
  test('a turn with no assistant parts still renders its head and tail', () => {
    const rows = buildTranscriptRows([
      { userMessage: { info: { id: 'u1' } }, assistantMessages: [] },
    ]);

    expect(rows.map((r) => r.kind)).toEqual(['turn-head', 'turn-tail']);
  });

  test('an empty transcript produces no rows', () => {
    expect(buildTranscriptRows([])).toEqual([]);
  });

  // ── Turns that have no segment list at all ──────────────────────────────
  // SessionTurnImpl early-returns for shell-mode turns and compaction cards:
  // neither renders a segment region, so neither can be split into
  // head/segments/tail. They occupy exactly one row.
  test('a single-row turn collapses to one row instead of a head and tail', () => {
    const rows = buildTranscriptRows([turnWithSegments('u1', 3)], {
      singleRowKindFor: () => 'compaction',
    });

    expect(rows.map((r) => r.kind)).toEqual(['turn-single']);
  });

  test('a single-row turn carries which kind it is, so the renderer can branch', () => {
    const rows = buildTranscriptRows([turnWithSegments('u1', 1)], {
      singleRowKindFor: () => 'shell',
    });

    expect(rows[0]).toMatchObject({ kind: 'turn-single', singleRowKind: 'shell', turnId: 'u1' });
  });

  test('single-row and split turns coexist in one transcript', () => {
    const rows = buildTranscriptRows([turnWithSegments('u1', 2), turnWithSegments('u2', 2)], {
      singleRowKindFor: (turn) => (turn.userMessage.info.id === 'u1' ? 'shell' : null),
    });

    expect(rows.map((r) => r.kind)).toEqual([
      'turn-single',
      'turn-head',
      'segment',
      'segment',
      'turn-tail',
    ]);
  });

  test('turnIndex identifies the first turn, which renders without a top gap', () => {
    const rows = buildTranscriptRows([turnWithSegments('u1', 1), turnWithSegments('u2', 1)]);
    const heads = rows.filter((r) => r.kind === 'turn-head');

    expect(heads.map((r) => r.turnIndex)).toEqual([0, 1]);
  });
});
