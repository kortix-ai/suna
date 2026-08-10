/**
 * THE bounded rule for how long a sandbox lives.
 *
 * A sandbox carries `deadline_at`. The reaper stops any active box whose
 * deadline has passed. This module is the ONLY TypeScript that names that
 * column, and it offers exactly three operations:
 *
 *   extendSandboxDeadline  — a CONTROL-PLANE-OBSERVED event. Monotone and
 *                            capped: LEAST(active_since + CAP, GREATEST(...)).
 *   observeTurnStart       — extendSandboxDeadline, but it REPORTS whether the
 *                            grant actually landed in the future, so the caller
 *                            can refuse work it is about to kill.
 *   shortenSandboxDeadline — a SANDBOX-REPORTED terminal turn end. LEAST only,
 *                            so it is structurally incapable of extending, which
 *                            is why the payload's provenance does not matter and
 *                            it can be best-effort and duplicated freely.
 *
 * THE INVARIANT: a sandbox-reported signal may only SHORTEN a sandbox's life.
 * Only a control-plane-observed event may EXTEND it, and only up to a bounded
 * ceiling. The three observations that qualify, and why, are documented on
 * their grants in ./sandbox-deadline-policy.ts: a prompt POST the API itself
 * relayed, a gateway LLM call, and authenticated human traffic to a preview
 * port.
 *
 * `active_since` is never assigned here, or anywhere else in TypeScript — a
 * BEFORE trigger owns it and makes it immutable in EVERY state. That is what
 * makes the cap real rather than advisory: a CHECK on a difference whose left
 * operand a caller can slide forward is a suggestion, not a bound.
 *
 * All arithmetic is evaluated in Postgres against SQL `now()`, with grants
 * passed as INTERVALS rather than as computed instants. Two consequences:
 * API-pod clock skew leaves the money path entirely, and every write is one
 * monotone statement instead of a read-modify-write that concurrent callers
 * could lose.
 */

import { sql } from 'drizzle-orm';
import { db } from '../shared/db';
import {
  ABSOLUTE_RUN_CAP_MS,
  idleGraceMs,
  isTerminalTurnEnd,
  isWarmPoolBox,
  turnGrantMs,
  turnDeliveryGraceMs,
  warmPoolGrantMs,
} from './sandbox-deadline-policy';

export {
  ABSOLUTE_RUN_CAP_MS,
  childIdleGraceMs,
  createExtendThrottle,
  idleGraceMs,
  isPreviewUseObservation,
  isSandboxAuthored,
  isTerminalTurnEnd,
  isTurnStartRequest,
  isWarmPoolBox,
  llmActivityGrantMs,
  previewGrantMs,
  turnGrantMs,
  turnDeliveryGraceMs,
  warmPoolGrantMs,
} from './sandbox-deadline-policy';

export type DeadlineTarget = { sandboxId: string } | { sessionId: string } | { externalId: string };

function targetPredicate(t: DeadlineTarget) {
  if ('sandboxId' in t) return sql`s.sandbox_id = ${t.sandboxId}::uuid`;
  if ('sessionId' in t) return sql`s.session_id = ${t.sessionId}`;
  return sql`s.external_id = ${t.externalId}`;
}

const secs = (ms: number) => Math.round(ms / 1000);

/**
 * THE extend statement, shared by both callers so there is exactly one place
 * where the cap and the monotonicity live. `RETURNING` reports whether the
 * resulting deadline is in the FUTURE — false means the box has burned its whole
 * 24-hour stretch and no grant can move it, which is the one thing a caller may
 * need to act on (see observeTurnStart).
 */
function extendStatement(target: DeadlineTarget, grantMs: number) {
  return sql`
    UPDATE kortix.session_sandboxes s
       SET deadline_at = LEAST(
             s.active_since + make_interval(secs => ${secs(ABSOLUTE_RUN_CAP_MS)}),
             GREATEST(s.deadline_at, now() + make_interval(secs => ${secs(grantMs)}))),
           updated_at = now()
     WHERE ${targetPredicate(target)} AND s.status IN ('active', 'provisioning')
    RETURNING (s.deadline_at > now()) AS live`;
}

/**
 * CONTROL-PLANE-OBSERVED extension. Monotone (concurrent writers cannot lose an
 * extension) and clamped (the CHECK stays unreachable in normal operation,
 * which is the point: it exists to catch a FUTURE writer, so this must not
 * silently clamp below it either).
 *
 * Callers MUST gate this on the request not being sandbox-authored — the box
 * holds a credential that produces a perfectly valid principal for requests it
 * writes itself, and letting those through would rebuild the exact self-renewal
 * this design deletes. One line at each call site, and the session id MUST come
 * from `callerKortixSessionId` — the raw `c.get('sessionId')` is the SUPABASE
 * AUTH SESSION id under `supabaseAuth`, which reads every browser user as the
 * sandbox and silently disables the whole observation (see
 * sandbox-deadline-call-sites.test.ts):
 *   if (!isSandboxAuthored(c.get('apiKeyType'), callerKortixSessionId(c))) …
 */
export async function extendSandboxDeadline(
  target: DeadlineTarget,
  grantMs: number = turnGrantMs(),
): Promise<void> {
  await db.execute(extendStatement(target, grantMs));
}

/**
 * 'granted'  — the box has a live deadline; go ahead and run the turn.
 * 'at_cap'   — the box has burned its entire 24-hour stretch. Nothing can extend
 *              it; it is about to be stopped.
 * 'no_box'   — no active/provisioning row matched (already parked, or gone).
 */
export type TurnStartObservation = 'granted' | 'at_cap' | 'no_box';

/**
 * Observe a turn START and report whether the box can actually host it.
 *
 * WHY THIS IS AWAITED ON THE PROMPT PATH. `extendSandboxDeadline` alone is
 * fire-and-forget, which is right for every other observation. But at the
 * absolute cap the grant clamps to `active_since + 24h`, which is already in the
 * past, so a fire-and-forget extend would ACCEPT the prompt and then let the
 * reaper stop the box seconds later — mid-work, with the user's message
 * swallowed. Accepting work you are about to kill is worse than refusing it, so
 * the prompt paths await one indexed UPDATE (sub-millisecond, against a proxy
 * round-trip measured in seconds) and refuse cleanly at the cap.
 *
 * Fails OPEN on anything unexpected — a driver returning a shape we didn't
 * anticipate, a transient error — because refusing a user's prompt on
 * uncertainty is far worse than granting one turn too many, and the DB CHECK is
 * still the real bound.
 */
export async function observeTurnStart(
  target: DeadlineTarget,
  grantMs: number = turnGrantMs(),
): Promise<TurnStartObservation> {
  let result: unknown;
  try {
    result = await db.execute(extendStatement(target, grantMs));
  } catch (err) {
    console.warn(
      '[deadline] turn-start observation failed (failing open):',
      err instanceof Error ? err.message : err,
    );
    return 'granted';
  }
  const rows = normalizeReturning(result);
  if (rows === null) return 'granted'; // unknown driver shape → never refuse work
  if (rows.length === 0) return 'no_box';
  return rows[0]?.live === false ? 'at_cap' : 'granted';
}

/** Drizzle's `execute` yields the row array on postgres-js and `{ rows }` on
 *  node-postgres. Null means "this is neither" — the caller then fails open. */
function normalizeReturning(result: unknown): Array<{ live?: unknown }> | null {
  if (Array.isArray(result)) return result as Array<{ live?: unknown }>;
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Array<{ live?: unknown }>) : null;
}

/**
 * SANDBOX-REPORTED contraction. No GREATEST, no active_since, no cap: it cannot
 * extend anything, so it does not matter that the sandbox is the one saying it.
 *
 * Only ever called for a TERMINAL turn end — see `isTerminalTurnEnd`. A
 * retryable `session.error` is opencode backing off mid-turn, not a turn end,
 * and pulling the deadline in there killed boxes during rate-limit backoffs.
 */
export async function shortenSandboxDeadline(
  sessionId: string,
  graceMs: number = idleGraceMs(),
): Promise<void> {
  await db.execute(sql`
    UPDATE kortix.session_sandboxes s
       SET deadline_at = LEAST(s.deadline_at, now() + make_interval(secs => ${secs(graceMs)})),
           updated_at = now()
     WHERE s.session_id = ${sessionId} AND s.status = 'active'`);
}

/**
 * The turn-end relay's whole deadline responsibility, in one call: shorten the
 * box IFF the turn genuinely ended.
 *
 * Exists as its own function rather than an `if` at the call site because the
 * decision is the entire bug. `session.error` also fires while opencode is
 * RETRYING — a 429 backoff, a transient upstream 5xx — and shortening there cut
 * the box to the 15-minute idle tail MID-TURN, so any backoff longer than that
 * killed live work. Keeping the classifier and the write bound together means a
 * future caller cannot wire up the write and forget the test.
 */
export async function shortenSandboxDeadlineOnTurnEnd(
  sessionId: string,
  status: 'idle' | 'error',
  error?: { isRetryable?: boolean } | null,
  graceMs?: number,
): Promise<void> {
  if (!isTerminalTurnEnd(status, error)) return;
  await shortenSandboxDeadline(sessionId, graceMs);
}

/**
 * Give a freshly provisioned WARM-POOL box its whole (bounded) lifetime.
 *
 * A warm box is the one box that can never be observed: nobody has claimed it,
 * so it has no turns, no LLM calls and no human preview traffic, and under the
 * bare 15-minute boot floor it was always reaped before it could be handed out.
 * The control plane itself decided to bake it, which is as control-plane-observed
 * as an event gets, so it is granted its lifetime up front instead.
 *
 * A no-op for every other box, and best-effort: losing this write costs the warm
 * box its head start, never correctness.
 */
export async function grantWarmPoolLifetime(
  sandboxId: string,
  metadata: Record<string, unknown> | null | undefined,
): Promise<void> {
  if (!isWarmPoolBox(metadata)) return;
  await extendSandboxDeadline({ sandboxId }, warmPoolGrantMs()).catch((err) =>
    console.warn(
      `[deadline] warm-pool grant failed for ${sandboxId}:`,
      err instanceof Error ? err.message : err,
    ),
  );
}
