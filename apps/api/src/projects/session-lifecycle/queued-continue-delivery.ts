import { sessionLifecycleCommands } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { markTriggerRuntimeDelivered } from '../trigger-execution-store';
import { continueSession } from './continue-session';
import { PromptDeliveryRefused } from './prompt-delivery-refusal';
import { assertInboxDeliveryActive, InboxDeliveryPaused, returnClaimToQueue } from './inbox-delivery-hold';
import { removeStrandedOpencodeMessage } from './runtime-client';
import { MAX_LIVE_PLACEMENT_REPAIRS, hasLaterForwardedSibling, recordRepairedForward, remintForRepair, verifyLivePlacement } from './inbox-placement';
import { MAX_RUNTIME_UNREACHABLE_RETRIES, markCommandFailed, parkPromptForUnreachableRuntime, markCommandForwarded, requeueUnlandedPrompt, markCommandSucceeded, type SessionLifecycleCommandRow, type QueuedContinueSessionPayload } from './store';
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
  const removed = await removeStrandedOpencodeMessage(row, wireMessageId);
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
