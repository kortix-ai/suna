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
 * It is sized by how often the control plane can be expected to LOOK, because
 * that is what the clamp trades against: too small and a single missed
 * maintenance pass zeroes a healthy box's revenue, too large and a dead box
 * keeps billing. 60 minutes is >= 12 maintenance passes (5 min each) of slack
 * for a live box, and the entire ceiling for a dead one.
 *
 * It is deliberately NOT the provider's idle auto-stop any more. Those were one
 * number until 2026-07-30 and the coupling was load-bearing in the wrong
 * direction: raising the provider's timer so it stops killing boxes mid
 * long-tool-run also raised — silently — how long a provably-dead box may bill.
 * See `providerAutoStopBackstopMinutes()` in platform/providers/index.ts. The
 * provider timer remains the *physical* ceiling on a box's existence, and the
 * ordering `billing grace <= provider backstop` is asserted in
 * platform/providers/autostop-backstop.test.ts so an edit that inverts them
 * fails CI —
 * but this number is now free to stay tight while that one is free to grow.
 *
 * What counts as evidence
 * -----------------------
 * ONLY observations made by the control plane. TODAY THAT IS EXACTLY ONE WRITER:
 * `markComputeSessionAlive` in reaping/box-reaper.ts, stamped when the PROVIDER
 * answered `getStatus() === 'running'`. Nothing else writes `lastAliveAt`, and
 * that is deliberate — the stamp must stay somewhere the sandbox cannot reach.
 *
 * The busy probe this comment used to also list is GONE (deleted 2026-07-29 with
 * `projects/sandbox-busy-probe.ts`), and it never belonged here: it asked the box
 * itself, so a wedged daemon answered `busy` forever. Its ACP-transport successor
 * would be worse still — `acp_busy` in the sandbox agent's own `/kortix/health` is
 * `connection.pending.size > 0`, an in-box counter a hung harness pins `true`
 * indefinitely. Never restore either as a liveness input. The same class of defect
 * covers the sandbox's own heartbeat, `lastTurnAt` and `executionLeaseUntil`
 * (renewed every 60s while the in-box agent believed any opencode session was
 * 'busy' OR 'retry'), which is precisely how 188 of 279 prod boxes held a
 * permanent reprieve and billed around the clock. A signal the box authors may
 * never extend its own bill.
 *
 * A live ACP turn is kept alive by `session_sandboxes.deadline_at` instead — see
 * projects/sandbox-deadline.ts and reaping/acp-turn-observation.test.ts.
 */

import { config } from '../../config';

/**
 * Hard floor on the billing grace, and its value in every environment that has
 * not raised the idle window: 60 minutes.
 *
 * A floor rather than a plain constant because the grace can never be shorter
 * than the idle window a box is allowed to sit in — a box the reaper is still
 * legitimately waiting on must not fall out of billing while it waits.
 */
export const BILLING_LIVENESS_GRACE_FLOOR_MINUTES = 60;

/**
 * THE BILLING GRACE. How long a window may keep billing after the last
 * control-plane observation that the box was alive.
 *
 * This is the money guarantee merged in a0cfc7cdb and it must only ever get
 * TIGHTER. Its arithmetic is unchanged from when it was
 * `providerAutoStopBackstopMinutes()`: same floor, same doubling of the idle
 * window, so the clamp's behaviour is byte-identical at every value of
 * KORTIX_SANDBOX_AUTOSTOP_MINUTES. Only the coupling is gone — this reads the
 * idle window directly instead of borrowing a provider-safety number that now
 * needs to be twelve times larger.
 *
 * Doubling the idle window: the reaper may legitimately leave a box running for
 * one idle window; the grace has to cover that plus the pass that ends it.
 */
export function billingLivenessGraceMinutes(): number {
  const idleWindow = Math.max(1, config.KORTIX_SANDBOX_AUTOSTOP_MINUTES || 15);
  return Math.max(BILLING_LIVENESS_GRACE_FLOOR_MINUTES, idleWindow * 2);
}

export function computeLivenessGraceMs(): number {
  return billingLivenessGraceMinutes() * 60_000;
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
