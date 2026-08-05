'use client';

import { memo } from 'react';

import type { SessionTurnProps } from '../session-chat';
import type { TranscriptRow } from './transcript-rows';
import { TurnHead } from './turn-head';
import { TurnSegment, type TurnSegmentContext } from './turn-segment';
import { TurnSingle } from './turn-single';
import { TurnTail } from './turn-tail';
import { useTurnModel } from './use-turn-model';

/**
 * Renders one windowed transcript row.
 *
 * ## Why the head, tail and single rows each call `useTurnModel`, and segments do not
 *
 * `useTurnModel` derives ~30 values from a turn's full part list. A turn with
 * 324 segments has hundreds of parts, so running it per ROW would cost more
 * than windowing saves — and it would re-run every time the reader scrolls a
 * new row into the window.
 *
 * It does not have to. Only the head, the tail and the single-row forms read
 * the wide model, and there is at most ONE of each per mounted turn — and
 * mounted turns are few, because a turn spans an entire agent session.
 * Segments read exactly three values (`working`, `hasSteps`,
 * `answeredQuestionPartsById`), which the transcript computes once per turn
 * with `computeTurnRowInputs` and passes down. So the ~30 mounted segment rows
 * between a head and a tail render with no hooks at all.
 */

interface TranscriptRowViewProps {
  row: TranscriptRow;
  /** The `SessionTurnProps` for this row's turn. Stable per turn. */
  turnProps: SessionTurnProps;
  /** The three per-turn values a segment reads. Stable per turn. */
  segmentContext: TurnSegmentContext;
}

function TurnHeadRow({ turnProps }: { turnProps: SessionTurnProps }) {
  const model = useTurnModel(turnProps);
  return <TurnHead model={model} props={turnProps} />;
}

function TurnTailRow({ turnProps }: { turnProps: SessionTurnProps }) {
  const model = useTurnModel(turnProps);
  return <TurnTail model={model} props={turnProps} />;
}

function TurnSingleRow({ turnProps }: { turnProps: SessionTurnProps }) {
  const model = useTurnModel(turnProps);
  return <TurnSingle model={model} props={turnProps} />;
}

function TranscriptRowViewImpl({ row, turnProps, segmentContext }: TranscriptRowViewProps) {
  switch (row.kind) {
    case 'turn-single':
      return <TurnSingleRow turnProps={turnProps} />;
    case 'turn-head':
      return <TurnHeadRow turnProps={turnProps} />;
    case 'segment':
      return (
        <TurnSegment
          context={segmentContext}
          props={turnProps}
          segment={row.segment}
          segIndex={row.segIndex}
          isTrailing={row.isTrailing}
        />
      );
    case 'turn-tail':
      return <TurnTailRow turnProps={turnProps} />;
  }
}

/**
 * Identity-compared. A streamed token replaces the last turn's `segments`
 * array, which changes `row` for the rows of THAT turn only — every other
 * mounted row compares equal and is skipped.
 */
export const TranscriptRowView = memo(TranscriptRowViewImpl);
TranscriptRowView.displayName = 'TranscriptRowView';
