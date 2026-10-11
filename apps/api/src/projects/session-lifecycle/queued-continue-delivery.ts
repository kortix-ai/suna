import { sessionLifecycleCommands } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { markTriggerRuntimeDelivered } from '../trigger-execution-store';
import { continueSession } from './continue-session';
import { PromptDeliveryRefused } from './prompt-delivery-refusal';
import { assertInboxDeliveryActive, InboxDeliveryPaused, returnClaimToQueue } from './inbox-delivery-hold';
import { SteerNotTaken, postPrompt, readInboxTranscriptState, retractStrandedMessage } from './runtime-client';
import { awakeDeliveryTarget } from './deliver';
import { recordSteerFallback } from './command-transitions';
import { MAX_LIVE_PLACEMENT_REPAIRS, hasLaterForwardedSibling, recordRepairedForward, remintForRepair, remintWireMessageId, verifyLivePlacement } from './inbox-placement';
import { MAX_RUNTIME_UNREACHABLE_RETRIES, markCommandFailed, parkPromptForUnreachableRuntime, markCommandForwarded, requeueForAdmission, requeueUnlandedPrompt, markCommandSucceeded, type SessionLifecycleCommandRow, type QueuedContinueSessionPayload } from './store';
import type { PromptOverridesWire } from './prompt-payload';
import { DELIVERY_FAILURE_COPY, type SessionDeliveryOutcome, type SessionInvocationSource } from './types';

const NOT_LANDED_RETRY_DELAY_MS = 2_000;
type Status = 'succeeded' | 'queued' | 'failed';

async function settleDelivery(row: SessionLifecycleCommandRow, delivery: Exclude<SessionDeliveryOutcome, 'delivered'>): Promise<Status> {
  if (delivery === 'unreachable') {
    const parked = await parkPromptForUnreachableRuntime(row, DELIVERY_FAILURE_COPY[delivery], { sessionId: row.sessionId });
    if (parked.parked) return 'queued';
    await markCommandFailed(row, `${DELIVERY_FAILURE_COPY.unreachable} after ${MAX_RUNTIME_UNREACHABLE_RETRIES} attempts`,
      { retryable: false, attempts: row.attempts, sessionId: row.sessionId });
    return 'failed';
  }
  if (delivery === 'not-landed') {
    const reason = 'prompt accepted by the runtime but never became a message';
    const requeue = await requeueUnlandedPrompt(row, reason, new Date(Date.now() + NOT_LANDED_RETRY_DELAY_MS));
    if (requeue.requeued) {
      logger.warn('[session-lifecycle] prompt never landed — re-sending under a fresh key', {
        session_id: row.sessionId, command_id: row.commandId, refusals: requeue.refusals,
      });
      return 'queued';
    }
    await markCommandFailed(row, reason, { retryable: false, attempts: row.attempts, sessionId: row.sessionId });
    return 'failed';
  }
  const retryable = delivery === 'pending';
  await markCommandFailed(row, DELIVERY_FAILURE_COPY[delivery], { retryable, attempts: row.attempts, sessionId: row.sessionId });
  return retryable ? 'queued' : 'failed';
}

async function markDelivered(row: SessionLifecycleCommandRow, payload: QueuedContinueSessionPayload, wireMessageId: string | undefined, tl: ProvisionTimeline, noReply: boolean): Promise<void> {
  if (wireMessageId) await markCommandForwarded(row, row.sessionId!, wireMessageId, noReply ? { noReply } : undefined);
  else await markCommandSucceeded(row, { status: 'delivered' }, row.sessionId);
  tl.mark('marked');
  if (typeof payload.triggerSlug === 'string') {
    await markTriggerRuntimeDelivered({ projectId: row.projectId, slug: payload.triggerSlug, when: new Date() }).catch(() => {});
  }
}

async function repairPlacement(row: SessionLifecycleCommandRow, wireMessageId: string, postedAt: number, round: number, underPlaced: boolean, tl: ProvisionTimeline): Promise<string | null> {
  const proof = await verifyLivePlacement(row, wireMessageId, postedAt);
  tl.mark('placement-proof');
  if (underPlaced || !proof.stranded) return null;
  if (await hasLaterForwardedSibling(row)) {
    logger.info('[session-lifecycle] stranded prompt has later siblings — turn-end reconciliation will re-place the tail in order',
      { session_id: row.sessionId, command_id: row.commandId, wire_message_id: wireMessageId });
    return null;
  }
  if (round >= MAX_LIVE_PLACEMENT_REPAIRS) {
    logger.error('[session-lifecycle] forwarded prompt still stranded after repairs — leaving it to turn-end reconciliation', {
      session_id: row.sessionId, command_id: row.commandId, wire_message_id: wireMessageId, stranded_by: proof.strandedBy,
    });
    return null;
  }
  const removed = await retractStrandedMessage(row, wireMessageId);
  if (!removed) {
    logger.info('[session-lifecycle] stranded prompt detected mid-turn — turn-end reconciliation will re-place it', {
      session_id: row.sessionId, command_id: row.commandId, wire_message_id: wireMessageId, stranded_by: proof.strandedBy,
    });
    return null;
  }
  const replaced = await remintForRepair(row, proof.newest);
  logger.warn('[session-lifecycle] forwarded prompt landed below a newer assistant — re-placed', {
    session_id: row.sessionId, command_id: row.commandId, stranded_wire_id: wireMessageId,
    stranded_by: proof.strandedBy, replaced_wire_id: replaced, round: round + 1,
  });
  return replaced;
}

/**
 * A continuation that names no model (approval resume, connector connected,
 * secret submitted, auto-recovery, a trigger without its own model) runs on the
 * agent/model/variant of the session's newest turn that named one. Without
 * this OpenCode falls back to the default agent's own `model:` pin, which can
 * be a model the user no longer uses or the gateway cannot serve.
 */
export async function continuationOverrides(
  sessionId: string,
  own: PromptOverridesWire | undefined,
): Promise<PromptOverridesWire | undefined> {
  if (own?.model) return own;
  const [last] = await db
    .select({ payload: sessionLifecycleCommands.payload })
    .from(sessionLifecycleCommands)
    .where(and(
      eq(sessionLifecycleCommands.sessionId, sessionId),
      eq(sessionLifecycleCommands.commandType, 'continue_session'),
      sql`${sessionLifecycleCommands.payload}->'overrides'->'model' is not null`,
      sql`jsonb_typeof(${sessionLifecycleCommands.payload}->'overrides'->'model') = 'object'`,
    ))
    .orderBy(desc(sessionLifecycleCommands.createdAt))
    .limit(1);
  const picked = (last?.payload as { overrides?: PromptOverridesWire } | undefined)?.overrides;
  if (!picked?.model) return own;
  return {
    ...(picked.agent ? { agent: picked.agent } : {}),
    model: picked.model,
    ...(picked.variant ? { variant: picked.variant } : {}),
    // The continuation's own non-null picks (e.g. a directory) still win.
    ...Object.fromEntries(Object.entries(own ?? {}).filter(([, value]) => value != null)),
  };
}

export async function deliverQueuedContinue(row: SessionLifecycleCommandRow, payload: QueuedContinueSessionPayload,
  text: string, wireId: string | undefined, placedIntoLiveTurn: boolean, underPlaced: boolean,
  tl: ProvisionTimeline, noReply = false): Promise<Status> {
  let wireMessageId = wireId;
  const isPendingFirstPrompt = row.idempotencyKey === `prompt:${row.sessionId}:pending-first`;
  try {
    const overrides = await continuationOverrides(row.sessionId!, payload.overrides ?? undefined);
    let attempt = Number(payload.deliveryAttempt ?? 0);
    let delivery: SessionDeliveryOutcome;
    for (let round = 0; ; round += 1) {
      const postedAt = Date.now();
      delivery = await continueSession({
        source: row.source as SessionInvocationSource, sessionId: row.sessionId!, projectId: row.projectId,
        text, userId: row.actorUserId,
        ...(payload.parts?.length ? { parts: payload.parts } : {}),
        ...(overrides ? { overrides } : {}),
        ...(wireMessageId ? { wireMessageId } : {}),
        materializationKey: row.commandId, isPendingFirstPrompt,
        ...(noReply ? { noReply } : {}),
        ...(payload.bindTurnIdentity ? { bindTurnIdentity: true } : {}),
        ...(payload.opencodeEnv ? { opencodeEnv: payload.opencodeEnv } : {}),
        ...(payload.clientMessageId ? {} : { queuedAt: row.createdAt }),
      }, attempt > 0 ? `${row.commandId}:r${attempt}` : row.commandId, tl,
      payload.clientMessageId ? () => assertInboxDeliveryActive(row) : undefined);
      tl.mark('delivered');
      if (delivery !== 'delivered') break;
      // A repair round re-sends after round 0's forward closed the claim.
      if (round === 0) await markDelivered(row, payload, wireMessageId, tl, noReply);
      else await recordRepairedForward(row.commandId, wireMessageId!);
      if (!placedIntoLiveTurn || !wireMessageId) break;
      const replaced = await repairPlacement(row, wireMessageId, postedAt, round, underPlaced, tl);
      if (!replaced) break;
      attempt += 1;
      wireMessageId = replaced;
    }
    // Timeline starts at admission; include the durable queue wait without logging prompt contents.
    const elapsed = Date.now() - row.createdAt.getTime();
    tl.log({
      sessionId: row.sessionId, source: row.source, outcome: delivery,
      queueWaitMs: Math.max(0, elapsed - tl.totalMs), enqueueToDeliveryMs: elapsed,
    });
    return delivery === 'delivered' ? 'succeeded' : settleDelivery(row, delivery);
  } catch (e) {
    if (e instanceof InboxDeliveryPaused) {
      await returnClaimToQueue(row);
      return 'queued';
    }
    const retryable = !(e instanceof PromptDeliveryRefused);
    await markCommandFailed(row, (e as Error).message || 'continue_session threw', {
      retryable, attempts: row.attempts, sessionId: row.sessionId,
    });
    return retryable ? 'queued' : 'failed';
  }
}

/**
 * Hand one admitted `steer` row to the running turn (R10): `POST .../steer`
 * on the awake box, under the client's wire id. 202 or a deduplicated 200
 * marks the row forwarded with `steered_into_message_id`; the `steer_read`
 * relay or the turn end closes it.
 *
 * What it leaves out of `deliverQueuedContinue`, on purpose:
 * - No wake and no slow path: a steer is only for a turn that runs now. A box
 *   that is not awake is `turn_ended`.
 * - No landing proof: pi writes a steered message only when the turn reads
 *   it, so a read-back right after the POST reports it missing.
 * - No placement repair: a steer sits below the running step's assistant
 *   until the next step reads it. That is the strand shape the repair removes.
 * - No turn-identity bind: admission proved the sender is the turn's prompter.
 *
 * It keeps one step of placement: a row marked `remintOnDelivery` gets a new
 * id above the live transcript before the POST. That id is either minted
 * where no transcript was read (a server-minted id is dated 2 min back) or
 * passed by the turn's own steps while the row waited. Posted as is, the
 * message sorts above the turn that reads it, and the web groups the rest of
 * the turn under it (2026-10-10, the connector-connected notice).
 *
 * `turn_ended` (409 `no_active_turn`) and `unsupported` (501) fall back to
 * `queue` and requeue the row due now, with the claim's attempt given back.
 */
export async function deliverSteer(row: SessionLifecycleCommandRow, payload: QueuedContinueSessionPayload,
  text: string, steerInto: string, tl: ProvisionTimeline): Promise<Status> {
  const sessionId = row.sessionId!;
  const attempt = Number(payload.deliveryAttempt ?? 0);
  try {
    if (payload.clientMessageId) await assertInboxDeliveryActive(row);
    const target = await awakeDeliveryTarget(sessionId);
    if (!target?.externalId || !target.opencodeSessionId) throw new SteerNotTaken('turn_ended');
    const wireMessageId = payload.remintOnDelivery
      ? await remintWireMessageId(row, payload, await readInboxTranscriptState(row, []))
      : payload.wireMessageId!;
    const delivery = await postPrompt(target.externalId, target.opencodeSessionId, text, row.actorUserId!, sessionId,
      `${attempt > 0 ? `${row.commandId}:r${attempt}` : row.commandId}:steer`, {
        ...(payload.parts?.length ? { parts: payload.parts } : {}),
        wireMessageId, materializationKey: row.commandId,
        accountId: row.accountId, projectId: row.projectId, sandboxRecord: target.record, steer: true,
      });
    tl.mark('delivered');
    tl.log({ sessionId, source: row.source, outcome: `steer:${delivery}` });
    if (delivery === 'accepted' || delivery === 'deduplicated') {
      await markCommandForwarded(row, sessionId, wireMessageId, { steeredIntoMessageId: steerInto });
      return 'succeeded';
    }
    return settleDelivery(row, delivery);
  } catch (e) {
    if (e instanceof SteerNotTaken) {
      logger.info('[session-lifecycle] steer not taken — sending it as a queued prompt', {
        session_id: sessionId, command_id: row.commandId, reason: e.reason,
      });
      await recordSteerFallback(row, e.reason);
      await requeueForAdmission(row, 'turn_active', new Date());
      return 'queued';
    }
    if (e instanceof InboxDeliveryPaused) {
      await returnClaimToQueue(row);
      return 'queued';
    }
    const retryable = !(e instanceof PromptDeliveryRefused);
    await markCommandFailed(row, (e as Error).message || 'steer threw', {
      retryable, attempts: row.attempts, sessionId,
    });
    return retryable ? 'queued' : 'failed';
  }
}
