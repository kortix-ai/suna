/**
 * What (if anything) should the header announce when a run settles while the
 * panel is closed? Pure so the transition rules are testable without React.
 */

import type { ReadyChipState } from '@/stores/kortix-computer-store';
import type { RunOutcome } from './run-outcome';

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
