/**
 * A burst's parts → how much work it holds, and the one line that says so.
 *
 * The collapsed row is the door to a list of N steps, so it names N. It used to
 * name a reasoning heading instead (`burstTitle`), which told the reader nothing
 * about size and put model-authored prose in a slot we do not control.
 *
 * `total` MUST equal the number of units the expanded chain renders, so the
 * counting rules here mirror `mergeBurstSteps` exactly: plumbing never counts
 * and never breaks a run around it, and a run of consecutive reasoning fragments
 * is ONE unit because it renders as one Thinking row.
 *
 * Two places deliberately part company with the rendered row count, and both
 * are the same trade: the reader's unit of "step" is CALLS MADE, because
 * `failed` counts individual tool parts and any other unit would make
 * `Completed 10 of 11 steps` arithmetic nonsense.
 *
 *   1. A group row holding 5 reads counts 5, not 1.
 *   2. A file-chip row dedupes by path (`activity-file-chips.tsx`), so three
 *      reads of one file open to ONE chip while `total` still says 3. Counting
 *      the chips instead would under-report a run that really did read the file
 *      three times, and would make `failed` — which cannot dedupe, since two
 *      failures on one path are two failures — the odd unit out.
 *
 * Both are pinned by tests: see `burst-summary.test.ts` ("three reads of one
 * path") and `activity-file-chips.test.tsx`.
 *
 * No React import. `partOutcome` is taken from `tool/shared/tool-outcome`, not
 * from the `infrastructure` barrel that re-exports it, so this module stays
 * testable without loading 1500 lines of JSX.
 */
import { partOutcome } from '@/features/session/tool/shared/tool-outcome';
import { isReasoningPart, isToolPart, type Part } from '@/ui';
import { stepLabel } from './step-label';

export interface BurstSummary {
  /** Every row-worthy unit in this burst. */
  total: number;
  /** Tool calls whose outcome is not `ok`. */
  failed: number;
  /** `total - failed`. */
  completed: number;
  /**
   * Whether any part was plumbing. The label needs it to tell the two empty
   * bursts apart — machinery that ran and was hidden ("Housekeeping") versus
   * nothing at all ("Worked") — and it cannot see `parts` to work that out.
   */
  hasPlumbing: boolean;
}

export function burstSummary(parts: ReadonlyArray<Part>): BurstSummary {
  let total = 0;
  let failed = 0;
  let hasPlumbing = false;
  // Open while the previous counted part was reasoning, so consecutive
  // fragments extend one run instead of opening a second.
  let inThought = false;

  for (const part of parts) {
    if (stepLabel(part).tier === 'plumbing') {
      hasPlumbing = true;
      // No `inThought = false` here, on purpose: a memory write between two
      // thoughts renders no row, so it must not split them into two.
      continue;
    }

    if (isReasoningPart(part)) {
      // An empty fragment renders nothing, so it neither counts nor closes the
      // run it sits inside — same read-before-flush order as `mergeBurstSteps`.
      const text = (part as { text?: string }).text?.trim();
      if (!text) continue;
      if (!inThought) {
        inThought = true;
        total += 1;
      }
      continue;
    }

    inThought = false;
    total += 1;

    // Identical predicate to the old `burstFailureCount`: tool parts only —
    // a thought has no verdict to report — and plumbing is already skipped
    // above, which is load-bearing. A failed compaction call renders no row,
    // so counting it would close the chain on a failure the reader cannot find.
    if (isToolPart(part) && partOutcome(part) !== 'ok') failed += 1;
  }

  return { total, failed, completed: total - failed, hasPlumbing };
}

function steps(count: number): string {
  return `${count} ${count === 1 ? 'step' : 'steps'}`;
}

export function burstSummaryLabel(summary: BurstSummary, running: boolean): string {
  const { total, failed, completed, hasPlumbing } = summary;

  // A running burst reports no failures. Its calls are still landing, so any
  // count would be a snapshot the next frame contradicts. One rule, one place —
  // callers pass the summary through unchanged.
  if (running) return total === 0 ? 'Working' : `Working · ${steps(total)}`;

  if (total === 0) return hasPlumbing ? 'Housekeeping' : 'Worked';
  if (failed === 0) return `Completed ${steps(total)}`;
  // Nothing completed, so nothing claims to have. "Completed 0 of 2" is a
  // sentence that leads with a success that did not happen.
  if (completed === 0) return `${steps(total)} failed`;
  // `10 of 11` alone makes the reader subtract. The clause costs eight
  // characters, states the fact, and carries no adjective — not "error",
  // not "problem".
  return `Completed ${completed} of ${total} steps · ${failed} failed`;
}
