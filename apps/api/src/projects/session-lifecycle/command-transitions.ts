import { sessionLifecycleCommands } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { deadLetterCause } from './dead-letter-cause';
import { logger } from '../../lib/logger';
import { extendSandboxDeadline } from '../sandbox-deadline';
import { promptRetryGraceMs } from '../sandbox-deadline-policy';
import { db } from '../../shared/db';
import { markTriggerRuntimeDeliveryFailed } from '../trigger-execution-store';
import { inboxOrderBy } from './inbox-order';
import { transitionSession } from './status-transitions';
import { type CommandLease, logLeaseLost, ownedByLease } from './command-lease';
import { withNextDeliveryAttempt } from './prompt-payload';

/**
 * Put a claimed row back WITHOUT counting the claim as an attempt.
 *
 * `claimDueLifecycleCommands` increments `attempts` on every claim, and
 * `markCommandFailed` dead-letters at 5. An admission refusal is not a failure
 * — the session was simply busy — so a prompt that waits out a long turn must
 * not spend its dead-letter budget doing so. Giving the increment back (floored
 * at 0, because a concurrent writer may already have reset it) is what keeps
 * "waiting" and "failing" different states.
 *
 * The reason is stamped into `result.admission_reason` so `GET /prompts` can
 * say WHY a row is still queued, and `result.admission_refusals` counts them so
 * the next refusal can back off further (`admissionBackoffMs`).
 * `markCommandSucceeded`/`markCommandFailed` both overwrite `result` wholesale,
 * so both markers clear themselves the moment the row stops waiting.
 *
 * `payload.remintOnDelivery` is the SAME fact written where it SURVIVES.
 * `result` is cleared by everything downstream — a retry, a "send now", a
 * success — and one of those clears (`retryInboxPrompt`) happens precisely when
 * the row is about to be delivered, which is when the drain needs to know that
 * the client's wire id has been overtaken by the turn this prompt waited out.
 * Reading a display marker to make a correctness decision is how the id got
 * sent stale; the payload merge (`||`) is the durable half.
 */
export type InboxAdmissionReason = 'older_prompt_pending' | 'turn_active';

/** True when a lease write matched its row; logs the loss otherwise. */
function appliedUnderLease(lease: CommandLease, write: string, rows: unknown[]): boolean {
  if (rows.length > 0) return true;
  logLeaseLost(lease, write);
  return false;
}

/**
 * Put back a REDELIVERY whose already-answered check could not read the
 * transcript. A prompt that was posted before may already have its answer on
 * record; re-sending it blind shows the user the same prompt twice. The row
 * waits and counts the failure; after `MAX_ANSWER_CHECK_FAILURES` (queued-continue.ts)
 * the drain sends it anyway, so an unreadable box cannot strand the prompt.
 */
export async function requeueUnverifiedRedelivery(
  lease: CommandLease,
  availableAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
      availableAt,
      lockedBy: null,
      lockedUntil: null,
      attempts: sql`GREATEST(${sessionLifecycleCommands.attempts} - 1, 0)`,
      result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb)
        || '{"admission_reason": "answer_unverified"}'::jsonb
        || jsonb_build_object('answer_check_failures',
             COALESCE((${sessionLifecycleCommands.result}->>'answer_check_failures')::int, 0) + 1)`,
      updatedAt: new Date(),
    })
    .where(ownedByLease(lease))
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return appliedUnderLease(lease, 'requeueUnverifiedRedelivery', rows);
}

/** How many times a prompt the runtime accepted-but-never-wrote is re-sent
 *  under a fresh key before it is dead-lettered for the user to retry. */
export const MAX_LANDING_RETRIES = 2;

/**
 * Put a prompt whose landing proof FAILED back on the queue — with a fresh
 * attempt number, which is what gives the next POST a fresh
 * `Idempotency-Key` (`${commandId}:r${attempt}`) and, via `remintOnDelivery`,
 * a fresh wire id. Re-POSTing under the SAME key is answered
 * `200 {"deduplicated": true}` by the proxy's 10-minute claim, which
 * `postPrompt` reads as delivered: the exact silent loss the proof exists to
 * stop, arriving 3.6 s later than before (review finding, 2026-09-05).
 *
 * Returns false when the retry budget is spent; the caller dead-letters.
 */
export async function requeueUnlandedPrompt(
  lease: CommandLease,
  reason: string,
  availableAt: Date,
): Promise<{ requeued: boolean; refusals: number }> {
  const rows = await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
      availableAt,
      lockedBy: null,
      lockedUntil: null,
      lastError: reason,
      result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb)
        || jsonb_build_object('landing_refusals',
             COALESCE((${sessionLifecycleCommands.result}->>'landing_refusals')::int, 0) + 1)`,
      payload: withNextDeliveryAttempt(
        sql`${sessionLifecycleCommands.payload} || '{"remintOnDelivery": true}'::jsonb`,
      ),
      updatedAt: new Date(),
    })
    .where(
      and(
        ownedByLease(lease),
        sql`COALESCE((${sessionLifecycleCommands.result}->>'landing_refusals')::int, 0) < ${MAX_LANDING_RETRIES}`,
      ),
    )
    .returning({ result: sessionLifecycleCommands.result });
  const refusals = Number(((rows[0]?.result ?? {}) as { landing_refusals?: unknown }).landing_refusals ?? 0);
  return { requeued: rows.length > 0, refusals };
}

/** Publish delivery only after the worker passes admission. */
export async function markInboxDeliveryStarted(lease: CommandLease): Promise<void> {
  await db.update(sessionLifecycleCommands).set({
    result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb)
      || ${JSON.stringify({ delivery_started_at: new Date().toISOString() })}::jsonb`,
    updatedAt: new Date(),
  }).where(ownedByLease(lease));
}

export async function requeueForAdmission(
  lease: CommandLease,
  reason: InboxAdmissionReason,
  availableAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
      availableAt,
      lockedBy: null,
      lockedUntil: null,
      attempts: sql`GREATEST(${sessionLifecycleCommands.attempts} - 1, 0)`,
      result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb)
        || ${JSON.stringify({ admission_reason: reason })}::jsonb
        || jsonb_build_object('admission_refusals',
             COALESCE((${sessionLifecycleCommands.result}->>'admission_refusals')::int, 0) + 1)`,
      payload: sql`${sessionLifecycleCommands.payload} || '{"remintOnDelivery": true}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(ownedByLease(lease))
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return appliedUnderLease(lease, 'requeueForAdmission', rows);
}

/**
 * Make the session's NEXT queued inbox row due now.
 *
 * Called after the terminal relay or reaper proves the current turn ended.
 * Without it the next row waits out whatever `requeueForAdmission` backoff it
 * accrued while its sibling was active — visible dead air between two messages
 * the user typed one after the other. Only rows the admission gate put back
 * (`admission_reason` set) or plain queued rows; never a HELD row (Stop parked
 * it) and never a row whose `available_at` is a deliberate future schedule
 * without a refusal marker. Returns the promoted row's idempotency key so the
 * caller can drain exactly it.
 */
export async function promoteNextInboxRow(sessionId: string): Promise<string | null> {
  const [next] = await db
    .select({
      commandId: sessionLifecycleCommands.commandId,
      idempotencyKey: sessionLifecycleCommands.idempotencyKey,
    })
    .from(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.sessionId, sessionId),
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        eq(sessionLifecycleCommands.status, 'queued'),
        sql`COALESCE(${sessionLifecycleCommands.result}->>'held', '') <> 'true'`,
        sql`(${sessionLifecycleCommands.result} ? 'admission_reason' OR ${sessionLifecycleCommands.availableAt} <= now())`,
      ),
    )
    .orderBy(...inboxOrderBy())
    .limit(1);
  if (!next) return null;
  await db
    .update(sessionLifecycleCommands)
    .set({ availableAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(sessionLifecycleCommands.commandId, next.commandId),
        eq(sessionLifecycleCommands.status, 'queued'),
      ),
    );
  return next.idempotencyKey ?? null;
}

export async function markCommandQueued(
  commandId: string,
  reason: string | null,
): Promise<void> {
  await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
      result: reason ? { reason } : {},
      availableAt: new Date(),
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(eq(sessionLifecycleCommands.commandId, commandId));
}

export async function markCommandSucceeded(
  lease: CommandLease,
  result: Record<string, unknown>,
  sessionId?: string | null,
): Promise<boolean> {
  const rows = await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'succeeded',
      sessionId: sessionId ?? null,
      result,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(ownedByLease(lease))
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return appliedUnderLease(lease, 'markCommandSucceeded', rows);
}

/**
 * The row went to OpenCode. It is NOT finished.
 *
 * `markCommandSucceeded` used to run here, and "succeeded" was a lie in the one
 * way that matters to the person watching: OpenCode PERSISTS a prompt and
 * queues its execution behind the turn in flight, so between the POST and the
 * turn there is a real interval in which the message exists, belongs to the
 * transcript, and has not run. Closing the row there left the composer with
 * nothing to show for it.
 *
 * So the row stays OPEN — `succeeded` for the drain, which must never re-claim
 * it, and `result.status = 'forwarded'` for every reader that answers the user:
 * `listInboxPrompts` keeps it, `promptState` calls it `delivering`, and only
 * `confirmInboxPromptConsumed` — the `session_turns` ledger naming this exact
 * wire id — closes it.
 *
 * IT ALSO LANDS THE TWO THINGS THAT HAPPENED WHILE THE ROW WAS CLAIMED, both
 * written into the PAYLOAD because this statement replaces `result` wholesale:
 *
 *  - `consumedOnDelivery` — a turn ACCEPTED the message. Acceptance happens
 *    inside the POST (`forwardToSandbox` awaits `acceptSandboxTurn` before it
 *    returns), so `confirmInboxPromptConsumed` reaches this row while the drain
 *    still owns it and cannot close it there. Landing it here is what closes
 *    the row at acceptance instead of at the end of the whole turn.
 *  - `stopPausedOnDelivery` — the user pressed Stop while the row was inside
 *    `continueSession`, which nothing can recall. The delivery comes back
 *    stop-paused instead of unheld. Otherwise the one prompt the user pressed
 *    Stop to get ahead of is the one the hold misses.
 *
 * ACCEPTANCE WINS over the stop mark. A message a turn took is running in the
 * transcript; calling it stop-paused would render it as a parked queue row with
 * a "send now" button, keep it out of the sweep, and let the next release
 * deliver it a SECOND time. Stop cannot unsend a POST — it can only stop what
 * the POST started, and that is the abort's job, not this row's.
 *
 * Both markers are CONSUMED here. Leaving one behind re-lands it on every later
 * delivery of the same row — a freshly re-sent prompt coming back held, with no
 * hold in force.
 */
export async function markCommandForwarded(
  lease: CommandLease,
  sessionId: string,
  wireMessageId: string,
): Promise<boolean> {
  const forwarded = {
    status: 'forwarded',
    forwarded_at: new Date().toISOString(),
    // The id the ledger will key the confirmation on — readable from the
    // row alone, without re-deriving which of the payload's two ids this
    // attempt actually used.
    forwarded_message_id: wireMessageId,
  };
  const rows = await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'succeeded',
      sessionId,
      result: sql`${JSON.stringify(forwarded)}::jsonb || CASE
        WHEN COALESCE(${sessionLifecycleCommands.payload}->>'consumedOnDelivery', '') = 'true'
        THEN '{"status": "delivered"}'::jsonb
        WHEN COALESCE(${sessionLifecycleCommands.payload}->>'stopPausedOnDelivery', '') = 'true'
        THEN '{"stop_paused": true, "held": true}'::jsonb
        ELSE '{}'::jsonb
      END`,
      payload: sql`${sessionLifecycleCommands.payload} - 'consumedOnDelivery' - 'stopPausedOnDelivery'`,
      lockedBy: null,
      lockedUntil: null,
      updatedAt: new Date(),
    })
    .where(ownedByLease(lease))
    .returning({ commandId: sessionLifecycleCommands.commandId });
  return appliedUnderLease(lease, 'markCommandForwarded', rows);
}

export async function markCommandFailed(
  lease: CommandLease,
  error: string,
  opts: {
    retryable: boolean;
    attempts: number;
    sessionId?: string | null;
    result?: Record<string, unknown>;
  },
): Promise<void> {
  const retry = opts.retryable && opts.attempts < 5;
  const [row] = await db
    .update(sessionLifecycleCommands)
    .set({
      status: retry ? 'queued' : 'dead_lettered',
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.result ? { result: opts.result } : {}),
      attempts: opts.attempts,
      availableAt: new Date(Date.now() + Math.min(60_000, 2_000 * Math.max(opts.attempts, 1))),
      lockedBy: null,
      lockedUntil: null,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(ownedByLease(lease))
    .returning();
  if (!row) {
    logLeaseLost(lease, 'markCommandFailed');
    return;
  }
  if (retry) return;

  // Dead-lettered = this command's work is being ABANDONED. That used to be a
  // console.warn deep in the drain — invisible to alerting while the user's
  // session sat "queued — agent picking up" forever. Make it a real error.
  const payload = (row.payload ?? {}) as Record<string, unknown>;
  // Severity follows the CAUSE — see `deadLetterCause`. A terminal
  // customer-state refusal (out of credits, a model the account is not
  // entitled to, a workspace mode its manifest forbids) is not a platform
  // fault and must not page; 96% of prod's dead letters are that, dominated by
  // cron triggers firing into accounts that cannot pay. Everything else keeps
  // the error level it was deliberately given.
  const cause = deadLetterCause(error);
  const log = cause === 'customer_state' ? logger.warn : logger.error;
  log('[session-lifecycle] command dead-lettered — giving up after retries', {
    cause,
    command_id: row.commandId,
    command_type: row.commandType,
    source: row.source,
    project_id: row.projectId,
    account_id: row.accountId,
    session_id: row.sessionId,
    trigger_slug: typeof payload.triggerSlug === 'string' ? payload.triggerSlug : undefined,
    idempotency_key: row.idempotencyKey,
    attempts: opts.attempts,
    error,
  });

  // A prompt the USER typed must never park their session. The park exists so a
  // `session_mode: "reuse"` TRIGGER aims its next fire at a fresh session
  // instead of a wedged one; an inbox prompt has a person watching, a visible
  // failed row, and a retry button, and marking the session `failed` under them
  // takes a working session away over one lost delivery.
  const isInboxPrompt =
    typeof (row.payload as { clientMessageId?: unknown } | null)?.clientMessageId === 'string';
  if (row.commandType === 'continue_session' && row.sessionId && !isInboxPrompt) {
    // Park the target session 'failed': findReusableTriggerSession skips failed
    // sessions, so a `session_mode = "reuse"` trigger's next fire creates a
    // FRESH session instead of re-aiming prompts at a wedged one — the proven
    // lossless self-heal. The `fail` transition re-checks the status and the
    // tombstone in its own UPDATE, so a stale dead-letter cannot clobber a
    // concurrent transition or touch a deleted session.
    try {
      await transitionSession('fail', row.sessionId, {
        error: `prompt delivery dead-lettered: ${error}`.slice(0, 1000),
      });
    } catch (err) {
      console.warn('[session-lifecycle] failed to park session after dead-letter', {
        sessionId: row.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Surface the failure on the trigger runtime row too. markCommandFailed parks
  // the session (above) so the next reuse fire self-heals, but until now it left
  // `projectTriggerRuntime.last_status` frozen at "queued" — the triggers API/UI
  // never showed the dead-letter, so the operator's queue-age alarm was the only
  // (and a misleading) signal. Flip it to "failed" with the error.
  if (typeof payload.triggerSlug === 'string') {
    await markTriggerRuntimeDeliveryFailed({
      projectId: row.projectId,
      slug: payload.triggerSlug,
      when: new Date(),
      error,
    }).catch(() => {});
  }
}

/**
 * How many times a prompt re-attempts delivery into a runtime that was DOWN.
 *
 * Bounded because "the runtime is coming back" is a claim with an expiry date:
 * a box that never returns must eventually hand the user a failed row with a
 * retry button instead of a prompt that is queued for ever.
 */
export const MAX_RUNTIME_UNREACHABLE_RETRIES = 3;

/**
 * Backoff before each re-attempt, indexed by the number of unreachable attempts
 * already spent. Deliberately COARSE: a stopped box comes back when a person
 * opens the session or a wake finishes, which is tens of seconds to minutes —
 * not the 2 s ladder `markCommandFailed` uses for a transient error. The wake
 * itself re-arms the row the instant the runtime is confirmed back
 * (`reArmRuntimeBlockedPrompts`), so this ladder is the FLOOR, not the plan.
 */
const RUNTIME_UNREACHABLE_BACKOFF_MS = [30_000, 120_000, 480_000] as const;

/** Set by {@link parkPromptForUnreachableRuntime} on a row waiting for a box. */
export const RUNTIME_UNREACHABLE_REASON = 'runtime_unreachable';

function runtimeUnreachableRetries(payload: unknown): number {
  const value = (payload as { runtimeUnreachableRetries?: unknown } | null)
    ?.runtimeUnreachableRetries;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/**
 * The runtime was DOWN when this prompt tried to go out. Keep the prompt.
 *
 * Not `markCommandFailed(retryable: true)`, for three reasons the delivery path
 * cannot express through that function:
 *
 *  1. `attempts` is the DEAD-LETTER budget. A box being asleep is not the
 *     prompt failing, so the claim's increment is given back — the same trade
 *     `requeueForAdmission` makes for a prompt that waits out a live turn.
 *     Without it three naps retire a message the runtime never even saw.
 *  2. The backoff is minutes, not seconds. Polling a stopped box every two
 *     seconds finds it stopped.
 *  3. The next attempt must carry a FRESH idempotency key. The proxy claims
 *     `idem:<sandbox>\0<session>\0<key>` for `DEDUPE_TTL_MS` (10 min) on the
 *     POST that just failed, and every backoff step here is inside that window;
 *     re-POSTing under the same key would be answered
 *     `200 {"deduplicated": true}` and the row would be closed having delivered
 *     nothing. `withNextDeliveryAttempt` is exactly the writer-side rule for
 *     "this row went out and is going out again".
 *
 * Returns false when the budget is spent — the caller then dead-letters through
 * `markCommandFailed`, which owns the alerting and the session-park policy.
 */
export async function parkPromptForUnreachableRuntime(
  lease: CommandLease,
  error: string,
  opts: { sessionId?: string | null; now?: Date } = {},
): Promise<{ parked: boolean; retries: number }> {
  const now = opts.now ?? new Date();
  const [current] = await db
    .select({ payload: sessionLifecycleCommands.payload })
    .from(sessionLifecycleCommands)
    .where(eq(sessionLifecycleCommands.commandId, lease.commandId))
    .limit(1);
  if (!current) return { parked: false, retries: 0 };

  const spent = runtimeUnreachableRetries(current.payload);
  if (spent >= MAX_RUNTIME_UNREACHABLE_RETRIES) return { parked: false, retries: spent };
  const retries = spent + 1;
  const backoff =
    RUNTIME_UNREACHABLE_BACKOFF_MS[Math.min(spent, RUNTIME_UNREACHABLE_BACKOFF_MS.length - 1)]!;

  // Carry the Stop through. `stopPausedOnDelivery` means the user pressed Stop
  // while this row was inside `continueSession`; the hold has to survive a park
  // exactly as it survives a forward (`markCommandForwarded`), or the one prompt
  // Stop was meant to catch is the one that slips out on the next re-arm.
  const stopPaused =
    (current.payload as { stopPausedOnDelivery?: unknown } | null)?.stopPausedOnDelivery === 'true' ||
    (current.payload as { stopPausedOnDelivery?: unknown } | null)?.stopPausedOnDelivery === true;

  const result: Record<string, unknown> = {
    delivery_blocked: RUNTIME_UNREACHABLE_REASON,
    runtime_retries: retries,
    ...(stopPaused ? { held: true, stop_paused: true } : {}),
  };

  const [row] = await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      // Give the claim's increment back: see (1) above.
      attempts: sql`GREATEST(${sessionLifecycleCommands.attempts} - 1, 0)`,
      availableAt: new Date(now.getTime() + backoff),
      lockedBy: null,
      lockedUntil: null,
      lastError: error,
      result,
      payload: sql`jsonb_set(
        ${withNextDeliveryAttempt(sql`${sessionLifecycleCommands.payload} - 'stopPausedOnDelivery'`)},
        '{runtimeUnreachableRetries}',
        to_jsonb(${retries}::int))`,
      updatedAt: now,
    })
    .where(ownedByLease(lease))
    .returning({ commandId: sessionLifecycleCommands.commandId });
  if (!row) return { parked: false, retries: spent };

  logger.info('[session-lifecycle] prompt parked — runtime unreachable, will re-attempt', {
    command_id: lease.commandId,
    session_id: opts.sessionId ?? null,
    runtime_retries: retries,
    max_retries: MAX_RUNTIME_UNREACHABLE_RETRIES,
    backoff_ms: backoff,
    error,
  });
  // This prompt is the reason the box must stay up for the next attempt — see
  // promptRetryGraceMs. A no-op for a box the reaper already stopped
  // (extendSandboxDeadline only touches 'active'/'provisioning' rows); that
  // box waits for the ordinary wake-on-retry path instead. Best-effort: losing
  // this write costs the box one grant, never the park itself.
  if (opts.sessionId) {
    await extendSandboxDeadline({ sessionId: opts.sessionId }, promptRetryGraceMs()).catch((err) =>
      logger.warn('[session-lifecycle] failed to extend sandbox deadline for a parked prompt', {
        command_id: lease.commandId,
        session_id: opts.sessionId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }
  return { parked: true, retries };
}

/**
 * The runtime is BACK. Make every prompt this session parked on it due now.
 *
 * Called from the one place that knows a runtime just became reachable again
 * (`recoverTurnsAfterRuntimeRestart`), so the user's message goes out on the
 * wake rather than on the backoff ladder's next rung.
 *
 * HELD rows are left exactly where they are: `held` means the user pressed
 * Stop, and a wake is not consent to send. Only rows this park itself put down
 * (`result.delivery_blocked`) are re-armed — a row queued for any other reason
 * already has its own schedule.
 *
 * Returns the number of rows re-armed.
 */
export async function reArmRuntimeBlockedPrompts(
  sessionId: string,
  now = new Date(),
): Promise<number> {
  const rows = await db
    .update(sessionLifecycleCommands)
    .set({ availableAt: now, updatedAt: now })
    .where(
      and(
        eq(sessionLifecycleCommands.sessionId, sessionId),
        eq(sessionLifecycleCommands.status, 'queued'),
        sql`${sessionLifecycleCommands.result}->>'delivery_blocked' = ${RUNTIME_UNREACHABLE_REASON}`,
        sql`COALESCE(${sessionLifecycleCommands.result}->>'held', 'false') <> 'true'`,
      ),
    )
    .returning({ commandId: sessionLifecycleCommands.commandId });
  if (rows.length > 0) {
    logger.info('[session-lifecycle] runtime back — re-arming prompts parked on it', {
      session_id: sessionId,
      prompts: rows.length,
    });
  }
  return rows.length;
}
