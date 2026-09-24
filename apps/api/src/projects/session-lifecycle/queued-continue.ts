/**
 * Drain one queued `continue_session` row: admission, the staged-revert and
 * already-answered guards, wire-id placement, delivery, and the row's outcome.
 */

import * as lifecycleStore from './store';
import { PromptDeliveryRefused } from './prompt-delivery-refusal';
import {
  assertInboxDeliveryActive,
  InboxDeliveryPaused,
  releasePausedInboxDelivery,
} from './inbox-delivery-hold';
import { connectorCalls } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { markTriggerRuntimeDelivered } from '../trigger-execution-store';
import {
  MAX_RUNTIME_UNREACHABLE_RETRIES,
  type SessionLifecycleCommandRow,
  markCommandFailed,
  parkPromptForUnreachableRuntime,
  markCommandForwarded,
  requeueUnlandedPrompt,
  markCommandSucceeded,
  requeueForAdmission,
  type QueuedContinueSessionPayload,
} from './store';
import {
  DELIVERY_FAILURE_COPY,
  type SessionDeliveryOutcome,
  type SessionInvocationSource,
} from './types';
import { admitInboxPrompt, sessionHoldsLiveTurn } from './inbox-admission';
import { openUserAbove } from './forwarded-placement';
import {
  armQuickQueueInterrupt,
  queuedContinueHasStagedRevert,
  readInboxTranscriptState,
  removeStrandedOpencodeMessage,
} from './runtime-client';
import {
  MAX_LIVE_PLACEMENT_REPAIRS,
  hasLaterForwardedSibling,
  remintForRepair,
  remintWireMessageId,
  verifyLivePlacement,
} from './inbox-placement';
import { continueSession } from './continue-session';
import { drainSessionLifecycleQueue } from './drain';

/** Pause before re-sending a prompt the runtime accepted but never wrote. */
const NOT_LANDED_RETRY_DELAY_MS = 2_000;

/** First wait before re-checking an unreadable redelivery; doubles per failure. */
const ANSWER_CHECK_RETRY_BASE_MS = 5_000;
/** How many redelivery answered-checks may fail before the prompt is sent anyway. */
const MAX_ANSWER_CHECK_FAILURES = 3;

/**
 * Drain one queued `continue_session` command — the durable face of "deliver
 * this follow-up into the session" (today: the approval-resume backstop). The
 * consumed-marker check runs at DRAIN time, not enqueue time, so a live held
 * request that picked the decision up during the grace window cleanly turns
 * this into a no-op instead of a duplicate prompt.
 *
 * T13 — no-blind-repost on a retryable ('pending') delivery: below,
 * `retryable = delivery === 'pending'` re-queues this SAME row, and a later
 * drain calls `continueSession` again with the identical `sessionId`/`text` —
 * so a delivery that actually reached opencode but was reported ambiguous
 * (network reset after the daemon accepted it, a timed-out response read)
 * must not re-POST blind on the next pass.
 *
 * This module does not re-check that itself — a cheap authoritative read
 * (list opencode's messages by id, or ask the daemon "did you see this one?")
 * is not available here without another round trip per retry. Instead the
 * guarantee is carried by `postPrompt`'s own transport: it POSTs through
 * `forwardToSandbox`, which is the SAME proxy path the SDK's browser/CLI
 * sends run through, and that path claims a delivery in
 * `apps/api/src/sandbox-proxy/prompt-dedupe.ts` before it ever reaches
 * opencode. Two `postPrompt` calls for the same row carry byte-identical
 * bodies (same `sessionId` + `text`, no messageID field — see `postPrompt`
 * below), so the claim's content-hash key collides on the retry and the
 * SECOND POST is answered `200 {"deduplicated":true}`, which `postPrompt`
 * reads as accepted. That claim is held for `DEDUPE_TTL_MS` (10 minutes,
 * `prompt-dedupe.ts`) — comfortably past both the scheduler's ~60s drain tick
 * and this file's own `deliverWithRetry` deadline (45s), so an ordinary
 * requeue-and-redrain cycle never outlives it. Pinned in
 * `prompt-dedupe.test.ts`: the TTL boundary itself ("a key is claimable again
 * once its TTL has elapsed") and, exercising `postPrompt`'s exact body shape
 * (`{"parts":[{"type":"text","text":…}]}`, no messageID field), "a retried
 * `continue_session` delivery — postPrompt's exact body shape — collides on
 * the same dedupe key". Only a retry that is itself starved past 10 minutes
 * (the same bound
 * `UNDELIVERED_PROMPT_STARVATION_MS` in `undelivered-prompts.ts` treats as a
 * dead scheduler) can outrun this — an accepted risk, not a silent one.
 *
 * T13b — why a FORWARDED row (one that stays open after a successful delivery,
 * see `markCommandForwarded`) still cannot be delivered twice. It needs no new
 * mechanism, and this is the audit:
 *
 *  - Every inbox delivery carries `Idempotency-Key: <commandId>` (`:r<n>` on a
 *    redelivery), which is `promptDeliveryKey`'s HIGHEST precedence — the
 *    wire-id and content-hash tiers are never even reached for one. Two
 *    forwards of one row therefore collide on that key and the second is
 *    answered `200 {"deduplicated":true}` for `DEDUPE_TTL_MS`.
 *  - A forwarded row is `succeeded`, and `claimDueLifecycleCommands` claims
 *    only `queued` rows plus `running` ones whose lock died. No drain can
 *    re-claim it, so there is no second forward to dedupe in the first place.
 *  - `reconcileForwardedPrompts` only ever CLOSES rows. It has no delivery
 *    path at all.
 *
 * The one shape that does re-POST is a redelivery, and it changes both halves
 * on purpose — the key (`:r<n>`) and the wire id (`remintWireMessageId`) —
 * because it is repairing a delivery the daemon proved never ran. That path is
 * guarded by the transcript read below: an assistant reply parented on any id
 * this prompt was delivered under drops the redelivery.
 */
export async function executeQueuedContinue(
  row: SessionLifecycleCommandRow,
): Promise<'succeeded' | 'queued' | 'failed'> {
  const payload = row.payload as unknown as QueuedContinueSessionPayload;
  const text = typeof payload.text === 'string' ? payload.text : '';
  // TEXT OR PARTS. An attachment-only prompt carries no text at all — the
  // composer allows it and the POST route accepts it on exactly that basis — so
  // requiring text here would turn a 202 into a permanently dead row (and, via
  // the dead-letter, park the user's session `failed`).
  const hasBody = !!text || (payload.parts?.length ?? 0) > 0;
  if (!row.sessionId || !hasBody) {
    await markCommandFailed(row.commandId, 'continue_session command missing sessionId or body', {
      retryable: false,
      attempts: row.attempts,
    });
    return 'failed';
  }
  const isPendingFirstPrompt =
    row.idempotencyKey === `prompt:${row.sessionId}:pending-first`;

  // ADMISSION FIRST, before any side effect. A prompt that arrives behind an
  // older prompt of its own session — or beside a sibling already on the wire —
  // waits, so the user's messages keep the order they were typed in. A live
  // turn also holds admission because legacy `/prompt_async` can interleave
  // concurrent inputs. The refusal gives the claim's attempt increment back,
  // so waiting can never dead-letter a prompt.
  //
  // Wrapped: this row is CLAIMED (`running`), and a read that throws out of
  // here would strand it there — where nothing reclaims it until its lock
  // expires, while `older_prompt_pending` blocks every later prompt of the
  // session behind it. A failed read is a retryable failure, not a wedge.
  // Delivery timeline: one structured line per row (`[provision-timeline]
  // deliver <commandId>`), so "how long did a send take, and where" is a log
  // read instead of a guess. Same shape as the provision timeline.
  const tl = new ProvisionTimeline(row.commandId, 'deliver');
  let admission: Awaited<ReturnType<typeof admitInboxPrompt>>;
  try {
    admission = await admitInboxPrompt(row);
    if (admission.admit) await lifecycleStore.markInboxDeliveryStarted(row.commandId);
    tl.mark('admission');
  } catch (err) {
    await markCommandFailed(
      row.commandId,
      `admission check failed: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true, attempts: row.attempts, sessionId: row.sessionId },
    );
    return 'failed';
  }
  if (!admission.admit) {
    try {
      await requeueForAdmission(
        row.commandId,
        admission.reason,
        new Date(Date.now() + admission.retryAfterMs),
      );
    } catch (err) {
      await markCommandFailed(
        row.commandId,
        `admission requeue failed: ${err instanceof Error ? err.message : String(err)}`,
        { retryable: true, attempts: row.attempts, sessionId: row.sessionId },
      );
      return 'failed';
    }
    // The row is durable before the daemon may end this turn. The terminal
    // relay then promotes this same row and delivers it as the next turn.
    if (admission.interruptAtBoundary) {
      await armQuickQueueInterrupt(row, admission.interruptAtBoundary);
    }
    // A terminal relay can arrive while this row is claimed, before it becomes
    // queued again. Recheck after the write so that completion cannot lose its wake.
    if (admission.reason === 'turn_active') {
      try {
        if (!(await sessionHoldsLiveTurn(row.sessionId))) {
          const idempotencyKey = await lifecycleStore.promoteNextInboxRow(row.sessionId);
          if (idempotencyKey) {
            void drainSessionLifecycleQueue({ idempotencyKey, coalesce: false }).catch((error) => {
              logger.error('[session-lifecycle] completion handoff drain failed', { sessionId: row.sessionId, error });
            });
          }
        }
      } catch (error) {
        // The row is durably queued. The retry worker remains its fallback.
        logger.warn('[session-lifecycle] completion handoff check failed', { sessionId: row.sessionId, error });
      }
    }
    return 'queued';
  }

  if (payload.executionId) {
    const [exec] = await db
      .select({ resultSummary: connectorCalls.resultSummary })
      .from(connectorCalls)
      .where(eq(connectorCalls.executionId, payload.executionId))
      .limit(1);
    const summary = (exec?.resultSummary ?? {}) as Record<string, unknown>;
    if (summary.consumed_at) {
      await markCommandSucceeded(
        row.commandId,
        { status: 'skipped', reason: 'consumed_in_band' },
        row.sessionId,
      );
      return 'succeeded';
    }
  }

  // DID THIS ROW WAIT?
  //
  // `payload.remintOnDelivery` is the DURABLE half of "this row waited".
  // `result.admission_reason` is the display half, and it is cleared wholesale
  // by `retryInboxPrompt` — which runs on "send now", i.e. exactly on the row
  // that waited longest. Reading only the display half sent that row under the
  // id minted when the user pressed Enter, and OpenCode read it as answered.
  //
  // Read here, above the staged-revert guard, because both questions turn on
  // it: which wire id this attempt delivers with, and whether this row is
  // allowed to commit a revert.
  const waited =
    payload.remintOnDelivery === true ||
    typeof (row.result as { admission_reason?: unknown } | null)?.admission_reason === 'string';
  // `result.promoted` is written by `retryInboxPrompt` alone — the user pointed
  // at ONE row and pressed "send now". `requeueForAdmission` merges into
  // `result`, so it survives the row waiting again behind an in-flight sibling.
  const promoted = (row.result as { promoted?: unknown } | null)?.promoted === true;

  // WHICH ROW MAY COMMIT A STAGED REVERT.
  //
  // The guard exists (JAY-600/T22) for the approval-resume / trigger backstop:
  // a continue queued BEFORE the user staged a revert is void for the rewound
  // trajectory, and delivering it commits the truncation under a prompt the
  // user wrote against the trajectory that is being discarded.
  //
  // The REPLACEMENT prompt is the exact opposite. "Edit from this message"
  // stages the revert and prefills the composer with that message; the prompt
  // the user then sends IS what commits it. OpenCode truncates on the next
  // delivery, from any producer — that is the whole mechanism. Running the
  // guard on it marked the row `succeeded/skipped:staged_revert`, and
  // `listInboxPrompts` omits succeeded rows, so the replacement prompt
  // disappeared with no error, no turn and no reply — and so did every prompt
  // after it, because nothing else clears `info.revert`.
  //
  // `payload.clientMessageId` does NOT separate those two: a composer prompt
  // queued while the session was busy carries one too. Whether the row WAITED
  // does. A revert can only be staged on an IDLE session (`session.rewind()`
  // refuses a working one), so a row that was refused admission or held by Stop
  // predates the idle window this revert was staged in; the replacement prompt
  // is sent INTO that window and goes out on its first claim. `promoted` beats
  // both — "send now" names one row explicitly, and without that escape a
  // refused row could never be retried, because retrying re-stamps the very
  // marker the refusal reads.
  const mayCommitStagedRevert = !!payload.clientMessageId && (promoted || !waited);
  // Two independent reads of the same box — the staged-revert flag and the
  // transcript tip (below) — used to run one after the other. Started here,
  // awaited together: they cost one round-trip instead of two.
  const stagedRevertPromise = mayCommitStagedRevert
    ? Promise.resolve(false)
    : queuedContinueHasStagedRevert(row);
  /** The row is behind a staged revert: fail or skip it, per the producer. */
  const settleStagedRevert = async (): Promise<'succeeded' | 'failed' | null> => {
    // A COMPOSER prompt is failed, never dropped. `listInboxPrompts` keeps
    // `failed`/`dead_lettered` rows, so the user's text stays on screen with
    // its reason and a retry button that promotes it past this guard. Silently
    // marking it succeeded is how the message was lost. `markCommandFailed`
    // does not park a session for an inbox row, so nothing else is taken away.
    if (payload.clientMessageId) {
      await markCommandFailed(
        row.commandId,
        'queued before the session was rewound — send it again to run it',
        { retryable: false, attempts: row.attempts, sessionId: row.sessionId },
      );
      return 'failed';
    }
    console.warn('[session-lifecycle] dropping queued continue — session has a staged revert', {
      sessionId: row.sessionId,
      commandId: row.commandId,
    });
    await markCommandSucceeded(
      row.commandId,
      { status: 'skipped', reason: 'staged_revert' },
      row.sessionId,
    );
    return 'succeeded';
  };

  // WHICH WIRE ID THIS ATTEMPT DELIVERS WITH.
  //
  // The client's id is used verbatim only when it is still correctly placed:
  // this prompt goes out on its first claim, into a session that has written
  // nothing since the user pressed Enter. Three things invalidate it, and all
  // three are ordinary rather than exotic:
  //
  //  - a TURN IS LIVE. The turn has been writing higher ids since it started,
  //    and the client's id is its browser's clock with no lift against anything
  //    (`ascendingId`), so a browser running behind the sandbox delivers an id
  //    that sorts BELOW them — which OpenCode accepts and silently never runs.
  //    This is the flagship "type while it works" path. Admission deliberately
  //    ignores turn authority, so placement asks this question directly;
  //  - the prompt WAITED (`result.admission_reason` is stamped by every
  //    admission refusal), so something else held the wire while ids moved on;
  //  - the prompt is a REDELIVERY. The abandoned attempt may already have
  //    persisted its user message under that id.
  //
  // All three re-mint against the root's current newest id, from ONE read that
  // also answers "did this prompt already run?".
  //
  // The authority read is wrapped: it is one indexed row, and a read that
  // throws must not strand a CLAIMED row. Unreadable means UNPROVEN, so it
  // re-mints — one transcript read, against a placement bug that loses the
  // user's message with nothing but a server-side log to show for it.
  const redeliveries = Number(payload.redeliveries ?? 0);
  // How many times this row has already been POSTed. Every one of them is a
  // reason to re-mint, for the same reason a redelivery is: OpenCode already
  // holds a message under the previous id.
  const deliveryAttempt = Number(payload.deliveryAttempt ?? 0);
  // Asked only when nothing else has already decided to re-mint, and only for a
  // row that HAS a client id to be wrong about: an automation prompt carries
  // none, and every id-less producer would pay for this read for nothing.
  const remintKnown = deliveryAttempt > 0 || redeliveries > 0 || waited;
  let turnLive = false;
  if (payload.wireMessageId && !remintKnown) {
    try {
      turnLive = await sessionHoldsLiveTurn(row.sessionId);
    } catch (err) {
      console.warn('[session-lifecycle] turn-authority read failed — re-minting the wire id', {
        sessionId: row.sessionId,
        commandId: row.commandId,
        error: err instanceof Error ? err.message : String(err),
      });
      turnLive = true;
    }
  }
  let wireMessageId = payload.wireMessageId;
  /** Deliberately placed BELOW an open sibling — the sibling's step answers
   *  it, and the post-insert strand proof must not "repair" it to the top. */
  let underPlaced = false;
  if (payload.wireMessageId && (remintKnown || turnLive)) {
    const deliveredIds = [
      payload.wireMessageId,
      payload.redeliveredMessageId,
      // EVERY id a re-mint placed this row under, not just the latest: a reply
      // parented on an EARLIER re-minted id proves the prompt was answered just
      // as well, and after two re-mints the scalar no longer holds that id.
      ...(payload.redeliveredMessageIds ?? []),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);
    const transcriptPromise = readInboxTranscriptState(row, deliveredIds, {
      full: deliveryAttempt > 0 || redeliveries > 0,
    });
    // The staged-revert answer lands while the tip read is in flight.
    const stagedRevertEarly = await stagedRevertPromise;
    if (stagedRevertEarly) {
      const settled = await settleStagedRevert();
      if (settled) {
        return settled;
      }
    }
    const transcript = await transcriptPromise;
    tl.mark('transcript-read');
    // A prompt POSTed before may already be answered. An unreadable transcript
    // cannot prove it is not, so the redelivery waits and re-checks instead of
    // re-sending blind, up to MAX_ANSWER_CHECK_FAILURES times. A first delivery
    // was never posted, so its fail-open read stays safe.
    const alreadyPosted = deliveryAttempt > 0 || redeliveries > 0;
    const answerCheckFailures = Number(
      (row.result as { answer_check_failures?: unknown } | null)?.answer_check_failures ?? 0,
    );
    if (
      alreadyPosted &&
      !transcript.read &&
      answerCheckFailures < MAX_ANSWER_CHECK_FAILURES
    ) {
      console.warn('[session-lifecycle] redelivery waits — the answered check could not read the transcript', {
        sessionId: row.sessionId,
        commandId: row.commandId,
        redeliveries,
        answerCheckFailures,
      });
      await lifecycleStore.requeueUnverifiedRedelivery(
        row.commandId,
        new Date(Date.now() + ANSWER_CHECK_RETRY_BASE_MS * 2 ** answerCheckFailures),
      );
      return 'queued';
    }
    // The already-answered guard is not redelivery-only. Every re-mint path
    // re-reads the transcript, and an assistant reply parented on one of THIS
    // prompt's delivered ids proves the same thing on all of them: the turn
    // ran. (On a first delivery no id was ever posted, so this cannot fire.)
    if (transcript.read && transcript.answered) {
      // The record said `delivering`, but that only ever proved the ACCEPTANCE
      // write never landed. An assistant reply under this prompt proves the
      // turn ran, so re-sending it would run the user's message — and spend a
      // second real LLM turn — twice.
      console.warn('[session-lifecycle] dropping delivery — the prompt was already answered', {
        sessionId: row.sessionId,
        commandId: row.commandId,
        redeliveries,
      });
      await markCommandSucceeded(
        row.commandId,
        { status: 'skipped', reason: 'already_answered' },
        row.sessionId,
      );
      return 'succeeded';
    }
    // A LATE delivery does not always go to the top. When the transcript
    // still holds an OPEN sibling above this prompt's original id — placed,
    // unanswered — the original id slots the prompt into its SEND position,
    // and that sibling's step answers both (OpenCode hands the model the
    // whole transcript). Re-minting was what put a delayed message below its
    // answer— and a re-mint here put it visually LAST when it was sent
    // first. Only a first delivery may do this: a re-POST's original id may
    // already be persisted.
    if (
      deliveryAttempt === 0 &&
      redeliveries === 0 &&
      payload.wireMessageId &&
      transcript.read &&
      transcript.tip &&
      openUserAbove(transcript.tip, payload.wireMessageId)
    ) {
      wireMessageId = payload.wireMessageId;
      underPlaced = true;
      tl.mark('under-placed');
    } else {
      wireMessageId = await remintWireMessageId(row, payload, transcript);
      tl.mark('remint');
    }
  }
  {
    const stagedRevertLate = await stagedRevertPromise;
    tl.mark('staged-revert');
    if (stagedRevertLate) {
      const settled = await settleStagedRevert();
      if (settled) return settled;
    }
  }

  // Did this delivery go into a turn that was LIVE when it left? Then the
  // placement has to be PROVEN, not assumed — see forwarded-placement.ts.
  const placedIntoLiveTurn = !!wireMessageId && (turnLive || remintKnown);
  try {
    let attempt = deliveryAttempt;
    let delivery: SessionDeliveryOutcome;
    for (let round = 0; ; round += 1) {
      const postedAt = Date.now();
      delivery = await continueSession(
        {
          source: row.source as SessionInvocationSource,
          sessionId: row.sessionId,
          projectId: row.projectId,
          text,
          userId: row.actorUserId,
          ...(payload.parts?.length ? { parts: payload.parts } : {}),
          ...(payload.overrides ? { overrides: payload.overrides } : {}),
          ...(wireMessageId ? { wireMessageId } : {}),
          materializationKey: row.commandId,
          isPendingFirstPrompt,
        },
        // F2: stable across every drain-and-retry of THIS row — see
        // `postPrompt`'s F2 note. Two DIFFERENT queued commands (distinct
        // `commandId`s) with identical text now deliver independently instead
        // of the second silently deduping against the first.
        //
        // A ROW THAT ALREADY WENT OUT suffixes it: the previous attempt's
        // 10-minute dedupe claim is still live in the proxy, and reusing the key
        // would let that claim swallow the delivery meant to replace it — a
        // `200 {"deduplicated": true}` that `postPrompt` reads as delivered.
        // Still stable across `deliverWithRetry`'s inner retries, which is what
        // the claim is for.
        //
        // `deliveryAttempt`, not `redeliveries`: a released Stop and a "send now"
        // on a stop-paused row are re-POSTs too, and neither is a reaper
        // redelivery. See `withNextDeliveryAttempt`.
        attempt > 0 ? `${row.commandId}:r${attempt}` : row.commandId,
        tl,
        payload.clientMessageId ? () => assertInboxDeliveryActive(row.commandId) : undefined,
      );
      tl.mark('delivered');
      if (delivery !== 'delivered') break;
      // DELIVERED IS NOT CONSUMED. OpenCode persists the prompt and queues it
      // behind the turn in flight, so the row stays OPEN — see
      // `markCommandForwarded` — until `session_turns` names this wire id.
      //
      // Only a row that HAS a wire id can be tracked that way. Every automation
      // producer (triggers, Slack, approval-resume) leaves `messageID` off the
      // body entirely (`postPrompt`), so the ledger has nothing to key its
      // confirmation on and the row would hang for ever. Those close here, as
      // they always did.
      if (wireMessageId) {
        await markCommandForwarded(row.commandId, row.sessionId, wireMessageId);
      } else {
        await markCommandSucceeded(row.commandId, { status: 'delivered' }, row.sessionId);
      }
      tl.mark('marked');
      // The prompt is now on the wire for its target session. If it came from a
      // trigger, flip that trigger's runtime row from the transient "queued" to
      // "fired" so monitoring can tell a delivered reuse fire from a wedged one
      // (see markTriggerRuntimeDelivered). Failure to write back must never break
      // delivery, hence the swallow.
      if (typeof payload.triggerSlug === 'string') {
        await markTriggerRuntimeDelivered({
          projectId: row.projectId,
          slug: payload.triggerSlug,
          when: new Date(),
        }).catch(() => {});
      }
      if (!placedIntoLiveTurn || !wireMessageId) break;
      // PROOF. One tip read after the insert answers exactly whether the box
      // created a newer assistant BEFORE this prompt landed (the strand
      // signature). It also hands back the box's own `time.created` for the
      // message, which calibrates the next placement for this session.
      const proof = await verifyLivePlacement(row, wireMessageId, postedAt);
      tl.mark('placement-proof');
      if (underPlaced) break; // below an open sibling by design — its step answers this
      if (!proof.stranded) break;
      // A later sibling already on the wire pins this row's ORDER: repairing
      // solo would re-mint it above the sibling and OpenCode would answer them
      // inverted. The turn-end reconciliation re-places the whole tail in
      // send order instead.
      if (await hasLaterForwardedSibling(row)) {
        logger.info(
          '[session-lifecycle] stranded prompt has later siblings — turn-end reconciliation will re-place the tail in order',
          { session_id: row.sessionId, command_id: row.commandId, wire_message_id: wireMessageId },
        );
        break;
      }
      if (round >= MAX_LIVE_PLACEMENT_REPAIRS) {
        logger.error(
          '[session-lifecycle] forwarded prompt still stranded after repairs — leaving it to turn-end reconciliation',
          {
            session_id: row.sessionId,
            command_id: row.commandId,
            wire_message_id: wireMessageId,
            stranded_by: proof.strandedBy,
          },
        );
        break;
      }
      // REPAIR: take the stranded copy out of the transcript, place again
      // above the assistant that proves the strand, and go round once more.
      // The stale message must go first: OpenCode would otherwise hold the
      // prompt twice, and the model would read it twice.
      //
      // OpenCode refuses a message delete WHILE THE LOOP RUNS
      // (`deleteMessage` → `assertNotBusy`), and a strand is, almost by
      // definition, detected while it runs. So this repair fires only when
      // the step already ended between the insert and the proof; the
      // ordinary case is handed to turn-end reconciliation
      // (forwarded-strand-reconcile.ts), which runs the same repair the
      // moment the daemon relays the turn's end — before the box is idle
      // long enough for anyone to notice.
      const removed = await removeStrandedOpencodeMessage(row, wireMessageId);
      if (!removed) {
        logger.info(
          '[session-lifecycle] stranded prompt detected mid-turn — turn-end reconciliation will re-place it',
          {
            session_id: row.sessionId,
            command_id: row.commandId,
            wire_message_id: wireMessageId,
            stranded_by: proof.strandedBy,
          },
        );
        break;
      }
      const replaced = await remintForRepair(row, proof.newest);
      attempt += 1;
      logger.warn('[session-lifecycle] forwarded prompt landed below a newer assistant — re-placed', {
        session_id: row.sessionId,
        command_id: row.commandId,
        stranded_wire_id: wireMessageId,
        stranded_by: proof.strandedBy,
        replaced_wire_id: replaced,
        round: round + 1,
      });
      wireMessageId = replaced;
    }
    if (delivery === 'delivered') {
      // A successful POST starts a TURN, and the TERMINAL RELAY owns promotion
      // of the next row — `routes/r4.ts`, "THE TURN ENDED — the session's next
      // queued prompt is admissible NOW", which awaits `promoteNextInboxRow`
      // before it acknowledges the daemon.
      //
      // Promoting here instead is what let a burst of queued messages share
      // one answer: the next row was made due while this turn was still
      // running, admission had no turn gate to stop it, and OpenCode merged
      // every prompt it found into the step that reached them. Reported
      // 2026-09-04 — "tell me HI" and "tell me bye" queued behind a 13-step
      // turn produced exactly one reply, "bye".
      //
      // Promoting here is also a LOST WAKE even with the gate back: the row
      // would be claimed mid-turn, refused by admission, and requeued — after
      // the terminal relay has already checked the queue — so the next prompt
      // waits out the admission backoff instead of going out on the turn-end
      // event.
      tl.log({ sessionId: row.sessionId, source: row.source, outcome: delivery });
      return 'succeeded';
    }
    tl.log({ sessionId: row.sessionId, source: row.source, outcome: delivery });
    // 'unreachable' = the RUNTIME was down. The prompt is fine; it waits for the
    // box on its own (long) ladder and is re-armed the moment a wake confirms
    // the runtime is back. Bounded — a spent budget falls through to the
    // dead-letter below, which is what puts the retry button in front of the user.
    if (delivery === 'unreachable') {
      const parked = await parkPromptForUnreachableRuntime(
        row.commandId,
        DELIVERY_FAILURE_COPY[delivery],
        { sessionId: row.sessionId },
      );
      if (parked.parked) return 'queued';
      await markCommandFailed(
        row.commandId,
        `${DELIVERY_FAILURE_COPY.unreachable} after ${MAX_RUNTIME_UNREACHABLE_RETRIES} attempts`,
        { retryable: false, attempts: row.attempts, sessionId: row.sessionId },
      );
      return 'failed';
    }
    // 'not-landed' = the runtime accepted the prompt and never wrote it. Back
    // on the queue under a FRESH attempt — fresh key, fresh wire id — never a
    // retry under this one (see `requeueUnlandedPrompt`). Bounded: past the
    // budget it dead-letters with the one error that names what happened.
    if (delivery === 'not-landed') {
      const reason = 'prompt accepted by the runtime but never became a message';
      const requeue = await requeueUnlandedPrompt(
        row.commandId,
        reason,
        new Date(Date.now() + NOT_LANDED_RETRY_DELAY_MS),
      );
      if (requeue.requeued) {
        logger.warn('[session-lifecycle] prompt never landed — re-sending under a fresh key', {
          session_id: row.sessionId,
          command_id: row.commandId,
          refusals: requeue.refusals,
        });
        return 'queued';
      }
      await markCommandFailed(row.commandId, reason, {
        retryable: false,
        attempts: row.attempts,
        sessionId: row.sessionId,
      });
      return 'failed';
    }
    // 'pending' = runtime not ready in time — worth another pass. 'no-session'
    // and 'failed' are terminal for this command.
    const retryable = delivery === 'pending';
    await markCommandFailed(row.commandId, DELIVERY_FAILURE_COPY[delivery], {
      retryable,
      attempts: row.attempts,
      sessionId: row.sessionId,
    });
    return retryable ? 'queued' : 'failed';
  } catch (e) {
    if (e instanceof InboxDeliveryPaused) {
      await releasePausedInboxDelivery(row.commandId);
      return 'queued';
    }
    const retryable = !(e instanceof PromptDeliveryRefused);
    await markCommandFailed(row.commandId, (e as Error).message || 'continue_session threw', {
      retryable,
      attempts: row.attempts,
      sessionId: row.sessionId,
    });
    return retryable ? 'queued' : 'failed';
  }
}
