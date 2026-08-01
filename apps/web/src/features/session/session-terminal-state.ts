/** Raw `/start` stage, or `null` while the first `/start` is still in flight. */
export type SessionStartStageValue =
  | 'provisioning'
  | 'starting'
  | 'ready'
  | 'stopped'
  | 'failed'
  | null;

export interface SessionTerminalState {
  /** Raw `/start` stage — the ONLY server-declared terminal signal. */
  stage: SessionStartStageValue;
  /** `/start` `retriable`: true while polling can still make progress. */
  retriable: boolean;
  hasStartError: boolean;
  sandboxStatus?: string | null;
}

/**
 * Detect a terminal `/start` FAILURE that has no serialized sandbox row.
 *
 * Read `stage`, never `phase`. `useSession` collapses three unrelated
 * conditions into `phase === 'error'`: a terminal stage, a typed `/start`
 * error, AND a transient OpenCode REST error. Deriving "provisioning failed
 * before allocation" from `phase` therefore fired on states that are not a
 * provisioning failure at all — a session the server reports as `stopped`, and
 * a session still booting (`stage: 'starting'`, `sandbox: null`, `retriable:
 * true`) whose runtime list happened to error. Both painted a terminal
 * "Couldn't start session" card over a session that had not failed.
 *
 * `retriable` is the server's own "polling can still make progress" flag, so an
 * unfinished boot can never be reported as a dead end even if a future stage
 * value lands here.
 */
export function isUnmaterializedSessionFailure(state: SessionTerminalState): boolean {
  if (state.hasStartError || state.retriable) return false;
  if (state.stage !== 'failed') return false;
  return state.sandboxStatus == null;
}

/**
 * Detect a session the server reports as `stopped` with no serialized sandbox
 * row (`openSession`'s terminal branch for a `stopped`/`completed` session row).
 *
 * It needs its own branch because the page's `fatal` path reads
 * `sandbox.status`, which is unavailable here — so this state used to fall
 * through to the unmaterialized-FAILURE card and tell the user a session that
 * merely stopped had "failed before its computer was created".
 */
export function isDormantSessionWithoutRuntime(state: SessionTerminalState): boolean {
  if (state.hasStartError || state.retriable) return false;
  if (state.stage !== 'stopped') return false;
  return state.sandboxStatus == null;
}
