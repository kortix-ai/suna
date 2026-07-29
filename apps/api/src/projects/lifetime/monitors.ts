/**
 * BOUNDED SANDBOX LIFETIME — the two monitors, one per fail direction.
 *
 * Deliberately mirrors `billing/services/compute-invariant-sweep.ts`, which
 * already pairs `countBillingInvariantViolations` (over-billing, loud) with
 * `countStaleLivenessWindows` (under-billing, silent). That module's own
 * comment states the operating principle this file inherits: an outage that
 * fails LOUDLY is strictly easier to run than one that fails SILENTLY, so every
 * mechanism needs a counter on BOTH of its fail directions.
 *
 *   M1  the fix is NOT HOLDING     boxes alive past their deadline
 *   M2  the fix is TOO AGGRESSIVE  boxes stopped while a turn was live
 *
 * Both are cheap and DB-only. Neither talks to a provider: a monitor that can
 * be slowed down or 429'd by the thing it is monitoring is a monitor that goes
 * quiet exactly when it matters.
 *
 * These run in shadow mode too, and that is the point. M1 measures the leak
 * itself — today it should read the whole wedged population — and M2 must read
 * ZERO until enforcement is flipped on, which makes it a free correctness check
 * on the claim that nothing in this change kills anything.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { PROGRESS_GRANT_MS } from './constants';

/**
 * How long past its deadline a box may be before it counts as overdue. Absorbs
 * the maintenance tick plus a provider stop round-trip, so a healthy fleet
 * mid-drain does not alert.
 */
const OVERDUE_TOLERANCE_MS = 15 * 60_000;

export interface AlivePastDeadline {
  /** Rows still running more than the tolerance past their deadline. */
  overdue: number;
  /** Worst case in seconds. A large value is a stalled sweep, not a backlog. */
  maxOverdueSeconds: number;
}

/**
 * M1 — ALIVE PAST DEADLINE. "The fix is not holding."
 *
 * If this stays at zero the leak is fixed, and that is the entire success
 * criterion of this feature stated as one number.
 *
 * Expected 0 with enforcement on. Alert at `overdue > 5` on two consecutive
 * scrapes; page at `maxOverdueSeconds > 3600`.
 *
 * IN SHADOW MODE THIS IS THE LEAK ITSELF and will read ~150+. That is not a
 * regression — it is the measurement this change exists to produce. Do not
 * alert on it until enforcement is enabled.
 *
 * NOTE ON WHAT IT CANNOT SEE: a box running on the provider with no live DB row
 * hides from this query by construction. That gap is the orphan-box sweep's,
 * and it must NOT be re-implemented against the orphan keepSet — that keeps any
 * row touched in the last 15 minutes, which is exactly the shape a leaked box
 * has while it is still phoning home.
 */
export async function countAlivePastDeadline(): Promise<AlivePastDeadline> {
  const toleranceSeconds = Math.round(OVERDUE_TOLERANCE_MS / 1000);
  const rows = await db.execute<{ overdue: number; max_overdue_s: number }>(sql`
    SELECT count(*)::int AS overdue,
           coalesce(max(EXTRACT(EPOCH FROM (now() - deadline_at))), 0)::int AS max_overdue_s
      FROM kortix.session_sandboxes
     WHERE status IN ('active', 'provisioning')
       AND deadline_at < now() - make_interval(secs => ${toleranceSeconds})
  `);
  const row = [...rows][0];
  return {
    overdue: Number(row?.overdue ?? 0),
    maxOverdueSeconds: Number(row?.max_overdue_s ?? 0),
  };
}

export interface KilledWithLiveTurn {
  /**
   * THE LEADING INDICATOR, and it is 0 BY CONSTRUCTION. A deadline stop of a
   * box that showed billed or relayed progress inside the progress grant means
   * an extension write was MISSED — it does not mean the box deserved to die.
   * Alert on >= 1.
   */
  stoppedWithRecentProgress: number;
  /** Deadline stops in the window, the denominator for the rate below. */
  deadlineStops: number;
  /**
   * THE LAGGING, USER-VISIBLE INDICATOR. Sessions that received a new prompt
   * within 10 minutes of a deadline stop — a human saying "that shouldn't have
   * stopped" with their hands.
   *
   * This is the honest one. It catches the INVISIBLE variant the leading
   * indicator structurally cannot: a turn doing two hours of purely local tool
   * work, with no LLM call and no client attached, is indistinguishable from a
   * wedged box in every signal we have. Alert above 5%; simulation expectation
   * is 1-3%.
   */
  rePromptedWithin10Min: number;
  /** Stops attributable to the absolute 24h cap rather than to inactivity. */
  runCapStops: number;
}

/**
 * M2 — KILLED WITH A LIVE TURN. "The fix is too aggressive."
 *
 * Reads `metadata.deadlineStop`, which the enforcing sweep will stamp in the
 * same jsonb merge that writes the stop. In shadow mode nothing stamps it, so
 * every counter here is 0 — which is a genuine assertion that this change kills
 * nothing, not a placeholder.
 */
export async function countKilledWithLiveTurn(
  windowMs = 24 * 3_600_000,
): Promise<KilledWithLiveTurn> {
  const windowSeconds = Math.round(windowMs / 1000);
  const grantMs = PROGRESS_GRANT_MS;
  const rows = await db.execute<Record<string, unknown>>(sql`
    WITH stops AS (
      SELECT s.session_id,
             (s.metadata->'deadlineStop'->>'atIso')::timestamptz AS stopped_at,
             (s.metadata->'deadlineStop'->>'lastUsageAgeMs')::numeric AS last_usage_age_ms,
             (s.metadata->'deadlineStop'->>'lastAcpRelayAgeMs')::numeric AS last_relay_age_ms,
             (s.metadata->'deadlineStop'->>'grantSource') AS grant_source
        FROM kortix.session_sandboxes s
       WHERE s.metadata ? 'deadlineStop'
         AND (s.metadata->'deadlineStop'->>'atIso')::timestamptz
             > now() - make_interval(secs => ${windowSeconds})
    )
    SELECT count(*)::int AS deadline_stops,
           count(*) FILTER (
             WHERE stops.last_usage_age_ms < ${grantMs}
                OR stops.last_relay_age_ms < ${grantMs}
           )::int AS stopped_with_recent_progress,
           count(*) FILTER (WHERE stops.grant_source = 'run-cap')::int AS run_cap_stops,
           count(*) FILTER (
             WHERE EXISTS (
               SELECT 1 FROM kortix.usage_events u
                WHERE u.session_id = stops.session_id
                  AND u.created_at > stops.stopped_at
                  AND u.created_at < stops.stopped_at + interval '10 minutes'
             )
             OR EXISTS (
               SELECT 1 FROM kortix.acp_session_envelopes e
                WHERE e.session_id = stops.session_id
                  AND e.created_at > stops.stopped_at
                  AND e.created_at < stops.stopped_at + interval '10 minutes'
             )
           )::int AS re_prompted
      FROM stops
  `);
  const row = [...rows][0] ?? {};
  return {
    deadlineStops: Number(row.deadline_stops ?? 0),
    stoppedWithRecentProgress: Number(row.stopped_with_recent_progress ?? 0),
    rePromptedWithin10Min: Number(row.re_prompted ?? 0),
    runCapStops: Number(row.run_cap_stops ?? 0),
  };
}

/**
 * The rate the alert is actually written against. Returns null rather than 0
 * when there were no stops at all: "0% of nothing" and "0% of 300" are
 * different facts, and collapsing them is how a broken pipeline reads as a
 * healthy one.
 */
export function rePromptAfterDeadlineStopRate(m2: KilledWithLiveTurn): number | null {
  if (m2.deadlineStops === 0) return null;
  return m2.rePromptedWithin10Min / m2.deadlineStops;
}
