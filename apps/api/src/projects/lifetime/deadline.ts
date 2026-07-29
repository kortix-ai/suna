/**
 * BOUNDED SANDBOX LIFETIME — THE ONLY TYPESCRIPT WRITER of `deadline_at`.
 *
 * `projects/lifetime/architecture.test.ts` fails CI if any other file under
 * apps/api/src assigns `deadline_at` / `deadlineAt` / `active_since` /
 * `activeSince`, and if this file's import list changes. That allowlist is the
 * crispest boundary available: this module CANNOT reach a request body, a
 * provider adapter, or a sandbox response, because it cannot import anything
 * that produces one. The only value that crosses in from the outside is a
 * `number` of milliseconds and an `ObservedExtension` it cannot forge.
 *
 * RULE ZERO: ALL DEADLINE ARITHMETIC IS EVALUATED IN POSTGRES, NEVER IN NODE.
 * Every statement below uses SQL `now()` and passes grants as INTERVALS, never
 * as computed instants. Two consequences, both load-bearing:
 *   - API-instance clock skew leaves the money path entirely. A fast clock on
 *     one pod cannot shorten a deadline another pod just wrote.
 *   - Every write is a SINGLE MONOTONE STATEMENT rather than a
 *     read-modify-write, which removes the lost-update race class outright —
 *     the same class that produced the jsonb clobbering `applyStoppedState`
 *     had to be fixed for.
 *
 * THE SHAPE OF EVERY EXTENDING WRITE:
 *
 *     deadline_at = LEAST( active_since + ABSOLUTE_RUN_CAP,
 *                          GREATEST( deadline_at, now() + grant ) )
 *
 *   GREATEST  never shortens  → concurrent writers cannot lose an extension.
 *   LEAST     never exceeds the cap → the DB CHECK stays unreachable in normal
 *             operation, which is the point of having it: it exists to catch a
 *             FUTURE writer, not this one.
 *
 * `active_since` is NEVER assigned here. It is written exclusively by the
 * `session_sandboxes_anchor_guard` BEFORE trigger, which makes it immutable
 * within a running stretch. That immutability is what turns the CHECK into a
 * ceiling — a constraint on a difference whose left operand a caller can slide
 * forward is a suggestion, not a bound.
 */

import { sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { ABSOLUTE_RUN_CAP_MS } from './constants';
import type { ObservedExtension } from './observation';

/** Where a write lands. Exactly one of the two is supplied. */
export type DeadlineTarget = { sandboxId: string } | { sessionId: string };

function seconds(ms: number): number {
  return Math.round(ms / 1000);
}

/**
 * The extending statement, in one place so `anchorDeadline` and
 * `extendDeadline` cannot drift apart. Not exported: a caller reaching this
 * without a proof is the exact mistake the proof type exists to prevent.
 */
async function writeExtension(target: DeadlineTarget, grantMs: number): Promise<void> {
  const grant = seconds(grantMs);
  const cap = seconds(ABSOLUTE_RUN_CAP_MS);
  const where =
    'sandboxId' in target
      ? sql`s.sandbox_id = ${target.sandboxId}::uuid`
      : sql`s.session_id = ${target.sessionId}`;
  await db.execute(sql`
    UPDATE kortix.session_sandboxes s
       SET deadline_at = LEAST(
             s.active_since + make_interval(secs => ${cap}),
             GREATEST(s.deadline_at, now() + make_interval(secs => ${grant}))
           ),
           updated_at = now()
     WHERE ${where}
       AND s.status IN ('active', 'provisioning')
  `);
}

/**
 * W1 / W6 — a new running stretch begins.
 *
 * MUST BE CALLED AFTER the statement that flips the row to `active`, not
 * before. The anchor-guard trigger sets `active_since := now()` on that
 * transition, so by the time this runs the cap operand is fresh and
 * `now() + grant` is comfortably inside it. Called before the flip, the LEAST
 * would clamp against the anchor the box carried while it was PARKED — for a
 * box stopped 50 hours ago, into the past.
 *
 * Monotone like every other extending write, so it can never shorten a window
 * the trigger's 20-minute boot floor already granted. A caller passing a grant
 * BELOW that floor (e.g. IDLE_GRACE on resume) therefore gets the floor. That
 * is deliberate: the floor exists because a box that becomes active with an
 * already-expired deadline presents to a user as "Start does nothing".
 */
export async function anchorDeadline(
  sandboxId: string,
  initialGrantMs: number,
  _proof: ObservedExtension,
): Promise<void> {
  await writeExtension({ sandboxId }, initialGrantMs);
}

/**
 * W2 / W3b / W3c / W5 — a control-plane-OBSERVED, non-sandbox-authored event.
 *
 * The proof is NON-nullable on purpose. `observeExtension` returns
 * `ObservedExtension | null`, so every call site is forced to handle the
 * self-authored case explicitly rather than passing a null through and having
 * it silently mean "extend anyway".
 *
 * `_proof` is unused at runtime by design — its entire job is at the type
 * level. Do not "clean it up" into an optional parameter; that deletes layer 2
 * of the structural guard.
 */
export async function extendDeadline(
  target: DeadlineTarget,
  grantMs: number,
  _proof: ObservedExtension,
): Promise<void> {
  await writeExtension(target, grantMs);
}

/**
 * W4 — turn end. The ONE write a sandbox-reported signal is allowed to drive.
 *
 * No GREATEST, no `active_since`, no cap, and no proof parameter: the statement
 * is STRUCTURALLY INCAPABLE of extending, so its provenance does not matter.
 * That is why the payload here may be sandbox-authored, best-effort and
 * deduplicated without weakening anything.
 */
export async function shortenDeadline(
  target: { sessionId: string },
  graceMs: number,
): Promise<void> {
  const grace = seconds(graceMs);
  await db.execute(sql`
    UPDATE kortix.session_sandboxes s
       SET deadline_at = LEAST(s.deadline_at, now() + make_interval(secs => ${grace})),
           updated_at = now()
     WHERE s.session_id = ${target.sessionId}
       AND s.status = 'active'
  `);
}
