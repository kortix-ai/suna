
import * as lifecycleStore from './store';
import { connectorCalls } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { ProvisionTimeline } from '../../platform/services/provision-timeline';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import {
  type SessionLifecycleCommandRow,
  markCommandFailed,
  markCommandSucceeded,
  requeueForAdmission,
  type QueuedContinueSessionPayload,
} from './store';
import { admitInboxPrompt, sessionHoldsLiveTurn } from './inbox-admission';
import { openUserAbove } from './forwarded-placement';
import {
  armQuickQueueInterrupt,
  queuedContinueHasStagedRevert,
  readInboxTranscriptState,
} from './runtime-client';
import {
  remintWireMessageId,
} from './inbox-placement';
import { deliverQueuedContinue } from './queued-continue-delivery';
import { drainSessionLifecycleQueue } from './drain';

const ANSWER_CHECK_RETRY_BASE_MS = 5_000;
const MAX_ANSWER_CHECK_FAILURES = 3;

async function admitQueuedContinue(row: SessionLifecycleCommandRow, tl: ProvisionTimeline): Promise<'admitted' | 'queued' | 'failed'> {
  let admission: Awaited<ReturnType<typeof admitInboxPrompt>>;
  try {
    admission = await admitInboxPrompt(row);
    if (admission.admit) await lifecycleStore.markInboxDeliveryStarted(row);
    tl.mark('admission');
  } catch (err) {
    await markCommandFailed(row, `admission check failed: ${err instanceof Error ? err.message : String(err)}`, {
      retryable: true, attempts: row.attempts, sessionId: row.sessionId,
    });
    return 'failed';
  }
  if (admission.admit) return 'admitted';
  try {
    await requeueForAdmission(row, admission.reason, new Date(Date.now() + admission.retryAfterMs));
  } catch (err) {
    await markCommandFailed(row, `admission requeue failed: ${err instanceof Error ? err.message : String(err)}`, {
      retryable: true, attempts: row.attempts, sessionId: row.sessionId,
    });
    return 'failed';
  }
  if (admission.interruptAtBoundary) await armQuickQueueInterrupt(row, admission.interruptAtBoundary);
  if (admission.reason === 'turn_active') await wakeAfterAdmission(row);
  return 'queued';
}

async function wakeAfterAdmission(row: SessionLifecycleCommandRow): Promise<void> {
  try {
    if (await sessionHoldsLiveTurn(row.sessionId!)) return;
    const idempotencyKey = await lifecycleStore.promoteNextInboxRow(row.sessionId!);
    if (idempotencyKey) {
      void drainSessionLifecycleQueue({ idempotencyKey, coalesce: false }).catch((error) => {
        logger.error('[session-lifecycle] completion handoff drain failed', { sessionId: row.sessionId, error });
      });
    }
  } catch (error) {
    logger.warn('[session-lifecycle] completion handoff check failed', { sessionId: row.sessionId, error });
  }
}

export async function executeQueuedContinue(
  row: SessionLifecycleCommandRow,
): Promise<'succeeded' | 'queued' | 'failed'> {
  const payload = row.payload as unknown as QueuedContinueSessionPayload;
  const text = typeof payload.text === 'string' ? payload.text : '';
  const hasBody = !!text || (payload.parts?.length ?? 0) > 0;
  if (!row.sessionId || !hasBody) {
    await markCommandFailed(row, 'continue_session command missing sessionId or body', {
      retryable: false,
      attempts: row.attempts,
    });
    return 'failed';
  }
  const tl = new ProvisionTimeline(row.commandId, 'deliver');
  const admitted = await admitQueuedContinue(row, tl);
  if (admitted !== 'admitted') return admitted;

  if (payload.executionId) {
    const [exec] = await db
      .select({ resultSummary: connectorCalls.resultSummary })
      .from(connectorCalls)
      .where(eq(connectorCalls.executionId, payload.executionId))
      .limit(1);
    const summary = (exec?.resultSummary ?? {}) as Record<string, unknown>;
    if (summary.consumed_at) {
      await markCommandSucceeded(
        row,
        { status: 'skipped', reason: 'consumed_in_band' },
        row.sessionId,
      );
      return 'succeeded';
    }
  }

  const placement = await placeQueuedContinue(row, payload, tl);
  if ('outcome' in placement) return placement.outcome;
  return deliverQueuedContinue(row, payload, text, placement.wireMessageId,
    placement.placedIntoLiveTurn, placement.underPlaced, tl);
}

type Placement = { outcome: 'succeeded' | 'queued' | 'failed' } | {
  wireMessageId: string | undefined; underPlaced: boolean; placedIntoLiveTurn: boolean;
};

async function settleStagedRevert(row: SessionLifecycleCommandRow, payload: QueuedContinueSessionPayload): Promise<'succeeded' | 'failed'> {
  if (payload.clientMessageId) {
    await markCommandFailed(row, 'queued before the session was rewound — send it again to run it',
      { retryable: false, attempts: row.attempts, sessionId: row.sessionId });
    return 'failed';
  }
  console.warn('[session-lifecycle] dropping queued continue — session has a staged revert', {
    sessionId: row.sessionId, commandId: row.commandId,
  });
  await markCommandSucceeded(row, { status: 'skipped', reason: 'staged_revert' }, row.sessionId);
  return 'succeeded';
}

async function checkTranscript(row: SessionLifecycleCommandRow,
  transcript: Awaited<ReturnType<typeof readInboxTranscriptState>>, deliveryAttempt: number,
  redeliveries: number): Promise<'queued' | 'succeeded' | null> {
  const alreadyPosted = deliveryAttempt > 0 || redeliveries > 0;
  const answerCheckFailures = Number(
    (row.result as { answer_check_failures?: unknown } | null)?.answer_check_failures ?? 0,
  );
  if (alreadyPosted && !transcript.read && answerCheckFailures < MAX_ANSWER_CHECK_FAILURES) {
    console.warn('[session-lifecycle] redelivery waits — the answered check could not read the transcript', {
      sessionId: row.sessionId, commandId: row.commandId, redeliveries, answerCheckFailures,
    });
    await lifecycleStore.requeueUnverifiedRedelivery(row,
      new Date(Date.now() + ANSWER_CHECK_RETRY_BASE_MS * 2 ** answerCheckFailures));
    return 'queued';
  }
  if (transcript.read && transcript.answered) {
    console.warn('[session-lifecycle] dropping delivery — the prompt was already answered', {
      sessionId: row.sessionId, commandId: row.commandId, redeliveries,
    });
    await markCommandSucceeded(row, { status: 'skipped', reason: 'already_answered' }, row.sessionId);
    return 'succeeded';
  }
  return null;
}

async function placeQueuedContinue(row: SessionLifecycleCommandRow, payload: QueuedContinueSessionPayload,
  tl: ProvisionTimeline): Promise<Placement> {
  const waited =
    payload.remintOnDelivery === true ||
    typeof (row.result as { admission_reason?: unknown } | null)?.admission_reason === 'string';
  const promoted = (row.result as { promoted?: unknown } | null)?.promoted === true;
  const mayCommitStagedRevert = !!payload.clientMessageId && (promoted || !waited);
  const stagedRevertPromise = mayCommitStagedRevert
    ? Promise.resolve(false)
    : queuedContinueHasStagedRevert(row);
  const redeliveries = Number(payload.redeliveries ?? 0);
  const deliveryAttempt = Number(payload.deliveryAttempt ?? 0);
  const remintKnown = deliveryAttempt > 0 || redeliveries > 0 || waited;
  let turnLive = false;
  if (payload.wireMessageId && !remintKnown) {
    try {
      turnLive = await sessionHoldsLiveTurn(row.sessionId!);
    } catch (err) {
      console.warn('[session-lifecycle] turn-authority read failed — re-minting the wire id', {
        sessionId: row.sessionId,
        commandId: row.commandId,
        error: err instanceof Error ? err.message : String(err),
      });
      turnLive = true;
    }
  }
  const placement = await inspectWirePlacement(row, payload, tl, stagedRevertPromise, remintKnown, turnLive, deliveryAttempt, redeliveries);
  if ('outcome' in placement) return placement;
  if (await stagedRevertPromise) {
    tl.mark('staged-revert');
    return { outcome: await settleStagedRevert(row, payload) };
  }
  tl.mark('staged-revert');
  return { ...placement, placedIntoLiveTurn: !!placement.wireMessageId && (turnLive || remintKnown) };
}

async function inspectWirePlacement(row: SessionLifecycleCommandRow, payload: QueuedContinueSessionPayload,
  tl: ProvisionTimeline, stagedRevertPromise: Promise<boolean>, remintKnown: boolean,
  turnLive: boolean, deliveryAttempt: number, redeliveries: number): Promise<
    { outcome: 'succeeded' | 'queued' | 'failed' } | { wireMessageId: string | undefined; underPlaced: boolean }
  > {
  let wireMessageId = payload.wireMessageId;
  let underPlaced = false;
  if (payload.wireMessageId && (remintKnown || turnLive)) {
    const deliveredIds = [
      payload.wireMessageId,
      payload.redeliveredMessageId,
      ...(payload.redeliveredMessageIds ?? []),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);
    const transcriptPromise = readInboxTranscriptState(row, deliveredIds, {
      full: deliveryAttempt > 0 || redeliveries > 0,
    });
    const stagedRevertEarly = await stagedRevertPromise;
    if (stagedRevertEarly) {
      return { outcome: await settleStagedRevert(row, payload) };
    }
    const transcript = await transcriptPromise;
    tl.mark('transcript-read');
    const checked = await checkTranscript(row, transcript, deliveryAttempt, redeliveries);
    if (checked) return { outcome: checked };
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
  return { wireMessageId, underPlaced };
}
