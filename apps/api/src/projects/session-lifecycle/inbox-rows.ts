import { sessionLifecycleCommands } from '@kortix/db';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { qualifiedColumn } from '../../shared/sql-qualified-column';
import { LIFECYCLE_CLAIM_LOCK_MS } from './command-lease';
import { compareInboxSendOrder, inboxOrderBy } from './inbox-order';
import { type EnqueuedContinueSessionCommand, type SessionLifecycleCommandRow, withNextDeliveryAttempt } from './store';
import { forwardedSql, heldSql, isStopPaused, notHeldSql, stopPausedOnDeliverySql, stopPausedSql, stoppedByUserSql } from './delivery-state';

/**
 * The inbox's row operations — everything `GET/DELETE/retry/hold …/prompts`
 * does to `kortix.session_lifecycle_commands`.
 *
 * They live here rather than inline in `routes/session-prompts.ts` for one reason: every one
 * of them has to carry the INBOX SCOPE, and a scope that is re-typed at four
 * call sites is a scope that will be forgotten at one of them. It already was:
 * `continue_session` is also how triggers, Slack and approval-resume deliver,
 * and those rows have no `clientMessageId`. Listing them put an automation's
 * internal prompt in the user's composer queue, and the row's remove button
 * destroyed a scheduled delivery the user never made.
 */

/** A `continue_session` row the USER created through the composer. */
export function inboxScope(sessionId: string) {
  return and(
    eq(sessionLifecycleCommands.sessionId, sessionId),
    eq(sessionLifecycleCommands.commandType, 'continue_session'),
    // THE inbox predicate. Only the prompt routes write `clientMessageId`;
    // every automation producer leaves it absent.
    isNotNull(sql`${sessionLifecycleCommands.payload}->>'clientMessageId'`),
  );
}

/**
 * How long a HELD prompt stays out of the drain's way.
 *
 * A hold is released by an action, never by this timer — the user sending
 * anything new, or pressing "send now" on a row. The drain never claims a held
 * inbox prompt (`claimDueLifecycleCommands`), so for those this is only the
 * row's due time once the hold is lifted. A held AUTOMATION row (no
 * `clientMessageId`) is delivered when this horizon passes.
 */
export const INBOX_HOLD_MS = 24 * 60 * 60 * 1000;

/** Is this row on the wire at OpenCode, waiting for a turn to consume it?
 *  See `markCommandForwarded` for why that is not the same as finished. */
export function isForwardedInboxRow(result: unknown): boolean {
  return (result as { status?: unknown } | null)?.status === 'forwarded';
}

export async function listInboxPrompts(
  sessionId: string,
  limit: number,
): Promise<SessionLifecycleCommandRow[]> {
  // `succeeded` is EXCLUDED, not filtered by the caller: a delivered prompt is
  // in the transcript, and listing it would render it twice.
  //
  // With ONE exception, and it is the whole point of `markCommandForwarded`: a
  // FORWARDED row is `succeeded` for the drain — nothing may re-claim it — and
  // still unanswered for the user. It stays listed (as `delivering`) until the
  // ledger confirms a turn consumed its wire id.
  return db
    .select()
    .from(sessionLifecycleCommands)
    .where(
      and(
        inboxScope(sessionId),
        or(
          ne(sessionLifecycleCommands.status, 'succeeded'),
          forwardedSql,
        ),
      ),
    )
    .orderBy(...inboxOrderBy())
    .limit(limit);
}

export type InboxPromptDeletion =
  /** Carries the row it removed: the DELETE is the only place the full prompt
   *  body still exists, and the client's undo has to re-create it exactly. */
  | { outcome: 'deleted'; row: SessionLifecycleCommandRow }
  | { outcome: 'delivering' }
  | { outcome: 'missing' };

export async function deleteInboxRowsWithAttachmentGrace(predicate: SQL | undefined) {
  return db.transaction(async (tx) => {
    const rows = await tx.delete(sessionLifecycleCommands).where(predicate).returning();
    for (const row of rows) {
      if ((row.payload.parts as Array<{ attachment_id?: string }> | undefined)?.some((part) => part.attachment_id)) {
        const { retainPromptAttachmentsForUndo } = await import('../prompt-attachments');
        await retainPromptAttachmentsForUndo(tx, row);
      }
    }
    return rows;
  });
}

export async function deleteInboxPrompt(
  sessionId: string,
  promptId: string,
): Promise<InboxPromptDeletion> {
  const deleted = await deleteInboxRowsWithAttachmentGrace(
      and(
        eq(sessionLifecycleCommands.commandId, promptId),
        inboxScope(sessionId),
        inArray(sessionLifecycleCommands.status, ['queued', 'failed', 'dead_lettered']),
      ),
    );
  if (deleted[0]) return { outcome: 'deleted', row: deleted[0] };

  // A STOP-PAUSED row is the user's to remove, and a separate statement so the
  // predicate above stays one readable status list.
  //
  // It is forwarded, so the fall-through below would call it `delivering` and
  // answer 409 — on a row the strip renders as a held queue row with a remove
  // button. Nothing is going to deliver it (the hold is what took it out of the
  // drain's way) and only removing it takes it off the user's screen, so a
  // refusal there is a control that cannot work.
  const stopPaused = await deleteInboxRowsWithAttachmentGrace(
      and(
        eq(sessionLifecycleCommands.commandId, promptId),
        inboxScope(sessionId),
        eq(sessionLifecycleCommands.status, 'succeeded'),
        stopPausedSql,
      ),
    );
  if (stopPaused[0]) return { outcome: 'deleted', row: stopPaused[0] };

  return inboxRowNotTaken(sessionId, promptId);
}

/**
 * Why a write that names a waiting row matched nothing: the row is on the
 * wire (`delivering`, a 409 — changing it would be a lie about what the
 * session is answering) or it is not this session's to change (`missing`).
 */
async function inboxRowNotTaken(
  sessionId: string,
  promptId: string,
): Promise<{ outcome: 'delivering' } | { outcome: 'missing' }> {
  // Separate the two "no row was taken" cases: a row that is on the wire
  // cannot be changed without lying about it, which is a 409, not a 404.
  //
  // TWO shapes are on the wire, for the same reason: a `running` row is inside
  // `continueSession`, and a FORWARDED row has already reached OpenCode, which
  // has persisted the user message. Removing either would delete the inbox's
  // record of a message the session is going to answer.
  const [existing] = await db
    .select({
      status: sessionLifecycleCommands.status,
      result: sessionLifecycleCommands.result,
    })
    .from(sessionLifecycleCommands)
    .where(and(eq(sessionLifecycleCommands.commandId, promptId), inboxScope(sessionId)))
    .limit(1);
  if (!existing) return { outcome: 'missing' };
  if (existing.status === 'running') return { outcome: 'delivering' };
  // Forwarded, or confirmed `delivered` on persistence (the daemon's
  // acceptance relay — which fires long before a model step reads the
  // message): both are "on the wire", and the DELETE route's cancel arm
  // decides from the transcript whether the prompt can still come back.
  const status = (existing.result as { status?: unknown } | null)?.status;
  return isForwardedInboxRow(existing.result) || status === 'delivered'
    ? { outcome: 'delivering' }
    : { outcome: 'missing' };
}

export type InboxPromptEdit =
  | { outcome: 'edited'; row: SessionLifecycleCommandRow }
  | { outcome: 'delivering' }
  | { outcome: 'missing' };

/**
 * Replace the text of a row that is still waiting — the queue list's edit.
 *
 * In place, and nothing else moves: the row keeps its id, its wire id, its
 * send time (its place in the queue), its file parts and any hold. That is
 * the whole point. A remove + re-send is a SEND — it releases a Stop hold
 * and is admitted at once on an idle session — and the user asked to change
 * a queued message, not to send it.
 *
 * The text parts collapse into one part carrying the new text, ahead of the
 * files; `text` is the flattened copy every reader of the row shows.
 */
export async function editInboxPrompt(
  sessionId: string,
  promptId: string,
  text: string,
): Promise<InboxPromptEdit> {
  const [row] = await db
    .update(sessionLifecycleCommands)
    .set({
      payload: sql`jsonb_set(
        jsonb_set(${qualifiedColumn(sessionLifecycleCommands.payload)}, '{text}', to_jsonb(${text}::text)),
        '{parts}',
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', ${text}::text)) || COALESCE(
          (SELECT jsonb_agg(part ORDER BY position)
             FROM jsonb_array_elements(COALESCE(${qualifiedColumn(sessionLifecycleCommands.payload)}->'parts', '[]'::jsonb))
                  WITH ORDINALITY AS parts(part, position)
            WHERE COALESCE(part->>'type', 'text') <> 'text'),
          '[]'::jsonb))`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionLifecycleCommands.commandId, promptId),
        inboxScope(sessionId),
        inArray(sessionLifecycleCommands.status, ['queued', 'failed', 'dead_lettered']),
      ),
    )
    .returning();
  if (row) return { outcome: 'edited', row };
  return inboxRowNotTaken(sessionId, promptId);
}

/**
 * "Stop and send" on a waiting row (R10): it becomes a Quick Queue row —
 * `delivery: 'interrupt'`, `placement: 'transcript'` — promoted and due now,
 * so admission arms the interrupt of the running turn. Only a `queued` row:
 * a claimed or forwarded row is already on its way (`delivering`, a 409). A
 * Stop hold stays on the row; the next send releases it.
 */
export async function interruptInboxPrompt(sessionId: string, promptId: string): Promise<InboxPromptEdit> {
  const [row] = await db
    .update(sessionLifecycleCommands)
    .set({
      payload: sql`${sessionLifecycleCommands.payload} || '{"delivery": "interrupt", "placement": "transcript", "remintOnDelivery": true}'::jsonb`,
      result: sql`(COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb) - 'admission_reason' - 'admission_refusals') || '{"promoted": true}'::jsonb`,
      availableAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionLifecycleCommands.commandId, promptId),
        inboxScope(sessionId),
        eq(sessionLifecycleCommands.status, 'queued'),
      ),
    )
    .returning();
  if (row) return { outcome: 'edited', row };
  // Any other state of an existing row (claimed, on the wire, failed) is a 409.
  const [existing] = await db
    .select({ commandId: sessionLifecycleCommands.commandId })
    .from(sessionLifecycleCommands)
    .where(and(eq(sessionLifecycleCommands.commandId, promptId), inboxScope(sessionId)))
    .limit(1);
  return existing ? { outcome: 'delivering' } : { outcome: 'missing' };
}

/**
 * Put one row at the front of the queue and make it due NOW.
 *
 * This is both "retry" and "send now" — one primitive, because they are one
 * intent: the user pointed at a row and asked for THAT message. `promoted`
 * is what the admission gate reads to let it past the ordering rule
 * (`older_prompt_pending`). An in-flight sibling still binds a promoted row
 * because two concurrent network deliveries can reverse their arrival order.
 *
 * THE BATCH CASE (KRTX-683): when OTHER rows of the session are held by Stop,
 * "send now" is a Stop release. The hold is released FIRST, the row joins the
 * released batch, and it is NOT promoted: the batch goes out in queue order
 * and is answered in one turn.
 *
 * `payload.remintOnDelivery` is stamped because this row did NOT go out on its
 * first claim: whatever the session did in the meantime has written HIGHER wire
 * ids, and OpenCode reads a lower one as already answered. It goes in the
 * PAYLOAD, which is merged, precisely because `result` below is replaced —
 * putting the fact in `result` is what let "send now" deliver a stale id. The
 * drain re-reads the transcript before it re-mints and drops the delivery if
 * the prompt turns out to have been answered, so this cannot double-run.
 */
export async function retryInboxPrompt(
  sessionId: string,
  promptId: string,
): Promise<SessionLifecycleCommandRow | null> {
  // "Send now" out of a Stop that holds OTHER rows is a RELEASE, and a released
  // batch is answered in ONE turn, in queue order (KRTX-683). So that row is
  // not `promoted`: promoted, it passed the order gate ahead of the older rows
  // of its own batch, found no later sibling, and started a turn alone — the
  // older rows then became a second turn, answered after it. Unpromoted, the
  // batch's head goes first and the chain carries this row.
  //
  // And the release runs FIRST. The write below makes this row due, and the 1 s
  // tick can claim it the same instant: the batch has to be released and
  // stamped by then, or the row goes out alone ahead of rows still held.
  const [otherHeld] = await db
    .select({ commandId: sessionLifecycleCommands.commandId })
    .from(sessionLifecycleCommands)
    .where(and(inboxScope(sessionId), ne(sessionLifecycleCommands.commandId, promptId), holdMarked()))
    .limit(1);
  const releasesBatch = !!otherHeld;
  if (releasesBatch) await releaseInboxHold(sessionId);
  const promote = {
    status: 'queued' as const,
    availableAt: new Date(),
    attempts: 0,
    lastError: null,
    lockedBy: null,
    lockedUntil: null,
    // Wholesale: this clears `admission_reason`, `admission_refusals` and
    // `held` along with the previous failure, which is exactly what "send
    // this one now" means for what the row DISPLAYS.
    result: releasesBatch ? {} : { promoted: true },
    payload: sql`${sessionLifecycleCommands.payload} || '{"remintOnDelivery": true}'::jsonb`,
    updatedAt: new Date(),
  };
  const [row] = await db
    .update(sessionLifecycleCommands)
    .set(promote)
    .where(
      and(
        eq(sessionLifecycleCommands.commandId, promptId),
        inboxScope(sessionId),
        // `running` is excluded: it is already on the wire.
        inArray(sessionLifecycleCommands.status, ['queued', 'failed', 'dead_lettered']),
      ),
    )
    .returning();
  // A STOP-PAUSED row takes the same promotion, from a `succeeded` status the
  // list above cannot name. It is the row the hold is RENDERED on — "send now"
  // is the hold's advertised way out — and refusing it answered 404 under a
  // paper plane the strip only shows because the queue is paused. Worse, the
  // 404 short-circuits `handleQueueSendNow` before its release, so the whole
  // queue stayed held. Same statement, so the row still leaves as `promoted`
  // and re-minted.
  const stopPaused = row
    ? []
    : await db
        .update(sessionLifecycleCommands)
        .set({
          ...promote,
          // This row HAS been POSTed — that is what `stop_paused` means — so
          // the re-POST needs a key the proxy's 10-minute dedupe claim cannot
          // swallow. Without it "send now" is answered `duplicate`, marked
          // forwarded, and force-closed ten minutes later, never having run.
          // The arm above does not need it: those statuses never reached the
          // wire under this row's key.
          payload: withNextDeliveryAttempt(
            sql`${sessionLifecycleCommands.payload} || '{"remintOnDelivery": true}'::jsonb`,
          ),
        })
        .where(
          and(
            eq(sessionLifecycleCommands.commandId, promptId),
            inboxScope(sessionId),
            eq(sessionLifecycleCommands.status, 'succeeded'),
            stopPausedSql,
          ),
        )
        .returning();
  const sent = row ?? stopPaused[0];
  if (!sent) {
    if (!releasesBatch) return null;
    // Released and made due above, then claimed by a drain before the write:
    // it is already on its way, in batch order.
    const [claimed] = await db
      .select()
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, promptId),
          inboxScope(sessionId),
          eq(sessionLifecycleCommands.status, 'running'),
        ),
      )
      .limit(1);
    return (claimed as SessionLifecycleCommandRow | undefined) ?? null;
  }
  // The same rule the browser queue always had: an explicit dispatch lifts the
  // hold for the WHOLE queue, and the rest drains at the next boundary. With
  // no other row held this clears only this row's own marks.
  if (!releasesBatch) await releaseInboxHold(sessionId);
  return sent;
}

/**
 * Hold — or release — every prompt of one session that Stop is about.
 *
 * The Stop button's promise is "stop doing things, and that includes the
 * queue". With the queue in Postgres that promise has to be written there too:
 * pausing a browser-local drain leaves the server free to admit the prompt the
 * user pressed Stop to get ahead of, roughly one scheduler tick later.
 *
 * THREE sets of rows, because a prompt can now be at OpenCode without having run:
 *
 *  - QUEUED rows are pushed out of the drain's way, as they always were.
 *  - RUNNING rows are inside `continueSession` and cannot be recalled — nothing
 *    can unsend a POST. They are marked in the PAYLOAD instead, and
 *    `markCommandForwarded` turns that mark into a stop-paused forwarded row
 *    when the delivery lands. Without it the one prompt the user pressed Stop
 *    to get ahead of is the one that escapes the hold entirely: the claim
 *    window is the whole of `continueSession`, up to READY_DEADLINE_MS (5 min)
 *    on a cold box.
 *
 *    UNLESS THE POST WAS ACCEPTED. A turn that took the message is running it,
 *    and `markCommandForwarded` closes such a row `delivered` rather than
 *    stop-paused — see there. Calling it stopped would render a streaming
 *    message as a parked queue row and let the next release run it a second
 *    time. What is left is honest and narrow: Stop pressed inside the ~100ms
 *    between the claim and the POST (a live turn means an awake box) can leave
 *    that one prompt running, and the user presses Stop again.
 *  - FORWARDED rows are STOP-PAUSED. Stop aborts the running turn and OpenCode
 *    drops its in-memory queue with it, so a forwarded prompt loses the turn
 *    that was going to run it; the reaper then observes a persisted message
 *    with nothing answering it and hands it back (`requeueAbandonedPrompt`) —
 *    which would deliver, DUE NOW, the very prompt the user just stopped. The
 *    marker is what makes that repair come back HELD instead.
 *
 * While the hold stands, a stop-paused row stays `succeeded` — visible as
 * `waiting`/`held`, and never re-delivered. RELEASING it puts it back on the
 * queue; see the release branch below for why that is not left to the reaper.
 *
 * KNOWN COST, and it is the price of stopping a prompt that already reached
 * OpenCode: a released row re-delivers under a RE-MINTED wire id
 * (`remintOnDelivery`), while OpenCode still holds the original persisted user
 * message with no assistant child. The transcript then shows that prompt twice
 * — once unanswered, once answered. The drain's already-answered guard cannot
 * suppress the duplicate, precisely because nothing ever answered the original.
 */
export async function holdInboxPrompts(sessionId: string, held: boolean): Promise<number> {
  if (held) {
    const queued = await db
      .update(sessionLifecycleCommands)
      .set({
        availableAt: new Date(Date.now() + INBOX_HOLD_MS),
        result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb) || '{"held": true}'::jsonb`,
        // A held row is by definition one that did not go out on its first
        // claim — see `retryInboxPrompt` for why this lives in the payload.
        payload: sql`${sessionLifecycleCommands.payload} || '{"remintOnDelivery": true}'::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(inboxScope(sessionId), eq(sessionLifecycleCommands.status, 'queued')))
      .returning({ commandId: sessionLifecycleCommands.commandId });

    const forwarded = await db
      .update(sessionLifecycleCommands)
      .set({
        // `stop_paused` is its OWN key, beside `held`, rather than a value of
        // `result.status`: the row is still forwarded — OpenCode holds that
        // message — and every reader of "is this row on the wire"
        // (`isForwardedInboxRow`, the confirmation, the sweep) must keep saying
        // yes. What changed is only who is waiting on it: the user.
        result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb) || '{"stop_paused": true, "held": true}'::jsonb`,
        payload: sql`${sessionLifecycleCommands.payload} || '{"remintOnDelivery": true}'::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          inboxScope(sessionId),
          eq(sessionLifecycleCommands.status, 'succeeded'),
          forwardedSql,
        ),
      )
      .returning({ commandId: sessionLifecycleCommands.commandId });

    // A row the drain has already CLAIMED. `result` is replaced wholesale by
    // `markCommandForwarded` when the delivery lands, so the mark has to live
    // in the PAYLOAD, which is merged — the same asymmetry `remintOnDelivery`
    // is written for.
    const running = await db
      .update(sessionLifecycleCommands)
      .set({
        result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb) || '{"held": true}'::jsonb`,
        payload: sql`${sessionLifecycleCommands.payload} || '{"stopPausedOnDelivery": true, "remintOnDelivery": true}'::jsonb`,
        updatedAt: new Date(),
      })
      .where(and(inboxScope(sessionId), eq(sessionLifecycleCommands.status, 'running')))
      .returning({ commandId: sessionLifecycleCommands.commandId });

    return queued.length + forwarded.length + running.length;
  }

  // ONE TRANSACTION. Each statement below makes rows due, and the stamp at the
  // end is what marks them one batch (KRTX-683). Committed one at a time, a
  // drain could claim a released row in between — due, un-held, unstamped —
  // and send it as a turn of its own, splitting the batch in two. The 1 s tick
  // makes that window real wherever the database is a region away.
  return db.transaction(async (tx) => {
    // FIRST, so nothing below can be undone by it: a delivery that lands after
    // this clear is an ordinary forwarded row (the user released the hold), and
    // one that landed before it is stop-paused and caught by the requeue arm at
    // the end. The other order leaves a row marked by a hold that is over.
    //
    // EVERY status, not just `running`. The mark belongs to ONE delivery, and
    // `markCommandForwarded` consumes it when that delivery lands — but a
    // delivery that FAILS instead requeues the row with the mark still on it, and
    // the hold that wrote it is over. Left behind, it comes back as a stop-paused
    // row on a prompt nothing stopped: invisible to the sweep, and outside
    // `countLiveInboxPrompts`.
    await tx
      .update(sessionLifecycleCommands)
      .set({
        payload: sql`${sessionLifecycleCommands.payload} - 'stopPausedOnDelivery'`,
        updatedAt: new Date(),
      })
      .where(
        and(
          inboxScope(sessionId),
          stopPausedOnDeliverySql,
        ),
      );

    const released = await tx
      .update(sessionLifecycleCommands)
      .set({
        availableAt: new Date(),
        result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb) - 'held'`,
        updatedAt: new Date(),
      })
      .where(
        and(
          inboxScope(sessionId),
          inArray(sessionLifecycleCommands.status, ['queued', 'running']),
          heldSql,
        ),
      )
      .returning({ commandId: sessionLifecycleCommands.commandId });

    // A STOP-PAUSED row goes back ON THE QUEUE, not back to `forwarded`.
    //
    // MEASURED, against a real sandbox: after Stop the reaper does NOT reliably
    // hand a forwarded prompt back. Its redelivery needs the daemon to report the
    // prompt ORPHANED, and a stopped session usually does not look like that —
    // the aborted turn leaves an assistant husk, and a shell tool the abort did
    // not kill keeps the root busy, so two full reaper passes renewed the turns
    // and requeued nothing. Leaving the row `forwarded` therefore left the user's
    // released prompt in `delivering` until the sweep force-closed it: never run,
    // then silently gone.
    //
    // Re-queueing is safe because the drain re-reads the transcript before it
    // re-mints (`remintOnDelivery` was stamped by the hold above): a prompt that
    // turns out to have been ANSWERED after all is dropped by the already-answered
    // guard, and one that was not is sent again. So the outcome is decided by the
    // transcript rather than by reaper cadence.
    //
    // What it does NOT undo is the duplicate documented above: OpenCode still
    // holds the original persisted user message, unanswered, so the transcript
    // shows the prompt twice.
    //
    // STILL FORWARDED is half the predicate, and it is load-bearing. Stop marks
    // the row and then aborts, and the turn in front of it can end inside that
    // window — OpenCode runs the prompt, `confirmInboxPromptConsumed` closes the
    // row `delivered`, and the marker alone would put a message that was already
    // answered back on the queue. The only thing left between that and a second
    // real LLM turn is the drain's already-answered guard, which fails OPEN on an
    // unreadable box. `forwarded` is what "OpenCode is still holding this,
    // unanswered" means.
    const requeued = await tx
      .update(sessionLifecycleCommands)
      .set({
        status: 'queued',
        availableAt: new Date(),
        // A fresh delivery budget: nothing has failed to answer this prompt — a
        // person stopped it.
        attempts: 0,
        lockedBy: null,
        lockedUntil: null,
        result: {},
        // And a FRESH IDEMPOTENCY KEY, which the budget above does not buy. This
        // row already went out once, and the proxy's dedupe claim on that key
        // lives for 10 minutes: re-POSTing under it is answered
        // `200 {"deduplicated": true}`, which `postPrompt` reads as delivered.
        // The released prompt would never reach OpenCode, and would be
        // force-closed ten minutes later with no error. See
        // `withNextDeliveryAttempt`.
        payload: withNextDeliveryAttempt(sql`${sessionLifecycleCommands.payload}`),
        updatedAt: new Date(),
      })
      .where(
        and(
          inboxScope(sessionId),
          eq(sessionLifecycleCommands.status, 'succeeded'),
          forwardedSql,
          stopPausedSql,
        ),
      )
      .returning({ commandId: sessionLifecycleCommands.commandId });

    // Everything the release just made due is ONE batch: OpenCode gets each
    // prompt as its own user message and answers them together in one turn
    // (`noReply` on all but the last — see `executeQueuedContinue`). The stamp
    // covers every queued, un-held row rather than only the rows released above:
    // a send that was already queued and due when the release ran (not held,
    // so not among `released`) belongs to the batch too. The `POST .../prompts`
    // send itself is enqueued held by `enqueueReleasingHold`, so it IS among
    // `released`; as the newest row it is the one that carries the one turn.
    if (released.length + requeued.length > 0) {
      await tx
        .update(sessionLifecycleCommands)
        .set({
          // `releasedFromHold` records which rows the Stop held: they carry
          // the hold's `remintOnDelivery`, and the send that released them
          // does not. Every batch row re-mints its wire id at delivery anyway
          // (`placeQueuedContinue`), so the ids ascend in delivery order.
          payload: sql`${sessionLifecycleCommands.payload} || jsonb_build_object(
            'releasedBatchId', ${randomUUID()}::text,
            'releasedFromHold', COALESCE(${sessionLifecycleCommands.payload}->>'remintOnDelivery', '') = 'true'
          )`,
          updatedAt: new Date(),
        })
        .where(
          and(
            inboxScope(sessionId),
            eq(sessionLifecycleCommands.status, 'queued'),
            notHeldSql,
          ),
        );
    }

    return released.length + requeued.length;
  });
}

/** A row a Stop marked: held, stop-paused, or claimed with a pending stop mark. */
function holdMarked(): SQL {
  return stoppedByUserSql;
}

/**
 * Does anything of this session carry a Stop mark? One read of the union of
 * the release's predicates: without a Stop its UPDATEs match no rows at all.
 */
export async function sessionHasHoldMark(sessionId: string): Promise<boolean> {
  const [marked] = await db
    .select({ commandId: sessionLifecycleCommands.commandId })
    .from(sessionLifecycleCommands)
    .where(and(inboxScope(sessionId), holdMarked()))
    .limit(1);
  return !!marked;
}

/**
 * What a new send has to know about its session's inbox, in one read.
 * `held` answers what `sessionHasHoldMark` answers.
 *
 * `held`: a Stop mark is in force, so the send releases it (see
 * `enqueueReleasingHold`). `pending`: another prompt is queued or in delivery,
 * so this send may be one of a burst and its drain collects the stragglers
 * (see `drainSessionLifecycleQueue`).
 */
export async function inboxSendState(sessionId: string): Promise<{ held: boolean; pending: boolean }> {
  const [row] = await db
    .select({
      held: sql<boolean>`COALESCE(bool_or(${holdMarked()}), false)`,
      pending: sql<boolean>`COALESCE(bool_or(${sessionLifecycleCommands.status} IN ('queued', 'running')), false)`,
    })
    .from(sessionLifecycleCommands)
    .where(inboxScope(sessionId));
  return { held: row?.held === true, pending: row?.pending === true };
}

/**
 * Release without asserting anything about whether a hold was set.
 *
 * Without a Stop the release's ordered UPDATEs match no rows at all — round
 * trips to change nothing — so one read (`sessionHasHoldMark`) decides whether
 * they run. When something IS held they run, in their original order.
 */
export async function releaseInboxHold(sessionId: string): Promise<number> {
  if (!(await sessionHasHoldMark(sessionId))) return 0;
  return holdInboxPrompts(sessionId, false);
}

/** What a send enqueued into a held session carries — see `enqueueReleasingHold`. */
export interface HoldOnEnqueue {
  held: true;
  availableAt: Date;
}

/**
 * Enqueue a NEW send, and lift the Stop hold it releases (`POST .../prompts`).
 *
 * Sending anything new lifts a hold the stop button left on the session's
 * queue — the same rule the browser-local queue always had, and the reason
 * Stop cannot wedge a session. The send joins the released batch (KRTX-683),
 * so while a hold is in force it is enqueued HELD and made due by the release
 * transaction, together with the stamp. Enqueued due instead, the 1 s tick
 * could claim it before the release: `running`, the stamp skipped it,
 * admission ignored the still-held rows, and it started a turn alone ahead of
 * them. With no hold the send is enqueued due and nothing else is written.
 *
 * `enqueue` is the caller's own enqueue, given the hold fields to spread. The
 * returned row is the send as the release left it (`result` without `held`).
 */
export async function enqueueReleasingHold(
  sessionId: string,
  enqueue: (hold: HoldOnEnqueue | null) => Promise<EnqueuedContinueSessionCommand>,
  release: (sessionId: string) => Promise<unknown> = (id) => holdInboxPrompts(id, false),
  /** The hold read, when the caller already started it (`inboxSendState`). */
  held: Promise<boolean> = sessionHasHoldMark(sessionId),
): Promise<EnqueuedContinueSessionCommand> {
  // The read failing is treated as "no hold": the send still goes in, due.
  if (!(await held.catch(() => false))) return enqueue(null);
  const enqueued = await enqueue({ held: true, availableAt: new Date(Date.now() + INBOX_HOLD_MS) });
  // A repeat POST of a send already in the inbox changes nothing — unless the
  // first one's release failed and left that send held: the retry releases.
  if (enqueued.deduped && (enqueued.row.result as { held?: unknown } | null)?.held !== true) return enqueued;
  try {
    await release(sessionId);
  } catch (error) {
    // The release rolled back: the Stop's rows stay held, as before this send.
    // The send itself must not: the web client reads a held row as landed and
    // never re-POSTs, so it would wait out the 24 h horizon unseen. Make it due
    // on its own. It loses the batch, not the prompt.
    logger.warn('[inbox] hold release failed; the send is delivered alone', {
      session_id: sessionId,
      command_id: enqueued.row.commandId,
      error: error instanceof Error ? error.message : String(error),
    });
    await db
      .update(sessionLifecycleCommands)
      .set({
        result: sql`${sessionLifecycleCommands.result} - 'held'`,
        availableAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, enqueued.row.commandId),
          eq(sessionLifecycleCommands.status, 'queued'),
        ),
      );
  }
  return { ...enqueued, row: { ...enqueued.row, result: {}, availableAt: new Date() } };
}

/** Was this row's delivery stopped by the user AFTER it reached OpenCode?
 *  `requeueAbandonedPrompt` reads it to bring the repair back HELD. */
export function isStopPausedInboxRow(result: unknown): boolean {
  return isStopPaused(result as Record<string, unknown> | null);
}

/**
 * Claim every DUE queued inbox prompt of one session — the siblings a targeted
 * drain sweeps into its delivery batch (see `drainSessionLifecycleQueue`).
 * Only rows with a `clientMessageId` (the composer's own submissions); an
 * admission-backoff row is due later and is left to its backoff.
 */
export async function claimDueSessionInboxSiblings(input: {
  workerId: string;
  sessionId: string;
  now?: Date;
  limit?: number;
}): Promise<SessionLifecycleCommandRow[]> {
  const now = input.now ?? new Date();
  // One statement, as `claimDueLifecycleCommands`: lock, skip, update.
  const due = db
    .select({ commandId: sessionLifecycleCommands.commandId })
    .from(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.sessionId, input.sessionId),
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        eq(sessionLifecycleCommands.status, 'queued'),
        sql`${sessionLifecycleCommands.payload}->>'clientMessageId' IS NOT NULL`,
        notHeldSql,
        or(
          isNull(sessionLifecycleCommands.lockedUntil),
          lte(sessionLifecycleCommands.lockedUntil, now),
        ),
        // NOT gated on availableAt: this sweep only runs while a delivery for
        // this session is in hand, and a backoff written when the box was
        // still booting (every attempt during a cold boot fails 'pending')
        // is stale the moment one delivery gets through. Leaving those rows
        // to their own timers is what split a boot burst into stragglers
        // (measured: B1 redelivered minutes after B2–B4). Admission-refused
        // rows are ordered by the batch itself; held rows stay excluded.
      ),
    )
    .orderBy(...inboxOrderBy())
    .limit(input.limit ?? 20)
    .for('update', { skipLocked: true });
  const claimed = await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'running',
      attempts: sql`${sessionLifecycleCommands.attempts} + 1`,
      lockedBy: input.workerId,
      lockedUntil: new Date(now.getTime() + LIFECYCLE_CLAIM_LOCK_MS),
      updatedAt: now,
    })
    .where(sql`${sessionLifecycleCommands.commandId} = ANY(ARRAY(${due}))`)
    .returning();
  return (claimed as SessionLifecycleCommandRow[]).sort(compareInboxSendOrder);
}
