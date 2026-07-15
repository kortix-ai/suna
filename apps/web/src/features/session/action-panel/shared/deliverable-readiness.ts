/**
 * What (if anything) should the header announce when a run settles while the
 * panel is closed? Pure so the transition rules are testable without React.
 */

import type { ReadyChipState } from '@/stores/kortix-computer-store';
import type { RunOutcome } from './run-outcome';

/**
 * Should a run-completion announcement stand down because the agent is blocked
 * on the user? The plan's invariant: a needs-input chip outranks a ready chip —
 * being blocked outranks being done. Without this guard the running→idle
 * transition can fire while a question is still outstanding (the session goes
 * idle waiting for the answer) and silently replace the standing needs_input
 * chip with a ready chip.
 */
export function completionYieldsToPendingInput(pendingCount: number): boolean {
  return pendingCount > 0;
}

export function chipForCompletion(
  outcome: RunOutcome,
  count: number,
  primaryName: string | undefined,
  sessionId: string,
): ReadyChipState | null {
  if (outcome === 'succeeded') {
    if (count === 0) return null;
    return { sessionId, outcome: 'ready', count, primaryName };
  }
  return {
    sessionId,
    outcome: outcome === 'stopped' ? 'stopped' : 'failed',
    count,
    primaryName,
  };
}
