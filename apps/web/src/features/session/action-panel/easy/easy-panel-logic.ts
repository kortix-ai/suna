/**
 * Pure logic for `EasyPanel`, split out from the client component purely so
 * it is unit-testable without a DOM (same reasoning as `progress-summary.ts`).
 */

import type { OutputItem } from '../shared/derive-panels';

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
