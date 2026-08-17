/**
 * THE bounded rule for how long a sandbox lives.
 *
 * A sandbox carries `deadline_at`. The reaper stops any active box whose
 * deadline has passed. This module owns ordinary grants and contractions. The
 * separate sandbox-turn-lifecycle.ts module owns durable active-turn renewal.
 *
 *   extendSandboxDeadline  — a CONTROL-PLANE-OBSERVED event. Monotone and
 *                            capped: LEAST(active_since + CAP, GREATEST(...)).
 *   shortenSandboxDeadline — a SANDBOX-REPORTED terminal turn end. LEAST only,
 *                            so it is structurally incapable of extending, which
 *                            is why the payload's provenance does not matter and
 *                            it can be best-effort and duplicated freely.
 *
 * THE INVARIANT: a sandbox-reported signal may only SHORTEN a sandbox's life.
 * Only a control-plane observation, or a durable record created by one, may
 * EXTEND it. Non-turn observations remain bounded. Exact active-turn evidence
 * renews through sandbox-turn-lifecycle.ts without a wall-clock cap.
 *
 * `active_since` is never assigned here. A BEFORE trigger owns the provider-run
 * timestamp and keeps it immutable during that run.
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
  NON_TURN_DEADLINE_CAP_MS,
  idleGraceMs,
  isTerminalTurnEnd,
  isWarmPoolBox,
  turnGrantMs,
  turnDeliveryGraceMs,
  warmPoolGrantMs,
} from './sandbox-deadline-policy';

export {
  NON_TURN_DEADLINE_CAP_MS,
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
 * The non-turn extend statement. It is monotone and capped within one provider
 * run. Active-turn renewal uses a separate exact-token statement.
 */
function extendStatement(target: DeadlineTarget, grantMs: number) {
  return sql`
    UPDATE kortix.session_sandboxes s
       SET deadline_at = LEAST(
             s.active_since + make_interval(secs => ${secs(NON_TURN_DEADLINE_CAP_MS)}),
             GREATEST(s.deadline_at, now() + make_interval(secs => ${secs(grantMs)}))),
           updated_at = now()
     WHERE ${targetPredicate(target)} AND s.status IN ('active', 'provisioning')
    RETURNING true AS extended`;
}

/**
 * CONTROL-PLANE-OBSERVED extension. Monotone (concurrent writers cannot lose an
 * extension) and capped for non-turn observations.
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
