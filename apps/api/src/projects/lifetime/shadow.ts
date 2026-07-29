/**
 * BOUNDED SANDBOX LIFETIME — SHADOW MODE.
 *
 * Deadlines are REAL from day one: every W1–W6 write, both DB triggers and the
 * backfill are live. Only the KILL is gated. This pass runs the exact query
 * enforcement will run and stops nothing.
 *
 * WHY THIS EXISTS AT ALL. The design bets that run boundaries are fully
 * control-plane-mediated. That bet is defensible from the code — the proxy
 * already regex-matches the prompt path, the ACP route already parses envelopes
 * — but it has never been MEASURED, and the cost of being wrong is a box killed
 * mid-turn. This is how the team finds out before betting on it.
 *
 * TWO DIRECTIONS, and the second is the one a naive implementation drops:
 *
 *   would_stop      the new model would kill a box the old model kept alive.
 *                   Emitted per candidate. Expected to be large on the first
 *                   pass (~150+) and to converge to a small stable number.
 *
 *   would_keep      the OLD model just stopped a box whose deadline is still in
 *                   the future. Because this design DELETES the busy probe, the
 *                   lease, the idle countdown and the hard-stop ceiling, every
 *                   one of those is a killer the new model gives up. A shadow
 *                   report that only counts the first direction measures
 *                   whether the new rules are aggressive enough and says
 *                   nothing about whether they are too lenient.
 *
 * BUCKETING IS MANDATORY, not decoration. Against a ~150-row backfilled-zombie
 * noise floor, a handful of genuine live-cohort false positives is statistically
 * invisible, and "would_have_been_wrong_rate < 1%" would pass VACUOUSLY. Every
 * line carries `cohort`, `progress_channel` and `harness` so the live signal can
 * be read separately.
 *
 * READ `last_usage_age_ms: null` CAREFULLY. For a direct-key/BYOK ACP session it
 * means "this box cannot produce that signal", NOT "this box has done nothing".
 * That is why `last_acp_relay_age_ms` is on every line beside it, and why a
 * bucket that is 100% null on BOTH blocks the enforcement flip for that bucket.
 */

import { classifyProgressChannel } from './progress-channel';
import {
  type DeadlineCandidate,
  selectDivergentOldModelStops,
  selectExpiredDeadlineCandidates,
} from './shadow-queries';

export interface DeadlineShadowResult {
  /** Expired rows the query matched, after the per-account cap and batch cap. */
  matching: number;
  /** How many the new model would have stopped. Equals `matching` in shadow. */
  wouldStop: number;
  /** Boxes the OLD model stopped that the new model would have kept. */
  wouldKeep: number;
  /** Always 0 here. Enforcement is a separate decision, after this has data. */
  stopped: number;
  byCohort: Record<string, number>;
  byProgressChannel: Record<string, number>;
  bySource: Record<string, number>;
  overdueMaxHours: number;
  withRecentUsage: number;
  errors: number;
}

export const EMPTY_SHADOW_RESULT: DeadlineShadowResult = {
  matching: 0,
  wouldStop: 0,
  wouldKeep: 0,
  stopped: 0,
  byCohort: {},
  byProgressChannel: {},
  bySource: {},
  overdueMaxHours: 0,
  withRecentUsage: 0,
  errors: 0,
};

function bump(counter: Record<string, number>, key: string): void {
  counter[key] = (counter[key] ?? 0) + 1;
}

/**
 * `PROGRESS_GRANT_MS`, restated locally rather than imported, ON PURPOSE: this
 * threshold is a REPORTING question ("did this box show progress recently
 * enough that killing it would be suspicious"), and coupling it to the grant
 * would silently move the reporting bar whenever the grant moved. Two hours is
 * the number the acceptance criteria are written against.
 */
const RECENT_PROGRESS_MS = 2 * 60 * 60 * 1000;

function hasRecentProgress(candidate: DeadlineCandidate): boolean {
  const usage = candidate.lastUsageAgeMs;
  const relay = candidate.lastAcpRelayAgeMs;
  return (
    (usage !== null && usage < RECENT_PROGRESS_MS) || (relay !== null && relay < RECENT_PROGRESS_MS)
  );
}

/**
 * One structured line per candidate. Deliberately console.log with a stable
 * prefix rather than a metrics counter: the first question an operator asks is
 * "WHICH box, and what did we know about it", and an aggregate cannot answer
 * that. The per-pass aggregate follows separately.
 */
function logWouldStop(candidate: DeadlineCandidate): void {
  console.log('[lifetime] shadow_would_stop', {
    sandbox_id: candidate.sandboxId,
    provider: candidate.provider,
    status: candidate.status,
    source: candidate.source,
    harness: candidate.harness,
    progress_channel: classifyProgressChannel({
      runtime_harness: candidate.harness ?? undefined,
      runtime_transport: candidate.transport ?? undefined,
    }),
    cohort: candidate.cohort ?? 'unknown',
    active_since: candidate.activeSince.toISOString(),
    deadline_at: candidate.deadlineAt.toISOString(),
    overdue_ms: Math.round(candidate.overdueMs),
    age_h: Math.round(candidate.ageHours * 10) / 10,
    last_usage_age_ms:
      candidate.lastUsageAgeMs === null ? null : Math.round(candidate.lastUsageAgeMs),
    last_acp_relay_age_ms:
      candidate.lastAcpRelayAgeMs === null ? null : Math.round(candidate.lastAcpRelayAgeMs),
    // The leading false-kill indicator. Any non-false value here is an
    // extension write we MISSED, not a box that deserves to die.
    had_recent_progress: hasRecentProgress(candidate),
    per_account_rank: candidate.perAccountRank,
  });
}

/**
 * Run one shadow pass. NEVER stops anything, in any configuration reachable
 * from this file — there is no provider call here at all, which is a stronger
 * guarantee than a flag check.
 *
 * `divergenceWindowMs` should be the maintenance tick, so "the old model just
 * stopped this" means "in the pass that ran immediately before this one".
 */
export async function runSandboxDeadlineShadowPass(opts: {
  perAccountCap: number;
  limit: number;
  divergenceWindowMs: number;
}): Promise<DeadlineShadowResult> {
  const result: DeadlineShadowResult = {
    ...EMPTY_SHADOW_RESULT,
    byCohort: {},
    byProgressChannel: {},
    bySource: {},
  };

  let candidates: DeadlineCandidate[] = [];
  try {
    candidates = await selectExpiredDeadlineCandidates({
      perAccountCap: opts.perAccountCap,
      limit: opts.limit,
    });
  } catch (err) {
    // Fail SILENT-BUT-COUNTED, never fatal: shadow mode is an observer and must
    // not be able to break the maintenance tick it rides on. `errors` is on the
    // heartbeat so a permanently broken observer is still visible.
    result.errors += 1;
    console.warn(
      '[lifetime] shadow candidate query failed:',
      err instanceof Error ? err.message : err,
    );
    return result;
  }

  result.matching = candidates.length;
  result.wouldStop = candidates.length;
  for (const candidate of candidates) {
    logWouldStop(candidate);
    bump(result.byCohort, candidate.cohort ?? 'unknown');
    bump(
      result.byProgressChannel,
      classifyProgressChannel({
        runtime_harness: candidate.harness ?? undefined,
        runtime_transport: candidate.transport ?? undefined,
      }),
    );
    bump(result.bySource, candidate.source ?? 'unknown');
    result.overdueMaxHours = Math.max(
      result.overdueMaxHours,
      Math.round((candidate.overdueMs / 3_600_000) * 10) / 10,
    );
    if (hasRecentProgress(candidate)) result.withRecentUsage += 1;
  }

  try {
    const divergent = await selectDivergentOldModelStops(opts.divergenceWindowMs);
    result.wouldKeep = divergent.length;
    for (const row of divergent) {
      console.log('[lifetime] shadow_would_keep', {
        sandbox_id: row.sandboxId,
        provider: row.provider,
        source: row.source,
        cohort: row.cohort ?? 'unknown',
        stopped_at: row.stoppedAt.toISOString(),
        deadline_at: row.deadlineAt.toISOString(),
        // How much life the deadline model would have granted that the old
        // model took away. Large values mean the deletion of the probe / lease
        // / idle countdown loses a killer we still depend on.
        remaining_ms: Math.round(row.remainingMs),
      });
    }
  } catch (err) {
    result.errors += 1;
    console.warn(
      '[lifetime] shadow divergence query failed:',
      err instanceof Error ? err.message : err,
    );
  }

  return result;
}
