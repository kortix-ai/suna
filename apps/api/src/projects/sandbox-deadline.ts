/**
 * THE bounded rule for how long a sandbox lives.
 *
 * A sandbox carries `deadline_at`. The reaper stops any active box whose
 * deadline has passed. This module owns ordinary grants and contractions. The
 * separate sandbox-turn-lifecycle.ts module owns durable active-turn renewal.
 *
 *   extendSandboxDeadline  — a CONTROL-PLANE-OBSERVED event. Monotone and
 *                            capped: GREATEST(deadline_at, LEAST(active_since +
 *                            CAP, now() + grant)). In that order: the cap bounds
 *                            what this grant may ADD, never what another writer
 *                            already granted (see cappedDeadline).
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
  turnUnconfirmedDripMs,
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
  turnUnconfirmedDripMs,
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
 * The bounded deadline every non-turn grant writes: monotone (GREATEST against
 * the stored deadline, so nothing this statement does can ever SHORTEN a box's
 * life) and capped within one provider run (LEAST against the immutable
 * anchor, so what it GRANTS can never outlive that cap). One definition,
 * because two copies of this expression is exactly how a grant loses its cap.
 *
 * THE NESTING ORDER IS THE WHOLE SAFETY ARGUMENT, and it was wrong once. With
 * the cap on the OUTSIDE — LEAST(anchor + 24h, GREATEST(deadline, now+grant)) —
 * every extend truncated the deadline of any box whose provider run had already
 * passed `active_since + 24h`. Such boxes are legal and routine: active-turn
 * renewal is deliberately uncapped (sandbox-turn-lifecycle.ts) and migration
 * 20260817150000000 dropped the `session_sandboxes_deadline_within_cap` CHECK
 * precisely so an OBSERVED turn may outlive the anchor cap. So a 30h-old box
 * holding a turn renewed to `now + 4h` had its deadline rewritten ~6h into the
 * PAST by the very next observation, and the following reaper pass cleared the
 * record and parked it MID-TURN.
 *
 * GREATEST on the outside keeps both properties and removes the contraction:
 * the result is never below `s.deadline_at`, and the only value this statement
 * can introduce is bounded by the anchor cap. A non-turn observation still
 * cannot push a box past 24h of its run; it simply cannot pull one back either.
 * Contraction has exactly one owner — `shortenSandboxDeadline`, which is
 * LEAST-only and structurally unable to extend.
 */
function cappedDeadline(grantMs: number) {
  return sql`GREATEST(
             s.deadline_at,
             LEAST(
               s.active_since + make_interval(secs => ${secs(NON_TURN_DEADLINE_CAP_MS)}),
               now() + make_interval(secs => ${secs(grantMs)})))`;
}

/**
 * The non-turn extend statement. It is monotone and capped within one provider
 * run. Active-turn renewal uses a separate exact-token statement.
 */
function extendStatement(target: DeadlineTarget, grantMs: number) {
  return sql`
    UPDATE kortix.session_sandboxes s
       SET deadline_at = ${cappedDeadline(grantMs)},
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
 * The BOUNDED DRIP for a provider-running box whose daemon says nothing about a
 * turn the control plane can prove it minted.
 *
 * This is a control-plane observation, not a sandbox-reported one, and it
 * satisfies the invariant at the top of this file: the box authors no part of
 * it. The provider — not the box — reports the VM running, and the turn record
 * it is measured against was written by the API before any prompt left it. The
 * sandbox cannot create a record, choose its token, or refuse the probe into
 * being drip-fed: the caller (reaping/box-reaper.ts) grants this only while
 * that record is fresher than the turn grant, so a box that stays mute simply
 * ages out of the drip.
 *
 * `deadlineGrant` is stamped because the incident that produced this function
 * was diagnosed from that key, and it read `boot_floor` for a box nothing was
 * keeping alive. A drip-fed box now says so in its own row.
 *
 * NOT `cappedDeadline`, and that is deliberate. `active_since` is the immutable
 * anchor of the current provider run, so on a box running longer than
 * NON_TURN_DEADLINE_CAP_MS the capped expression's inner LEAST is already in
 * the PAST and GREATEST returns `deadline_at` untouched: the drip did nothing
 * at all for exactly the long-running mid-turn boxes it exists to save, while
 * still RETURNING a row and stamping `deadlineGrant`, so the row and the log
 * both claimed a box was being kept alive whose deadline never moved.
 *
 * The anchor cap bounds NON-TURN observations. This box holds turn authority
 * the control plane minted, and `renewActiveSandboxTurn` — the same evidence
 * class, only stronger — is uncapped for that reason. What bounds THIS grant is
 * the caller's freshness gate (reaping/box-reaper.ts): a `delivering` record
 * stops earning horizons at its delivery grace, an accepted one at the turn
 * grant, and a daemon that answers nothing at all never earns one.
 */
export async function extendUnconfirmedTurnDeadline(
  sandboxId: string,
  grantMs: number = turnUnconfirmedDripMs(),
): Promise<boolean> {
  try {
    const result = await db.execute(sql`
      UPDATE kortix.session_sandboxes s
         SET deadline_at = GREATEST(
               s.deadline_at,
               now() + make_interval(secs => ${secs(grantMs)})),
             metadata = coalesce(s.metadata, '{}'::jsonb)
               || jsonb_build_object('deadlineGrant', 'turn_unconfirmed'),
             updated_at = now()
       WHERE s.sandbox_id = ${sandboxId}::uuid AND s.status = 'active'
      RETURNING true AS extended`);
    const rows = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] } | null | undefined)?.rows;
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    // The pass must survive a failed drip: losing it costs this box one horizon
    // of life, never the sweep that stops every other expired box.
    console.warn(
      `[deadline] turn_unconfirmed drip failed for ${sandboxId}:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
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
