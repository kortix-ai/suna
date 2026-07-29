/**
 * Compute billing accrues against EVIDENCE, not against wall-clock.
 *
 * The inversion, and why it exists
 * --------------------------------
 * `settleComputeWindow` used to charge `now() - last_billed_at` unconditionally,
 * and stopping that accrual was the job of a chain of heuristics: the reaper had
 * to win a race against provider flakiness, an unordered `LIMIT`, a busy probe
 * answered by the box itself, and nine separate stop paths each remembering to
 * call `pauseComputeSession`. Every defect found on 2026-07-29 is the same
 * defect wearing a different hat — a heuristic failed to interrupt an accrual
 * that should never have been running unattended in the first place:
 *
 *   - 44 of 66 open prod rows had a provider status of `unknown`, which the
 *     reconciler read as "do nothing", so they billed forever;
 *   - 17 open rows belonged to sandboxes our own DB already marked
 *     stopped/error — 5,587 sandbox-hours, worst two at 829h (34.5 days) each;
 *   - a box whose wake failed in 134ms kept its meter open;
 *   - ~179 of 279 rows sat permanently outside an unordered batch window.
 *
 * So: a window may only bill up to the last moment we can affirmatively
 * evidence the box was alive, plus the grace below. Absence of evidence stops
 * the meter on its own, with no branch to get wrong. Every leak above becomes
 * arithmetic instead of a race.
 *
 * The grace is not a guess
 * ------------------------
 * Every box is created with the provider's own idle auto-stop set to
 * `providerAutoStopBackstopMinutes()` (60 min in prod — Daytona
 * `autoStopInterval`, Platinum `auto_stop_minutes`). A sandbox therefore
 * physically cannot outlive its last observed activity by more than that: the
 * provider destroys it. Billing past `lastAliveAt + grace` is not a late reap,
 * it is charging for a box that provably no longer exists.
 *
 * What counts as evidence
 * -----------------------
 * ONLY observations made by the control plane: a `getStatus()` that answered
 * `running`, a busy probe the API completed, a proxied request the API served,
 * a real turn. Deliberately NOT the sandbox's own heartbeat — `lastTurnAt` and
 * `executionLeaseUntil` are written by the in-sandbox agent (renewed every 60s
 * while it believes any opencode session is 'busy' OR 'retry'), which is
 * precisely how 188 of 279 prod boxes held a permanent reprieve and billed
 * around the clock. A signal the box authors may never extend its own bill.
 */

import { providerAutoStopBackstopMinutes } from '../../platform/providers';

/**
 * How long a window may keep billing after the last control-plane observation
 * that the box was alive. Pinned to the provider's own idle auto-stop, because
 * that is the hard physical bound on how long the box can still exist.
 */
export function computeLivenessGraceMs(): number {
  return providerAutoStopBackstopMinutes() * 60_000;
}

export function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * The last time the CONTROL PLANE observed this box alive. Falls back to the
 * window's own start, so a row that has never been re-observed still bills its
 * opening grace and no more — a box that failed to start 134ms in bills the
 * grace once and then stops, instead of accruing for weeks.
 */
export function lastAliveAtOf(row: {
  metadata?: unknown;
  startedAt: string | Date;
}): Date {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  const stamped = parseTimestamp(metadata.lastAliveAt);
  const startedAt = parseTimestamp(row.startedAt) ?? new Date(0);
  if (stamped && stamped.getTime() > startedAt.getTime()) return stamped;
  return startedAt;
}

/**
 * THE CLAMP. The end of the billable window: never later than the last
 * affirmative liveness evidence plus the provider's own auto-stop ceiling.
 *
 * This single expression is what caps the entire defect class. It does not need
 * to know why the box died, whether a reaper pass reached it, whether the
 * provider answered `unknown`, or whether some caller forgot to close the meter
 * — none of those can extend a bill past evidence any more.
 *
 * Pure so the money semantics are exhaustively unit-tested.
 */
export function billableWindowEnd(input: {
  requestedEnd: Date;
  lastAliveAt: Date;
  graceMs: number;
}): Date {
  const ceiling = input.lastAliveAt.getTime() + input.graceMs;
  return input.requestedEnd.getTime() <= ceiling ? input.requestedEnd : new Date(ceiling);
}

/**
 * True when a window has run past its evidence ceiling and can never bill
 * another second — the meter is dead weight and the invariant sweep should
 * close it. Purely derived, so it needs no extra state to be correct.
 */
export function isBeyondLivenessCeiling(input: {
  now: Date;
  lastAliveAt: Date;
  graceMs: number;
}): boolean {
  return input.now.getTime() > input.lastAliveAt.getTime() + input.graceMs;
}
