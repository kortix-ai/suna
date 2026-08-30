/**
 * What one craft run's status IS — a pure derivation, in its own leaf module so
 * it is testable without the db graph.
 *
 * There is no stored "this run succeeded" anywhere, and the two obvious
 * candidates both lie:
 *
 *   - `project_trigger_executions.status` is the DISPATCH outcome — "did we
 *     manage to start a session" — not "did the work succeed". An execution
 *     reads `succeeded` the moment a session exists.
 *   - `project_sessions.status = 'completed'` is written by exactly one
 *     migration backfill (`suna-migration-phases.ts`), so a finished session
 *     never reaches it. Reading it as "done" would report every real run as
 *     unfinished.
 *
 * So the outcome comes from `session_turns.end_reason`, the only place "the
 * runtime went away mid-turn" is ever written down.
 */

/**
 * The five statuses `project_trigger_executions` actually holds. There is no
 * `'failed'`: a failed attempt goes back to `queued` with `last_error` set and
 * `attempts` incremented, and only becomes `dead_lettered` after 5 tries (see
 * `markTriggerExecutionFailed`).
 */
export type TriggerExecutionStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'skipped'
  | 'dead_lettered';

/** `session_turns.end_reason` — the CHECK constraint's five values. */
export type SessionTurnEndReason =
  | 'completed'
  | 'runtime_gone'
  | 'failed'
  | 'abandoned'
  | 'unknown';

/**
 * What a craft run shows.
 *
 * Overlaps the session sidebar's vocabulary (`starting`/`running`/`done`/
 * `failed`/`stopped`) on purpose — someone who learned "filled green = live,
 * muted check = done" there reads a run strip with no new vocabulary. Two are
 * run-specific:
 *
 *   - `retrying` — the fire failed and will be attempted again. Collapsing it
 *     into `starting` would show a craft that is failing every attempt as
 *     perpetually "starting", which is the opposite of actionable.
 *   - `skipped` — the trigger fired but a filter or the pause switch declined
 *     it. Nothing ran, and nothing is wrong.
 */
export type CraftRunStatus =
  | 'starting'
  | 'retrying'
  | 'running'
  | 'done'
  | 'failed'
  | 'stopped'
  | 'skipped';

/** The active sandbox lifecycle statuses — mirrors `ACTIVE_SESSION_STATUSES`. */
const ACTIVE_SESSION = new Set(['queued', 'branching', 'provisioning', 'running']);

export interface CraftRunStatusInput {
  executionStatus: string;
  /** How many dispatch attempts this slot has taken. */
  attempts: number;
  /** The last dispatch error, when one was recorded. */
  lastError: string | null;
  /** The session the fire produced, or null (never created, or since deleted). */
  sessionStatus: string | null;
  /** `end_reason` of the newest ENDED turn in that session, if any. */
  lastTurnEndReason: string | null;
}

/**
 * Derive the run status. Total over its inputs: an execution status this build
 * has never seen resolves to `starting` rather than throwing, because the
 * alternative is one unknown enum value unmounting a whole run report.
 */
export function craftRunStatus(input: CraftRunStatusInput): CraftRunStatus {
  switch (input.executionStatus) {
    case 'skipped':
      return 'skipped';
    case 'dead_lettered':
      // Out of attempts. This is the only execution status that is itself a
      // verdict of failure.
      return 'failed';
    case 'queued':
      // A slot that has already burned an attempt and recorded an error is
      // retrying, not starting.
      return input.attempts > 0 || input.lastError ? 'retrying' : 'starting';
    case 'running':
      // Being dispatched right now. The session may not exist yet.
      return 'starting';
    case 'succeeded':
      break;
    default:
      return 'starting';
  }

  // `succeeded` means a session was created. Its outcome is the session's.
  if (!input.sessionStatus) {
    // The FK is ON DELETE SET NULL, so a deleted session leaves the run row
    // behind with no session. It ran; we can no longer say how it ended.
    return 'stopped';
  }
  if (ACTIVE_SESSION.has(input.sessionStatus)) return 'running';

  switch (input.lastTurnEndReason) {
    case 'completed':
      return 'done';
    case 'failed':
    case 'runtime_gone':
      return 'failed';
    case 'abandoned':
    case 'unknown':
      return 'stopped';
    default:
      // A terminal session with no ended turn: it stopped before finishing a
      // turn. `stopped` is the honest answer — `failed` would invent a failure
      // and `done` would invent a result.
      return 'stopped';
  }
}

/** True when the run reached a state that will not change again. */
export function craftRunIsSettled(status: CraftRunStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'stopped' || status === 'skipped';
}

export interface CraftRunStatsInput {
  status: CraftRunStatus;
  durationMs: number | null;
}

export interface CraftRunStats {
  total: number;
  done: number;
  failed: number;
  /**
   * `done / (done + failed)` as a 0-100 integer, or null with no settled run.
   * `stopped` and `skipped` are excluded from BOTH sides: neither is a verdict
   * on the craft, and counting them as failures would defame a craft whose
   * sandbox was reaped.
   */
  successRate: number | null;
  /** Mean duration over runs that have one, in whole seconds. */
  avgDurationSeconds: number | null;
}

export function craftRunStats(runs: readonly CraftRunStatsInput[]): CraftRunStats {
  let done = 0;
  let failed = 0;
  let durationSum = 0;
  let durationCount = 0;
  for (const run of runs) {
    if (run.status === 'done') done += 1;
    else if (run.status === 'failed') failed += 1;
    if (run.durationMs !== null && run.durationMs >= 0) {
      durationSum += run.durationMs;
      durationCount += 1;
    }
  }
  const verdicts = done + failed;
  return {
    total: runs.length,
    done,
    failed,
    successRate: verdicts === 0 ? null : Math.round((done / verdicts) * 100),
    avgDurationSeconds: durationCount === 0 ? null : Math.round(durationSum / durationCount / 1000),
  };
}
