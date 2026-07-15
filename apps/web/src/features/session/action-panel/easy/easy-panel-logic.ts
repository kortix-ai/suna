/**
 * Pure logic for `EasyPanel`, split out from the client component purely so
 * it is unit-testable without a DOM (same reasoning as `progress-summary.ts`).
 */

import type { OutputItem } from '../shared/derive-panels';
import type { Step } from '../shared/group-steps';
import type { RunOutcome } from '../shared/run-outcome';

/**
 * The step that owns a given tool call — what the chat→panel focus effect
 * needs to turn "user clicked this call in the chat" into "open this step's
 * detail". Pulled out of the effect body so it's testable without mounting
 * `EasyPanel` (see `mode-gate.test.tsx`).
 */
export function stepForCallId(steps: Step[], callId: string): Step | undefined {
  return steps.find((s) => s.parts.some((p) => p.callID === callId));
}

/**
 * React key for one Outputs row.
 *
 * `OutputItem.callID` is NOT unique on its own: a single `apply_patch` call
 * produces one `OutputItem` per file it actually changed, and every one of
 * those items shares that call's `callID` (see `applyPatchOutputs` in
 * `derive-panels.ts`). Keying a list on `callID` alone collides and either
 * drops rows or scrambles React's reconciliation across re-renders. The path
 * (falling back to the display name when a call has none) is what actually
 * distinguishes those rows, so the key combines both: the callID keeps
 * unrelated calls that happen to touch the same path apart, and the
 * path/name keeps multiple files from one call apart.
 */
export function outputKey(output: Pick<OutputItem, 'callID' | 'path' | 'name'>): string {
  return `${output.callID}:${output.path ?? output.name}`;
}

/** The row before and after the currently open output, in the list's own
 * order — what makes "next" mean the same thing the card's rows mean (W10). */
export function neighborOutputs(
  items: OutputItem[],
  currentKey: string,
): { prev: OutputItem | null; next: OutputItem | null; position: string } {
  const index = items.findIndex((item) => outputKey(item) === currentKey);
  if (index < 0) return { prev: null, next: null, position: '' };
  return {
    prev: index > 0 ? items[index - 1] : null,
    next: index < items.length - 1 ? items[index + 1] : null,
    position: `${index + 1} of ${items.length}`,
  };
}

/**
 * Whether the Outputs card should flip open on this render — the "payoff"
 * moment: a run just finished (`wasRunning` true, `isRunning` now false) and
 * left something behind. Must be false on every other render, including:
 *   - every render while still running (no transition yet)
 *   - every render once idle and already settled (no transition this tick)
 *   - a run finishing with nothing to show (nothing to pay off)
 * so the card only auto-opens exactly once, at the transition, never on
 * every subsequent re-render of an already-finished run.
 */
export function shouldAutoExpandOutputs(
  wasRunning: boolean,
  isRunning: boolean,
  outputCount: number,
): boolean {
  return wasRunning && !isRunning && outputCount > 0;
}

/**
 * Whether the run should read as "still going", combining two signals:
 *
 * - `stepsRunning` — derived from the tool parts themselves
 *   (`steps.some(s => s.status === 'running')`). This alone flickers: between
 *   one tool call completing and the next being emitted, the model streams
 *   assistant text and no part is running/pending, so this goes false for a
 *   beat on every tool boundary of an otherwise-uninterrupted run.
 * - `sessionBusy` — the session's own status (the same signal the chat
 *   transcript already uses to show its working indicator), which stays busy
 *   for the whole turn regardless of gaps between tool calls.
 *
 * ORing them closes the gap: the run reads as running for its entire actual
 * duration, so `shouldAutoExpandOutputs` only fires at the real finish (not
 * at the first inter-tool pause), and the Progress card's shimmer/subtitle
 * stop flickering at every tool boundary.
 */
export function deriveIsRunning(stepsRunning: boolean, sessionBusy: boolean): boolean {
  return stepsRunning || sessionBusy;
}

/**
 * Whether the panel should present the primary deliverable on this render —
 * the payoff screen (W2). Same transition discipline as
 * `shouldAutoExpandOutputs`, with three extra refusals: a failed or stopped
 * run presents its outcome, not a payoff; an open detail is never replaced;
 * and a user who opened any detail during the run has shown they're driving —
 * auto-opening would fight them.
 */
export function shouldAutoOpenPayoff(args: {
  wasRunning: boolean;
  isRunning: boolean;
  outcome: RunOutcome;
  hasPrimary: boolean;
  detailOpen: boolean;
  interactedThisRun: boolean;
}): boolean {
  return (
    args.wasRunning &&
    !args.isRunning &&
    args.outcome === 'succeeded' &&
    args.hasPrimary &&
    !args.detailOpen &&
    !args.interactedThisRun
  );
}
