'use client';

import { useLocale, useTranslations } from '../../i18n';
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

import { Checkpoint, CheckpointIcon, CheckpointLabel } from './checkpoint';
import { TextShimmer } from '../../primitives/text-shimmer';
import { cn } from '../../lib/utils';

import Loading from '../../primitives/loading';
import { SandboxUrlDetector } from '../media/sandbox-url-detector';

const PILL_CLASS = 'bg-muted/80 flex shrink-0 items-center gap-2 rounded-md  px-3 py-1.5';
const PILL_LABEL_CLASS = 'text-muted-foreground text-xs tracking-wide';

/** Transcript copy — sentence case, one idea per line (kortix-brand voice-and-tone.md). */
const COMPACTION_LABEL_DONE = 'Context automatically compacted';

/**
 * A reset onto the session's searchable record (kortixd `extensions/context-record.ts`): the block's
 * `mode: 'record'`. Nothing was summarized, so the pill explains the reset instead of opening the
 * model's text.
 */
export interface CompactionReset {
  /** The person started it (`/compact`, the Compact dialog). */
  manual: boolean;
  /** The context size when it reset. */
  tokensBefore?: number;
  /** The entries the record held at the reset. */
  entries?: number;
}

/** The reset block's fields as the marker takes them; null for a summary compaction. */
export function compactionReset(
  block: { mode?: 'record'; trigger?: string; tokens_before?: number; entries?: number } | null | undefined,
): CompactionReset | null {
  if (block?.mode !== 'record') return null;
  return { manual: block.trigger === 'manual', tokensBefore: block.tokens_before, entries: block.entries };
}

/**
 * The summary prose — ONE component whether it renders in the panel detail
 * (the normal path) or inline under the pill (the no-panel fallback), so the
 * two can never drift in typography.
 */
export function CompactionSummaryBody({ summary }: { summary: string }) {
  return (
    <div className="text-muted-foreground [&_h1]:text-foreground [&_h2]:text-foreground [&_h3]:text-foreground [&_strong]:text-foreground p-6 text-sm">
      <SandboxUrlDetector content={summary} isStreaming={false} />
    </div>
  );
}

function CompactionMarkerImpl({
  running,
  summary,
  onOpenSummary,
  reset,
}: {
  /** A reset onto the record: the pill explains it inline, and `summary` is not shown. */
  reset?: CompactionReset | null;
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tReset = useTranslations('contextReset');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  if (reset && !running) {
    const tokens = new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 0 }).format(reset.tokensBefore ?? 0);
    const detail = tReset(reset.manual ? 'detailManual' : 'detail', { tokens, entries: reset.entries ?? 0 });
    return (
      <div>
        <div className="my-3 flex items-center gap-2 py-4">
          <div className="bg-border h-px flex-1" />
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? tReset('hideDetail') : tReset('showDetail')}
            onClick={() => setOpen((v) => !v)}
            className={cn(PILL_CLASS, 'hit-area-1 hover:bg-accent cursor-pointer transition-[background-color,scale] active:scale-[0.96]')}
          >
            <Layers weight="duotone" className="text-muted-foreground size-3.5 shrink-0" />
            <span className={PILL_LABEL_CLASS}>{tReset('pill')}</span>
            <CaretDownIcon className={cn('text-muted-foreground size-3 shrink-0 transition-transform', open && 'rotate-180')} />
          </button>
          <div className="bg-border h-px flex-1" />
        </div>
        {open && <p className="text-muted-foreground mx-auto max-w-prose px-6 pb-2 text-center text-sm">{detail}</p>}
      </div>
    );
  }
  const hasSummary = !running && Boolean(summary?.trim());
  const opensDetail = hasSummary && Boolean(onOpenSummary);
  return (
    <div>
      <div className="my-3 flex items-center gap-2 py-4">
        <div className="bg-border h-px flex-1" />
        {running ? (
          <div className={PILL_CLASS}>
            <Loading variant="spokes" className="text-muted-foreground size-3.5 shrink-0" />
            <TextShimmer className="text-xs tracking-wide">{tReset('pillRunning')}</TextShimmer>
          </div>
        ) : hasSummary ? (
          <button
            type="button"
            aria-expanded={opensDetail ? undefined : open}
            aria-label={
              opensDetail
                ? tI18nComplete.raw('textab742f4db494')
                : open
                  ? tI18nComplete.raw('text92bfa8a05e5a')
                  : tI18nComplete.raw('text84459dc0a0ee')
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
              <CaretRightIcon className="text-muted-foreground size-3 shrink-0" />
            ) : (
              <CaretDownIcon
                className={cn(
                  'text-muted-foreground size-3 shrink-0 transition-transform',
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
          <span className="text-muted-foreground font-normal"> · {error}</span>
        ) : null}
      </CheckpointLabel>
    </Checkpoint>
  );
}

export const CompactionFailedRow = memo(CompactionFailedRowImpl);
CompactionFailedRow.displayName = 'CompactionFailedRow';
