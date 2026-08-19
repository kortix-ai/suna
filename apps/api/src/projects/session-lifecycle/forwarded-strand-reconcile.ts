/**
 * Turn-end reconciliation for prompts forwarded INTO a live turn.
 *
 * When the daemon relays that a turn ENDED (`turn-stream` kind `end`, with the
 * user message the final assistant answered — `M`), every forwarded prompt
 * still open in the turn ledger is one of two things:
 *
 *  - OLDER than `M` (lower wire id): the loop had it when it opened the step
 *    that ended — OpenCode parents each step on the newest user message and
 *    answers everything queued before it in that same step. It is DONE, and
 *    its ledger record must close now. Left open it only closed when a reaper
 *    sweep gave up on it (~20 s later, `unknown`), and for those 20 s the
 *    session read as WORKING to every client (`sessionHoldsTurnAuthority`),
 *    shimmer and all, after the final answer was on screen.
 *
 *  - NEWER than `M` (higher wire id): either a prompt that opened a turn of
 *    its own after this one (the `end` relay is ~1 s behind the box, so a
 *    fresh send can already be running), or a STRANDED prompt — persisted
 *    below an assistant that predates it, which the loop's exit check read as
 *    answered. The transcript tells them apart exactly (`strandedPlacement`):
 *    a stranded one has a higher assistant parented on an OLDER user message
 *    and nothing parented on itself. Those are taken out of the transcript and
 *    re-queued, so the drain delivers them again — placed above everything —
 *    instead of leaving the user's message on screen with nothing ever under
 *    it.
 *
 * This is the safety net behind the drain's own post-insert proof
 * (`executeQueuedContinue` → `verifyLivePlacement`): a verify read that failed
 * or a repair that could not run ends up here, a turn later.
 */

import { sessionLifecycleCommands, sessionTurns } from '@kortix/db';
import { and, desc, eq, ne, or, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import {
  type StoredSandboxTurn,
  closeSandboxTurnByMessageId,
} from '../sandbox-turn-lifecycle';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';
import { wireIdTime } from '../wire-message-id';
import { drainSessionLifecycleQueue, resolveSessionOpencodeEndpoint } from './engine';
import { type PlacementTipMessage, openUserAbove, parsePlacementTip, strandedPlacement } from './forwarded-placement';
import { promoteNextInboxRow, withNextDeliveryAttempt } from './store';

const WORKSPACE = '/workspace';
/** The stranded prompt and the assistant that proves it both sit at the tip. */
const TIP_LIMIT = 12;
const MAX_STRAND_REDELIVERIES = 3;

export interface ForwardedTurnReconciliation {
  closedOlder: number;
  candidates: number;
  stranded: number;
  requeued: number;
  /** Later, un-stranded siblings pulled back with a stranded row so the
   *  redelivery batch restores send order. */
  reordered: number;
}

export interface StrandReconcileDeps {
  readOpenTurns: (sessionId: string) => Promise<StoredSandboxTurn[]>;
  closeOlderTurn: (sessionId: string, opencodeSessionId: string | null, messageId: string) => Promise<void>;
  closeStrandedTurn: (sessionId: string, messageId: string) => Promise<void>;
  readTip: (sessionId: string) => Promise<PlacementTipMessage[] | null>;
  removeMessage: (sessionId: string, messageId: string) => Promise<boolean>;
  requeueStranded: (sessionId: string, messageId: string) => Promise<'requeued' | 'no_row' | 'exhausted' | 'not_open'>;
  kickDrain: (sessionId: string) => void;
}

const liveDeps: StrandReconcileDeps = {
  async readOpenTurns(sessionId) {
    // The LEDGER, not the sandbox row's `activeTurns`: the metadata entry of a
    // forwarded prompt is frequently gone by the time the `end` relay lands
    // (the proxy's own acceptance/renewal passes settle it), while its ledger
    // row — the durable record `GET .../turn` and the reaper read — stays open
    // until something names it. That open row is what keeps the session
    // reading as working, and what this reconciliation closes.
    const rows = await db
      .select({
        token: sessionTurns.turnToken,
        messageId: sessionTurns.messageId,
        opencodeSessionId: sessionTurns.opencodeSessionId,
        state: sessionTurns.state,
        startedAt: sessionTurns.startedAt,
      })
      .from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, sessionId), ne(sessionTurns.state, 'ended')));
    return rows.map(
      (row): StoredSandboxTurn => ({
        token: row.token,
        messageId: row.messageId ?? null,
        opencodeSessionId: row.opencodeSessionId ?? '',
        state: row.state === 'active' ? 'active' : 'delivering',
        startedAtMs: row.startedAt ? new Date(row.startedAt).getTime() : null,
      }),
    );
  },
  async closeOlderTurn(sessionId, _opencodeSessionId, messageId) {
    // The step that just ended answered it (OpenCode answers every queued
    // message below the one it parents the step on, in that step).
    await closeSandboxTurnByMessageId(sessionId, messageId, 'completed');
  },
  async closeStrandedTurn(sessionId, messageId) {
    await closeSandboxTurnByMessageId(sessionId, messageId, 'abandoned');
  },
  async readTip(sessionId) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) return null;
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message?directory=${encodeURIComponent(WORKSPACE)}&limit=${TIP_LIMIT}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return parsePlacementTip(await res.json().catch(() => null));
  },
  async removeMessage(sessionId, messageId) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) return false;
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message/${encodeURIComponent(messageId)}?directory=${encodeURIComponent(WORKSPACE)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    return res.ok || res.status === 404;
  },
  async requeueStranded(sessionId, messageId) {
    const [row] = await db
      .select({
        commandId: sessionLifecycleCommands.commandId,
        status: sessionLifecycleCommands.status,
        payload: sessionLifecycleCommands.payload,
      })
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          or(
            sql`${sessionLifecycleCommands.payload}->>'wireMessageId' = ${messageId}`,
            sql`${sessionLifecycleCommands.payload}->>'redeliveredMessageId' = ${messageId}`,
          ),
        ),
      )
      .orderBy(desc(sessionLifecycleCommands.createdAt))
      .limit(1);
    if (!row) return 'no_row';
    if (row.status !== 'succeeded') return 'not_open';
    const payload = (row.payload ?? {}) as { redeliveries?: unknown };
    const redeliveries = Number(payload.redeliveries ?? 0) + 1;
    if (redeliveries > MAX_STRAND_REDELIVERIES) return 'exhausted';
    await db
      .update(sessionLifecycleCommands)
      .set({
        status: 'queued',
        availableAt: new Date(),
        attempts: 0,
        lockedBy: null,
        lockedUntil: null,
        lastError: 'redelivered after stranded placement',
        payload: withNextDeliveryAttempt(
          sql`${sessionLifecycleCommands.payload} || ${JSON.stringify({ redeliveries, remintOnDelivery: true })}::jsonb`,
        ),
        // Every delivery marker goes: the row is back in line as if never sent.
        result: { redelivered_from: 'stranded_placement' },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, row.commandId),
          eq(sessionLifecycleCommands.status, 'succeeded'),
        ),
      );
    return 'requeued';
  },
  kickDrain(sessionId) {
    void promoteNextInboxRow(sessionId)
      .then((key) => (key ? drainSessionLifecycleQueue({ idempotencyKey: key }) : null))
      .catch(() => undefined);
  },
};

/**
 * Run at `turn-stream` `end` for `sessionId`, where `endedMessageId` is the
 * user message the final assistant answered (`M`). No-op when the relay did
 * not name one, or when no forwarded turn is open.
 */
export async function reconcileForwardedTurnsAtEnd(
  input: { sessionId: string; opencodeSessionId?: string | null; endedMessageId?: string | null },
  deps: StrandReconcileDeps = liveDeps,
): Promise<ForwardedTurnReconciliation> {
  const out: ForwardedTurnReconciliation = { closedOlder: 0, candidates: 0, stranded: 0, requeued: 0, reordered: 0 };
  let open: StoredSandboxTurn[];
  try {
    open = await deps.readOpenTurns(input.sessionId);
  } catch (err) {
    logger.warn('[forwarded-turns] open-turn read failed', {
      session_id: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return out;
  }
  const sameRoot = (turn: StoredSandboxTurn) =>
    !input.opencodeSessionId || !turn.opencodeSessionId || turn.opencodeSessionId === input.opencodeSessionId;
  const forwarded = open.filter((turn) => !!turn.messageId && sameRoot(turn));
  if (forwarded.length === 0) return out;
  // ONE tip read for everything below. It also stands in for the relay when
  // the daemon named no message (an older agent build, or an end it could not
  // attribute): the newest FINISHED assistant's parent is the message the
  // ended turn answered.
  let tip: PlacementTipMessage[] | null = null;
  try {
    tip = await deps.readTip(input.sessionId);
  } catch (err) {
    logger.warn('[forwarded-turns] tip read failed — reconciliation skipped', {
      session_id: input.sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  let endedMessageId = input.endedMessageId ?? null;
  if (!endedMessageId && tip) {
    let newest: PlacementTipMessage | null = null;
    for (const m of tip) {
      if (m.role !== 'assistant' || m.completed === null || m.completed === undefined) continue;
      if (typeof m.parentID !== 'string') continue;
      if (!newest || m.id > newest.id) newest = m;
    }
    endedMessageId = newest?.parentID ?? null;
  }
  const endedAt = endedMessageId ? wireIdTime(endedMessageId) : null;
  if (endedAt === null) {
    logger.info('[forwarded-turns] turn end named no message and the tip has no finished assistant — nothing to reconcile against', {
      session_id: input.sessionId,
      open: forwarded.length,
    });
    return out;
  }
  const older: StoredSandboxTurn[] = [];
  const newer: StoredSandboxTurn[] = [];
  for (const turn of forwarded) {
    const at = wireIdTime(turn.messageId!);
    if (at === null || turn.messageId === endedMessageId) continue;
    if (at < endedAt) older.push(turn);
    else newer.push(turn);
  }
  for (const turn of older) {
    try {
      await deps.closeOlderTurn(input.sessionId, turn.opencodeSessionId, turn.messageId!);
      out.closedOlder += 1;
    } catch (err) {
      logger.warn('[forwarded-turns] could not close an older forwarded turn', {
        session_id: input.sessionId,
        message_id: turn.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  out.candidates = newer.length;
  logger.info('[forwarded-turns] turn end reconciled', {
    session_id: input.sessionId,
    ended_message_id: endedMessageId,
    relay_named: !!input.endedMessageId,
    open: open.length,
    closed_older: out.closedOlder,
    candidates: newer.map((t) => t.messageId),
  });
  if (newer.length === 0) return out;
  if (!tip) return out;
  let kicked = false;
  // Classify the newer candidates by the tip. A STRANDED row (persisted below
  // an assistant that predates it) is not lost while a LATER, correctly
  // placed, still-unanswered sibling exists above it: that sibling's step
  // hands the model the whole transcript, the stranded text included, and the
  // model answers both — leave it. Only the stranded TAIL — stranded rows
  // with nothing open above them — is truly dropped (the loop has exited),
  // and it re-queues AS A WHOLE so the redelivery batch re-mints it in send
  // order. Re-queueing one row of a burst individually is what scrambled the
  // order (measured: FIRST, B3, B1, B4, B2).
  const verdicts = newer.map((turn) => ({ turn, verdict: strandedPlacement(tip!, turn.messageId!) }));
  for (const { turn, verdict } of verdicts) {
    if (!verdict.stranded) continue;
    out.stranded += 1;
    // The tip, not just the ledger candidates: ANY placed, unanswered user
    // message above covers this one — a direct send included.
    if (openUserAbove(tip, turn.messageId!)) {
      logger.info('[forwarded-turns] stranded prompt is covered by a later open sibling — left in place', {
        session_id: input.sessionId,
        message_id: turn.messageId,
        stranded_by: verdict.strandedBy,
      });
      continue;
    }
    let removed = false;
    try {
      removed = await deps.removeMessage(input.sessionId, turn.messageId!);
    } catch (err) {
      logger.warn('[forwarded-turns] stranded message delete threw', {
        session_id: input.sessionId,
        message_id: turn.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (!removed) {
      // Usually the box is busy again already (a fresh send opened a loop; its
      // step reads this message and answers it). The record stays open and the
      // next turn end re-asks.
      logger.warn('[forwarded-turns] stranded prompt could not be removed — not re-queued', {
        session_id: input.sessionId,
        message_id: turn.messageId,
        stranded_by: verdict.strandedBy,
      });
      continue;
    }
    const requeue = await deps.requeueStranded(input.sessionId, turn.messageId!);
    logger.warn('[forwarded-turns] stranded forwarded prompt re-queued', {
      session_id: input.sessionId,
      message_id: turn.messageId,
      stranded_by: verdict.strandedBy,
      outcome: requeue,
    });
    if (requeue === 'requeued') {
      out.requeued += 1;
      kicked = true;
    }
    // Whatever the row became, nothing is running THIS copy of the prompt:
    // close its turn authority so the session does not read as working on it.
    try {
      await deps.closeStrandedTurn(input.sessionId, turn.messageId!);
    } catch (err) {
      logger.warn('[forwarded-turns] could not close a stranded turn record', {
        session_id: input.sessionId,
        message_id: turn.messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (kicked) deps.kickDrain(input.sessionId);
  // Husk sweep: a cancelled prompt whose whole-message delete was refused
  // mid-turn left a PART-LESS user message at the runtime — invisible to the
  // model, but every client render shows it as an empty bubble. The turn just
  // ended, so the whole-message delete goes through now.
  for (const message of tip) {
    if (message.role !== 'user') continue;
    if (!message.partIds || message.partIds.length > 0) continue;
    if (tip.some((m) => m.role === 'assistant' && m.parentID === message.id)) continue;
    try {
      const removed = await deps.removeMessage(input.sessionId, message.id);
      if (removed) {
        logger.info('[forwarded-turns] part-less husk removed', {
          session_id: input.sessionId,
          message_id: message.id,
        });
      }
    } catch {
      /* next turn end retries */
    }
  }
  return out;
}
