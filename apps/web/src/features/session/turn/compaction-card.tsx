'use client';

/**
 * Compaction, as ONE minimal marker — the divider pill IS the whole UI:
 *
 *   1. running (optimistic or streaming) → rule ── [⛁ Compacting context…] ── rule
 *      (shimmer label; the summary text is deliberately NOT streamed into the
 *      transcript — a wall of live markdown read as noise, grew the transcript
 *      under the reader, and made a slow summarize FEEL slower)
 *   2. landed → rule ── [⛁ Context automatically compacted ▾] ── rule — the pill
 *      becomes a button;
 *      the summary stays COLLAPSED until asked for, and expands instantly
 *      (no height animation: an animating block at the end of the transcript
 *      re-triggers the auto-scroll settle loop every frame)
 *   3. failed → one slim Checkpoint row (`CompactionFailedRow`)
 *
 * This replaced an earlier full card (header strip + streaming markdown body)
 * that duplicated the divider above it and re-laid-out on every token.
 */

import { CaretDownIcon, CaretRightIcon, StackIcon as Layers } from '@phosphor-icons/react';
import { memo, useState } from 'react';

import { Checkpoint, CheckpointIcon, CheckpointLabel } from '@/components/ai-elements/checkpoint';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';

import Loading from '@/components/ui/loading';
import { SandboxUrlDetector } from '../sandbox-url-detector';

const PILL_CLASS = 'bg-muted/80 flex shrink-0 items-center gap-2 rounded-md  px-3 py-1.5';
const PILL_LABEL_CLASS = 'text-muted-foreground text-xs tracking-wide';

/** Transcript copy — sentence case, one idea per line (comms). */
const COMPACTION_LABEL_LOADING = 'Compacting context…';
const COMPACTION_LABEL_DONE = 'Context automatically compacted';

/**
 * The summary prose — ONE component whether it renders in the panel detail
 * (the normal path) or inline under the pill (the no-panel fallback), so the
 * two can never drift in typography.
 */
export function CompactionSummaryBody({ summary }: { summary: string }) {
  return (
    <div className="text-muted-foreground/90 [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_strong]:text-foreground/90 p-6 text-sm">
      <SandboxUrlDetector content={summary} isStreaming={false} />
    </div>
  );
}

function CompactionMarkerImpl({
  running,
  summary,
  onOpenSummary,
}: {
  /** The summarize is still producing (optimistic, or the summary message is open). */
  running: boolean;
  /** The landed summary markdown, if any. */
  summary?: string;
  /**
   * Open the summary in the session panel's DETAIL view — the same surface a
   * file opens into. When provided, the pill navigates there instead of
   * expanding inline; absent (a host with no SessionPanelProvider, e.g. the
   * read-only sub-session modal), the pill falls back to the inline
   * disclosure so the summary is never unreachable.
   */
  onOpenSummary?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const hasSummary = !running && Boolean(summary?.trim());
  const opensDetail = hasSummary && Boolean(onOpenSummary);
  return (
    <div>
      <div className="my-3 flex items-center gap-2 py-4">
        <div className="bg-border h-px flex-1" />
        {running ? (
          <div className={PILL_CLASS}>
            <Loading variant="spokes" className="text-muted-foreground size-3.5 shrink-0" />
            <TextShimmer className="text-xs tracking-wide">{COMPACTION_LABEL_LOADING}</TextShimmer>
          </div>
        ) : hasSummary ? (
          <button
            type="button"
            aria-expanded={opensDetail ? undefined : open}
            aria-label={
              opensDetail
                ? 'Open compaction summary'
                : open
                  ? 'Hide compaction summary'
                  : 'Show compaction summary'
            }
            onClick={() => {
              if (onOpenSummary) {
                onOpenSummary();
                return;
              }
              setOpen((v) => !v);
            }}
            className={cn(
              PILL_CLASS,
              'hit-area-1 hover:bg-accent cursor-pointer transition-[background-color,scale] active:scale-[0.96]',
            )}
          >
            <Layers weight="duotone" className="text-muted-foreground size-3.5 shrink-0" />
            <span className={PILL_LABEL_CLASS}>{COMPACTION_LABEL_DONE}</span>
            {opensDetail ? (
              // A right caret, not a chevron-down: the summary opens ELSEWHERE
              // (the panel detail), the same grammar as a row that navigates.
              <CaretRightIcon className="text-muted-foreground/70 size-3 shrink-0" />
            ) : (
              <CaretDownIcon
                className={cn(
                  'text-muted-foreground/70 size-3 shrink-0 transition-transform',
                  open && 'rotate-180',
                )}
              />
            )}
          </button>
        ) : (
          <div className={PILL_CLASS}>
            <Layers weight="duotone" className="text-muted-foreground size-3.5 shrink-0" />
            <span className={PILL_LABEL_CLASS}>{COMPACTION_LABEL_DONE}</span>
          </div>
        )}
        <div className="bg-border h-px flex-1" />
      </div>
      {open && hasSummary && !opensDetail && (
        <div className="pb-2">
          <CompactionSummaryBody summary={summary!} />
        </div>
      )}
    </div>
  );
}

/** Primitive props, so per-token `summary` growth while running is a DOM no-op. */
export const CompactionMarker = memo(CompactionMarkerImpl);
CompactionMarker.displayName = 'CompactionMarker';

/**
 * A compaction attempt that produced NO summary — errored, or stopped before
 * the first token. One slim Checkpoint row (the "Interrupted" row's shape), so
 * a run of retries stacks as a tight list of one-liners instead of N full-turn
 * scaffolds with a screen of whitespace between them.
 *
 * The error rides IN the label (truncated, full text on hover via `title`) —
 * this row replaces the turn's whole render, including `TurnErrorDisplay`.
 */
function CompactionFailedRowImpl({
  error,
  isAbort,
}: {
  /** The turn's error text, if any. */
  error?: string | null;
  /** True when the attempt was stopped rather than failed. */
  isAbort?: boolean;
}) {
  const label = isAbort
    ? 'Compaction stopped'
    : error
      ? 'Compaction failed'
      : 'Compaction incomplete';
  return (
    <Checkpoint>
      <CheckpointIcon>
        <Layers className="text-muted-foreground size-4 shrink-0" />
      </CheckpointIcon>
      <CheckpointLabel title={!isAbort && error ? error : undefined}>
        {label}
        {!isAbort && error ? (
          <span className="text-muted-foreground/70 font-normal"> · {error}</span>
        ) : null}
      </CheckpointLabel>
    </Checkpoint>
  );
}

export const CompactionFailedRow = memo(CompactionFailedRowImpl);
CompactionFailedRow.displayName = 'CompactionFailedRow';
