/**
 * Daytona sandbox state → our `SandboxStatus`, as an EXPLICIT map.
 *
 * This used to be substring matching inside `DaytonaProvider.getStatus`:
 * 'start'|'running'|'active' → running, 'stop'|'archive' → stopped, everything
 * else → 'unknown'. `error` matched none of those, so a permanently DEAD box was
 * reported as transient uncertainty; `decideReconcile('unknown')` returns 'none'
 * by design ("never act on uncertainty"); and so the sandbox row stayed `active`
 * forever while `settleComputeWindow` charged wall-clock against a box that no
 * longer existed. Live proof (2026-07-29): 12 of the longest-billed open compute
 * rows were ALL in Daytona state `error`, some with Daytona's own `updatedAt`
 * 40 days stale, the worst still billing after 829 hours ($111.91). Nothing kept
 * those boxes alive — they were dead, and only our accounting kept running.
 *
 * Substring matching is fragile by construction: a state Daytona adds later
 * silently becomes billable. So the map is explicit and an UNRECOGNISED state is
 * logged loudly rather than quietly folded into 'unknown'.
 *
 * Its own module so it stays a pure decision with no config/SDK imports, and can
 * be unit-tested without booting the provider layer.
 */

import type { SandboxStatus } from './status';

const DAYTONA_STATE_MAP: Record<string, SandboxStatus> = {
  started: 'running',
  starting: 'running',
  restoring: 'running',
  pending_start: 'running',
  running: 'running',
  active: 'running',
  stopped: 'stopped',
  stopping: 'stopped',
  pending_stop: 'stopped',
  archived: 'stopped',
  archiving: 'stopped',
  destroyed: 'removed',
  destroying: 'removed',
  // TERMINAL: the box is dead and will never run again. NOT 'unknown'.
  error: 'terminal',
  build_failed: 'terminal',
  // Genuinely transitional — we cannot tell yet, and must not act.
  creating: 'unknown',
  pending_build: 'unknown',
  building_snapshot: 'unknown',
  unknown: 'unknown',
};

const unrecognisedDaytonaStates = new Set<string>();

export function classifyDaytonaState(rawState: unknown): SandboxStatus {
  const state = String(rawState ?? '').trim().toLowerCase();
  const mapped = DAYTONA_STATE_MAP[state];
  if (mapped) return mapped;
  if (!unrecognisedDaytonaStates.has(state)) {
    unrecognisedDaytonaStates.add(state);
    console.warn(
      `[daytona] UNRECOGNISED sandbox state '${state}' — treating as unknown. Map it in DAYTONA_STATE_MAP: an unmapped terminal state bills forever.`,
    );
  }
  return 'unknown';
}
