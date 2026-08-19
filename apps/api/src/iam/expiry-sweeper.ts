// Sweeper for time-bounded grants.
//
// The engine already filters expired assignments out of authorize() (the
// `expires_at IS NULL OR expires_at > now()` predicate on every read), so
// correctness does not depend on this job. What it adds:
//
//   1. One `iam.assignment.expired` audit event per assignment that has just
//      lapsed, so an admin reading the audit log can see WHY a member lost
//      access today.
//   2. A latch on the row (`updated_at` touched past `expires_at`) so the same
//      expiry is never logged twice.
//
// It does NOT delete the row. The grant stays visible in the audit trail as an
// expired assignment until it is removed deliberately.
//
// ONE table now. This used to sweep `project_members` and
// `project_group_grants` separately and knew nothing about `iam_policies` or
// `iam_resource_grants` — so a lapsed custom-role binding or object grant
// produced no audit event at all. `role_assignments` holds all five, so one
// pass covers every kind of grant.
//
// Cadence: every 60s. The partial index on `expires_at` keeps the scan cheap —
// only rows with a bounded grant are visited.
//
// Concurrency model: each tick uses a single UPDATE … RETURNING to atomically
// claim the rows it is going to audit. Postgres serializes per-row UPDATEs, so
// when N API replicas run the sweeper in the same minute, every expired row is
// returned to EXACTLY ONE replica — no duplicate audit events.

import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import { auditAssignmentExpired, listAssignmentsByIds } from './assignments';

const TICK_MS = 60_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;

// Recursive setTimeout (not setInterval) so a slow tick can't cause overlapping
// runs: with setInterval, a tick that took longer than TICK_MS would start the
// next one before the prior finished — two ticks racing inside one process,
// the same duplicate-audit problem the multi-replica case had. Re-arming AFTER
// settle guarantees serial execution per process.
export function startGrantExpirySweeper(): void {
  if (timer) return; // already armed, idempotent
  stopped = false;
  // Fire once on boot so an expiry that happened during downtime is logged
  // immediately rather than waiting up to a minute.
  void tickAndRearm();
}

async function tickAndRearm(): Promise<void> {
  try {
    await runOnce();
  } catch (err) {
    console.error('[iam expiry sweeper] tick failed', err);
  }
  if (stopped) return;
  timer = setTimeout(tickAndRearm, TICK_MS);
}

export function stopGrantExpirySweeper(): void {
  stopped = true;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * One pass over `role_assignments`.
 *
 * 1. UPDATE … RETURNING atomically claims every row that is both expired AND
 *    not yet audited (`updated_at < expires_at`).
 * 2. One audit event per claimed row.
 *
 * The "newly expired" predicate is `expires_at < now() AND updated_at <
 * expires_at` — the row has not been touched since its own expiry. Setting
 * `updated_at = now()` flips the latch, so the next tick (or another replica's
 * concurrent tick) will not re-match. `now()` on both sides of the predicate and
 * in the SET keeps the database clock the single source of truth.
 *
 * If the audit insert fails the row is already latched, so the next tick will
 * not retry. Deliberate: dropping one audit event beats spinning forever.
 */
async function runOnce(): Promise<void> {
  // Raw SQL: the latch predicate compares two columns of the SAME row, and the
  // whole claim has to be one statement for the multi-replica guarantee to hold.
  const claimed = await db.execute<{ assignment_id: string }>(sql`
    update kortix.role_assignments
       set updated_at = now()
     where expires_at is not null
       and expires_at < now()
       and updated_at < expires_at
    returning assignment_id
  `);
  const rows = (claimed as unknown as { rows?: Array<{ assignment_id: string }> }).rows ?? claimed;
  const ids = (rows as Array<{ assignment_id: string }>).map((r) => r.assignment_id);
  if (ids.length === 0) return;

  // Re-read with the role join so the audit payload carries the role KEY, not
  // just its uuid — the whole point of the event is that a human can read it.
  const assignments = await listAssignmentsByIds(ids);
  await Promise.all(
    assignments.map((row) =>
      auditAssignmentExpired(row.accountId, row).catch((err) =>
        console.error('[iam expiry sweeper] audit failed for assignment', row.assignmentId, err),
      ),
    ),
  );
}
