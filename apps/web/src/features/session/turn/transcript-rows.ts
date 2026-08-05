/**
 * The transcript's row model — the list the virtualizer actually windows.
 *
 * PR #6104 windowed TURNS. `groupMessagesIntoTurns` defines a turn as one user
 * message plus every assistant message linked to it, so an agent session where
 * the user sends one prompt and the agent works for twenty minutes is ONE turn.
 * Measured on a real session: `count: 1`, a single 17,944px item holding 324
 * segments and 2,318 DOM nodes, and the mounted count never changed across a
 * full top-to-bottom scroll. A virtualizer with `count: 1` cannot skip anything.
 *
 * The list that actually repeats is one level down: the `Segment[]` that
 * `segmentTurn` already produces. This module flattens every turn into
 * head / segment* / tail rows so the virtualizer counts the thing that grows.
 *
 * Pure: no React, no DOM. That is what lets the property PR #6104 got wrong —
 * "is the row count larger than the turn count?" — be asserted in `bun test`,
 * which is the one check its 18 passing tests never made.
 */

import type { Part } from '@/ui';
import { collectTurnParts } from '@/ui';

import { type Segment, segmentTurn } from './segment-turn';

/** The only shape this module needs from a turn. */
export interface TranscriptTurnLike {
  userMessage: { info: { id: string } };
  assistantMessages: ReadonlyArray<{ parts: ReadonlyArray<Part> }>;
}

interface RowBase {
  /** Stable across renders and across a prepend — see `rowKey`. */
  key: string;
  turnId: string;
}

/**
 * Turns that render as one row rather than head/segments/tail.
 *
 * `SessionTurnImpl` early-returns for both: a shell-mode turn renders a
 * terminal card and a compaction turn renders a summary card. Neither has a
 * segment region, so neither can be split.
 */
export type SingleRowKind = 'shell' | 'compaction';

export type TranscriptRow =
  | (RowBase & { kind: 'turn-single'; turnIndex: number; singleRowKind: SingleRowKind })
  | (RowBase & { kind: 'turn-head'; turnIndex: number })
  | (RowBase & {
      kind: 'segment';
      segIndex: number;
      segment: Segment;
      /**
       * True only for a turn's final segment.
       *
       * `ActivityBurst` decides open-vs-collapsed from this, which is a
       * 24px <-> 487px height difference. It MUST be resolved against the
       * turn's full segment array — deriving it from a windowed slice would
       * mark whichever segment happens to be last in the window.
       */
      isTrailing: boolean;
    })
  | (RowBase & { kind: 'turn-tail'; turnIndex: number });

export type TranscriptRowKind = TranscriptRow['kind'];

/**
 * Key for one segment.
 *
 * Derived from a part id, never from an index. Part ids are stable across
 * re-renders (the sync store upserts by binary search on `p.id`), so the
 * virtualizer's measurement cache survives both a streamed token and a
 * load-older prepend that shifts every index.
 */
function segmentKey(turnId: string, segment: Segment, segIndex: number): string {
  const partId =
    segment.kind === 'burst' ? segment.parts[0]?.id : segment.part.id;
  return `${turnId}:seg:${partId ?? segIndex}`;
}

export interface BuildTranscriptRowsOptions {
  /**
   * Produces a turn's segments. Defaults to plain `segmentTurn` over the
   * turn's parts.
   *
   * The transcript injects its own: the live call filters `todowrite` and
   * unanswered `question` parts and passes `standaloneCallIds`, all of which
   * depend on turn-level state this module deliberately knows nothing about.
   */
  segmentsFor?: (turn: TranscriptTurnLike) => Segment[];
  /**
   * Marks a turn that renders as ONE row. Return null for the normal
   * head/segments/tail shape.
   *
   * Injected rather than derived here: both conditions depend on turn-level
   * state (`shellModePart`, the compaction flags) that this pure module
   * deliberately knows nothing about.
   */
  singleRowKindFor?: (turn: TranscriptTurnLike) => SingleRowKind | null;
}

function defaultSegmentsFor(turn: TranscriptTurnLike): Segment[] {
  return segmentTurn(collectTurnParts(turn as never).map(({ part }) => part as Part));
}

/** Flatten turns into the flat row list the virtualizer counts. */
export function buildTranscriptRows(
  turns: readonly TranscriptTurnLike[],
  options: BuildTranscriptRowsOptions = {},
): TranscriptRow[] {
  const segmentsFor = options.segmentsFor ?? defaultSegmentsFor;
  const singleRowKindFor = options.singleRowKindFor ?? (() => null);
  const rows: TranscriptRow[] = [];

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex++) {
    const turn = turns[turnIndex];
    const turnId = turn.userMessage.info.id;

    const singleRowKind = singleRowKindFor(turn);
    if (singleRowKind) {
      rows.push({
        kind: 'turn-single',
        key: `${turnId}:single`,
        turnId,
        turnIndex,
        singleRowKind,
      });
      continue;
    }

    rows.push({ kind: 'turn-head', key: `${turnId}:head`, turnId, turnIndex });

    const segments = segmentsFor(turn);
    const last = segments.length - 1;
    for (let segIndex = 0; segIndex < segments.length; segIndex++) {
      const segment = segments[segIndex];
      rows.push({
        kind: 'segment',
        key: segmentKey(turnId, segment, segIndex),
        turnId,
        segIndex,
        segment,
        isTrailing: segIndex === last,
      });
    }

    rows.push({ kind: 'turn-tail', key: `${turnId}:tail`, turnId, turnIndex });
  }

  return rows;
}
