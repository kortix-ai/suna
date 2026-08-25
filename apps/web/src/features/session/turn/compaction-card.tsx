'use client';

/**
 * Compaction, as ONE minimal marker — the divider pill IS the whole UI:
 *
 *   1. running (optimistic or streaming) → rule ── [⛁ Compacting…] ── rule
 *      (shimmer label; the summary text is deliberately NOT streamed into the
 *      transcript — a wall of live markdown read as noise, grew the transcript
 *      under the reader, and made a slow summarize FEEL slower)
 *   2. landed → rule ── [⛁ Compaction ▾] ── rule — the pill becomes a button;
 *      the summary stays COLLAPSED until asked for, and expands instantly
 *      (no height animation: an animating block at the end of the transcript
 *      re-triggers the auto-scroll settle loop every frame)
 *   3. failed → one slim Checkpoint row (`CompactionFailedRow`)
 *
 * This replaced an earlier full card (header strip + streaming markdown body)
 * that duplicated the divider above it and re-laid-out on every token.
 */

import { CaretDownIcon, StackIcon as Layers } from '@phosphor-icons/react';
import { memo, useState } from 'react';

import { Checkpoint, CheckpointIcon, CheckpointLabel } from '@/components/ai-elements/checkpoint';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';

import { SandboxUrlDetector } from '../sandbox-url-detector';

// Byte-for-byte the styling of the old standalone CompactionDivider (after
// Jay's hand-tune: solid bg-muted, plain border, duotone glyph, no bold, rules
// touching the pill) — the marker replaced it and must not read differently.
const PILL_CLASS = 'bg-muted flex items-center gap-2 rounded-md border px-3 py-1.5';
const PILL_LABEL_CLASS = 'text-muted-foreground text-xs tracking-wide';

function CompactionMarkerImpl({
  running,
  summary,
}: {
  /** The summarize is still producing (optimistic, or the summary message is open). */
  running: boolean;
  /** The landed summary markdown, if any. */
  summary?: string;
}) {
  const [open, setOpen] = useState(false);
  const hasSummary = !running && Boolean(summary?.trim());
  return (
    <div>
      <div className="my-3 flex items-center py-4">
        <div className="bg-border h-px flex-1" />
        {running ? (
          <div className={PILL_CLASS}>
            <Layers weight="duotone" className="text-muted-foreground size-3.5 shrink-0" />
            <TextShimmer className="text-xs tracking-wide">Compacting…</TextShimmer>
          </div>
        ) : hasSummary ? (
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? 'Hide compaction summary' : 'Show compaction summary'}
            onClick={() => setOpen((v) => !v)}
            className={cn(
              PILL_CLASS,
              'hit-area-1 hover:bg-accent cursor-pointer transition-[background-color,scale] active:scale-[0.96]',
            )}
          >
            <Layers weight="duotone" className="text-muted-foreground size-3.5 shrink-0" />
            <span className={PILL_LABEL_CLASS}>Compaction</span>
            <CaretDownIcon
              className={cn(
                'text-muted-foreground/70 size-3 shrink-0 transition-transform',
                open && 'rotate-180',
              )}
            />
          </button>
        ) : (
          <div className={PILL_CLASS}>
            <Layers weight="duotone" className="text-muted-foreground size-3.5 shrink-0" />
            <span className={PILL_LABEL_CLASS}>Compaction</span>
          </div>
        )}
        <div className="bg-border h-px flex-1" />
      </div>
      {open && hasSummary && (
        <div className="text-muted-foreground/90 [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_strong]:text-foreground/90 pb-2 text-sm">
          <SandboxUrlDetector content={summary!} isStreaming={false} />
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
  const label = isAbort ? 'Compaction stopped' : error ? 'Compaction failed' : 'Compaction incomplete';
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
