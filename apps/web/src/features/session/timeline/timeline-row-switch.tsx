/**
 * Where each SDK row kind lands in the host render — the ONE exhaustive switch
 * over `TimelineRow['kind']`, with a `never` guard, so a ninth row kind added
 * upstream is a compile error here as well as in the SDK.
 *
 * Stage 2 renders in IDENTICAL-OUTPUT mode: the turn DOM is byte-for-byte the
 * legacy card's (see `session-timeline-list.golden.test.tsx`). Several kinds
 * therefore render NO element yet; each carries its reason and its Stage 3
 * destination.
 */
import type { TimelineRow } from '@kortix/sdk';

export type TimelineRowSlot =
  /** `user-message` → `UserMessageRow` (the bubble, the report card or the
   *  system pill). */
  | 'bubble'
  /** `assistant-part` → one or two `AssistantPartRow` placements, positioned
   *  by `projectTurnPlacements` (steps section / body). */
  | 'part'
  /** Computed by the SDK, rendered by nothing in Stage 2. */
  | 'none';

export function timelineRowSlot(row: TimelineRow): TimelineRowSlot {
  switch (row.kind) {
    case 'user-message':
      return 'bubble';
    case 'assistant-part':
      return 'part';
    case 'turn-gap':
      // No element: the gap is the `TurnFrame` wrapper's margin (`mt-3` /
      // `mt-12`), which keeps `contain-intrinsic-size` math unchanged.
      return 'none';
    case 'turn-divider':
      // `compaction`: the host predicate (`info.summary === true` on an
      // assistant message, or a `compaction` part) decides the divider at the
      // `TurnFrame` head; the SDK predicate reads the USER message's parts and
      // is unverified against a real compaction transcript. `interrupted`: the
      // SDK places it BEFORE the aborted message's parts; today "Interrupted"
      // sits at the END of the turn (`TurnErrorDisplay isAbort` in
      // `TurnTailRow`). Stage 3 moves both.
      return 'none';
    case 'thinking':
      // Pre-first-part placeholder only; today the busy footer persists UNDER
      // streamed parts (`SessionBusyIndicator` in `TurnTailRow`). Stage 3.
      return 'none';
    case 'retry':
      // Rendered by `TurnTailRow` from `getRetryInfo(sessionStatus)`, gated on
      // the working turn, as today. Stage 3.
      return 'none';
    case 'diff-summary':
      // No web component reads `summary.diffs`; rendering one would change the
      // visible output. Stage 3 adds `DiffSummaryRow` on the
      // `activity-file-chips.tsx` primitives.
      return 'none';
    case 'error':
      // `TurnTailRow` renders `TurnErrorDisplay` with `errorDetails` and the
      // dismissed-question fallback, neither of which is on the row. Stage 3.
      return 'none';
    default: {
      const _never: never = row;
      return _never;
    }
  }
}
