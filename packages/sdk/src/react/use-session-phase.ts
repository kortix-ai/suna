import type { SessionPhase } from './use-session';

/**
 * WHY THIS IS NOT `runtimeError ? 'error' : …`.
 *
 * Opening a parked session is a race by construction: `/start` resumes the box
 * while the runtime queries fire against a row that still says `stopped`. The
 * proxy answers those with `503 sandbox not ready`, correctly — a GET on a
 * session-data port is deliberately not wake-capable. Mapping that 503 straight
 * to a phase of 'error' is what renders "OpenCode failed to load" over a
 * perfectly healthy wake.
 *
 * So a runtime error only becomes terminal once `/start` has SETTLED. While it
 * is still in flight the session is `starting`, which is the truth.
 */
export function derivePhase(input: {
  terminal: boolean;
  startError: unknown;
  runtimeError: unknown;
  /** True once the /start poll has stopped — resolved, failed, or given up. */
  startSettled: boolean;
  switched: boolean;
}): SessionPhase {
  if (input.terminal || input.startError) return 'error';
  if (input.runtimeError && input.startSettled) return 'error';
  if (input.runtimeError) return 'starting';
  return input.switched ? 'ready' : 'starting';
}
