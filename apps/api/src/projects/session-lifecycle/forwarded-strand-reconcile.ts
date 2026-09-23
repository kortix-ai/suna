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
 *    answered. STRANDING IS VERSION-DEPENDENT: only a box running opencode
 *    <= 1.18.14 (every image baked before 2026-08-20, i.e. 1.17.11) exits on
 *    `lastUser.id < lastAssistant.id`. From 1.18.15 the exit test is
 *    `lastAssistant.parentID === lastUser.id`, so a low id alone no longer
 *    strands anything and this branch simply finds nothing to repair. The
 *    fleet runs both, so the repair stays.
 *    The transcript tells them apart exactly (`strandedPlacement`):
 *    a stranded one has a higher assistant parented on an OLDER user message,
 *    nothing parented on itself, and no step whose `time.created` proves it
 *    began after the prompt was persisted. Those are taken out of the
 *    transcript and re-queued, so the drain delivers them again — placed
 *    above everything — instead of leaving the user's message on screen with
 *    nothing ever under it. A candidate that is "newer" only by ID ORDER but
 *    was READ by the ended step (a lifted steer above an under-placed later
 *    sibling whose merged reply answered both — 2026-09-22) closes
 *    `completed` like an older row.
 *
 * This is the safety net behind the drain's own post-insert proof
 * (`executeQueuedContinue` → `verifyLivePlacement`): a verify read that failed
 * or a repair that could not run ends up here, a turn later.
 */

import { sessionLifecycleCommands, sessionSandboxes, sessionTurns } from '@kortix/db';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import {
  type StoredSandboxTurn,
  closeSandboxTurnByMessageId,
} from '../sandbox-turn-lifecycle';
import { sandboxRuntimeRequestHeaders } from '../sandbox-fetch';
import { wireIdTime } from '../wire-message-id';
import { drainSessionLifecycleQueue, resolveSessionOpencodeEndpoint } from './engine';
import { type PlacementTipMessage, isLaterTipMessage, openUserAbove, parsePlacementTip, strandedPlacement, tipIsBusy } from './forwarded-placement';
import { INBOX_HOLD_MS, isHeldInboxRow, isStopPausedInboxRow } from './inbox-rows';
import { sweepPendingHusks } from './husk-cleanup';
import { readUserStopRequestedAt, stoppedAfterDelivery } from './stop-mark';
import { promoteNextInboxRow, withNextDeliveryAttempt } from './store';
import { wireMessageIdMatches } from './wire-id-match';

const WORKSPACE = '/workspace';
/** The stranded prompt and the assistant that proves it both sit at the tip:
 *  the loop exits right after the step that missed it. A READ candidate does
 *  not — the tool work can run a dozen steps past the merged reply's first
 *  step, one assistant message each — so a candidate the tip does not hold is
 *  fetched by id (`readMessage`) rather than judged without its stamp. */
const TIP_LIMIT = 12;
const MAX_STRAND_REDELIVERIES = 3;

export interface ForwardedTurnReconciliation {
  closedOlder: number;
  candidates: number;
  stranded: number;
  /** Newer candidates the loop exited PAST: placed at the tip, never read,
   *  nothing running. Live incident 2026-08-20 (Essentia session d1b74954):
   *  a prompt forwarded at 12:59:05Z sat at the tip; the loop completed at
   *  12:59:17Z without reading it and its queued continuation was rejected —
   *  "not stranded" left it in place forever. */
  orphaned: number;
  requeued: number;
  /** Later, un-stranded siblings pulled back with a stranded row so the
   *  redelivery batch restores send order. */
  reordered: number;
  /** Newer candidates the ended step READ — a merged reply parented on a
   *  later, under-placed sibling, its step begun after the candidate was
   *  persisted — closed `completed` like an older row. Live incident
   *  2026-09-21/22 (sessions 4f345186, 17e3ad83, f0e9b423, 1548cb84): read
   *  as stranded by id order, such a prompt was deleted, re-queued and
   *  answered a second, paid time. */
  closedRead: number;
}

export interface StrandReconcileDeps {
  readOpenTurns: (sessionId: string) => Promise<StoredSandboxTurn[]>;
  closeOlderTurn: (sessionId: string, opencodeSessionId: string | null, messageId: string) => Promise<void>;
  closeStrandedTurn: (sessionId: string, messageId: string) => Promise<void>;
  readTip: (sessionId: string) => Promise<PlacementTipMessage[] | null>;
  /** One message by id, with its box stamps — for a candidate the tip read
   *  does not hold. `null` when the runtime cannot serve it. */
  readMessage: (sessionId: string, messageId: string) => Promise<PlacementTipMessage | null>;
  removeMessage: (sessionId: string, messageId: string) => Promise<boolean>;
  requeueStranded: (sessionId: string, messageId: string) => Promise<'requeued' | 'no_row' | 'exhausted' | 'not_open'>;
  kickDrain: (sessionId: string) => void;
  /** Delete the copies a Remove could only empty mid-loop (`husk-cleanup.ts`).
   *  Optional: absent, the turn end sweeps nothing. */
  sweepHusks?: (sessionId: string) => Promise<void>;
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
  async readMessage(sessionId, messageId) {
    const resolved = await resolveSessionOpencodeEndpoint(sessionId);
    if (!resolved) return null;
    // `GET /session/:id/message/:messageID` answers `{ info, parts }` — one
    // element of what the tip read pages, so the tip parser reads it as is.
    const url = `${resolved.endpoint.url}/session/${encodeURIComponent(resolved.opencodeSessionId)}/message/${encodeURIComponent(messageId)}?directory=${encodeURIComponent(WORKSPACE)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: sandboxRuntimeRequestHeaders(resolved.endpoint.headers),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const parsed = parsePlacementTip([await res.json().catch(() => null)]);
    const message = parsed?.[0];
    return message && message.id === messageId ? message : null;
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
  requeueStranded: (sessionId, messageId) => requeueStrandedPrompt(sessionId, messageId),
  sweepHusks: sweepHusksAtTurnEnd,
  kickDrain(sessionId) {
    void promoteNextInboxRow(sessionId)
      .then((key) => (key ? drainSessionLifecycleQueue({ idempotencyKey: key }) : null))
      .catch(() => undefined);
  },
};

/**
 * Put a stranded (or orphaned) forwarded prompt back in line, after its copy
 * was taken out of the transcript.
 *
 * It comes back HELD — visible, not due — when a person STOPPED the session:
 * the row is stop-paused or held (the Stop's own hold marked it), the box is
 * no longer running, or the Stop was recorded after this prompt went out
 * (`stop-mark.ts` — the acceptance relay closes a steer `delivered` before
 * any step reads it, and the hold does not mark a `delivered` row). The turn this relay closes is the one the Stop ended,
 * and a due-now requeue is a delivery the user did not ask for: measured on
 * 2026-09-22, `POST .../stop` during a live turn with a steer in flight let
 * this requeue ("redelivered after stranded placement") claim the prompt and
 * wake the stopped box about 45 s to 3 min later. A held row goes out on the
 * user's next send, "send now", or Resume — never on a timer.
 */
export async function requeueStrandedPrompt(
  sessionId: string,
  messageId: string,
): Promise<'requeued' | 'no_row' | 'exhausted' | 'not_open'> {
  const [row] = await db
    .select({
      commandId: sessionLifecycleCommands.commandId,
      status: sessionLifecycleCommands.status,
      payload: sessionLifecycleCommands.payload,
      result: sessionLifecycleCommands.result,
    })
    .from(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.sessionId, sessionId),
        eq(sessionLifecycleCommands.commandType, 'continue_session'),
        // Shared with every other reader — see `wire-id-match.ts`. Before
        // 2026-08-20 this matched the payload only, so a stranded prompt
        // delivered under an id only `result.forwarded_message_id` recorded
        // returned 'no_row' and was never redelivered.
        wireMessageIdMatches(messageId),
      ),
    )
    .orderBy(desc(sessionLifecycleCommands.createdAt))
    .limit(1);
  if (!row) return 'no_row';
  if (row.status !== 'succeeded') return 'not_open';
  const payload = (row.payload ?? {}) as { redeliveries?: unknown };
  const redeliveries = Number(payload.redeliveries ?? 0) + 1;
  if (redeliveries > MAX_STRAND_REDELIVERIES) return 'exhausted';
  const [box] = await db
    .select({ status: sessionSandboxes.status })
    .from(sessionSandboxes)
    .where(eq(sessionSandboxes.sessionId, sessionId))
    .limit(1);
  const held =
    isHeldInboxRow(row.result) ||
    isStopPausedInboxRow(row.result) ||
    (box !== undefined && box.status !== 'active') ||
    stoppedAfterDelivery(
      await readUserStopRequestedAt(sessionId),
      (row.result as { forwarded_at?: unknown } | null)?.forwarded_at,
    );
  await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
      availableAt: held ? new Date(Date.now() + INBOX_HOLD_MS) : new Date(),
      attempts: 0,
      lockedBy: null,
      lockedUntil: null,
      lastError: 'redelivered after stranded placement',
      payload: withNextDeliveryAttempt(
        sql`${sessionLifecycleCommands.payload} || ${JSON.stringify({ redeliveries, remintOnDelivery: true })}::jsonb`,
      ),
      // Every delivery marker goes: the row is back in line as if never sent.
      // The hold stays — it is the user's, not the delivery's.
      result: held
        ? { redelivered_from: 'stranded_placement', held: true }
        : { redelivered_from: 'stranded_placement' },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionLifecycleCommands.commandId, row.commandId),
        eq(sessionLifecycleCommands.status, 'succeeded'),
      ),
    );
  return 'requeued';
}

/**
 * Run at `turn-stream` `end` for `sessionId`, where `endedMessageId` is the
 * user message the final assistant answered (`M`). No-op when the relay did
 * not name one, or when no forwarded turn is open.
 */
export async function reconcileForwardedTurnsAtEnd(
  input: { sessionId: string; opencodeSessionId?: string | null; endedMessageId?: string | null },
  deps: StrandReconcileDeps = liveDeps,
): Promise<ForwardedTurnReconciliation> {
  try {
    return await reconcileForwardedTurns(input, deps);
  } finally {
    // EVERY turn end, whatever the reconciliation found or skipped: the end is
    // the moment the loop is idle, and the only moment OpenCode lets a whole
    // message go. The early returns above used to skip the husk sweep in
    // exactly the common case — a Remove during a tool loop leaves no newer
    // forwarded candidate at the loop's own end.
    if (deps.sweepHusks) {
      await deps.sweepHusks(input.sessionId).catch((err) =>
        logger.warn('[forwarded-turns] husk sweep failed', {
          session_id: input.sessionId,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }
}

/** A busy loop can outlive the `end` relay by a moment: ask twice more. */
async function sweepHusksAtTurnEnd(sessionId: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { pending } = await sweepPendingHusks(sessionId);
    if (pending === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
}

async function reconcileForwardedTurns(
  input: { sessionId: string; opencodeSessionId?: string | null; endedMessageId?: string | null },
  deps: StrandReconcileDeps,
): Promise<ForwardedTurnReconciliation> {
  const out: ForwardedTurnReconciliation = { closedOlder: 0, candidates: 0, stranded: 0, orphaned: 0, requeued: 0, reordered: 0, closedRead: 0 };
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
      // `time.created`-first, never a raw string compare on the ids — see
      // `isLaterTipMessage`. Assistant messages are minted by the box, so the
      // two agree in the common case, but a transcript that mixes box-minted
      // and placement-minted ids has no such guarantee.
      if (isLaterTipMessage(m, newest)) newest = m;
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
  // The verdict needs the candidate's OWN message — its `time.created` is
  // what tells a read prompt from a stranded one — and the tip is only the
  // newest TIP_LIMIT messages. A genuine strand is always on it (the loop
  // exits right after the step that missed it), but a READ candidate is not:
  // a tool loop that ran a dozen steps past the merged reply's first step
  // pushed it off, one assistant message per step, every one of them a
  // higher id parented on the under-placed sibling below it — the strand
  // signature by id order, with no stamp left to contradict it. Fetch the
  // message by id; judged without it, the candidate would be deleted and
  // re-queued exactly as before the stamp rule existed. A candidate the
  // runtime cannot serve stays untouched: the reaper's own redelivery runs
  // through the drain's answered check with the copy still in the
  // transcript, so a genuine never-ran prompt still comes back — later, but
  // never twice.
  const verdictTip: PlacementTipMessage[] = [...tip];
  const unheld = new Set<string>();
  for (const turn of newer) {
    const messageId = turn.messageId!;
    if (verdictTip.some((m) => m.id === messageId)) continue;
    let own: PlacementTipMessage | null = null;
    try {
      own = await deps.readMessage(input.sessionId, messageId);
    } catch (err) {
      logger.warn('[forwarded-turns] candidate message read threw', {
        session_id: input.sessionId,
        message_id: messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (own) verdictTip.push(own);
    else unheld.add(messageId);
  }
  const verdicts = newer.map((turn) => ({ turn, verdict: strandedPlacement(verdictTip, turn.messageId!) }));
  // The strand verdict has a blind spot the loop's exit exposes: a candidate
  // placed correctly AT THE TIP (no assistant above it, so not "stranded")
  // that the ended loop simply never read. With the tip's newest assistant
  // CLOSED, nothing will ever answer it — OpenCode's queued continuation for
  // it can be rejected at turn end (observed live 2026-08-20, Essentia
  // session d1b74954: "Bro no fucking idea whats happening here lol",
  // delivered 12:59:05Z, loop completed 12:59:17Z past it, queue request
  // rejected, prompt swallowed). Requeue it exactly like a stranded row.
  // Guards, in order: the row must be ACCEPTED (`active` — a `delivering`
  // row is a send still on the wire), the message must actually be on the
  // tip, and the tip must not be mid-step (an open newest assistant is a
  // fresh turn that will read it).
  for (const { turn, verdict } of verdicts) {
    if (unheld.has(turn.messageId!)) {
      logger.info('[forwarded-turns] candidate is off the tip and could not be fetched — left to the reaper', {
        session_id: input.sessionId,
        message_id: turn.messageId,
      });
      continue;
    }
    // A candidate the ended step READ. "Newer" was decided by ID ORDER
    // (`endedAt`), and a steered prompt LIFTED to the box clock sorts above a
    // later sibling that was UNDER-PLACED at its client id — so the one merged
    // reply, parented on that sibling, is by id a higher assistant with an
    // older parent: the strand signature. The box's `time.created` stamps say
    // what actually happened: the reply's step began after this prompt was
    // persisted, so it was in the input and the reply answered it. Live
    // 2026-09-21/22, three of three steer runs (sessions 4f345186, 17e3ad83,
    // f0e9b423, 1548cb84): read as stranded, the lifted prompt was deleted
    // from the transcript, re-queued (`redeliveries = 1`, "redelivered after
    // stranded placement"), its ledger row closed `abandoned`, and the model
    // ran a second, paid turn for it — its answer on screen twice. A read
    // candidate is handled exactly like an OLDER row: when its reader has
    // completed, the step that just ended answered it, so its ledger row
    // closes `completed` now; while the reader is still open (a fresh turn
    // already running) the row stays open and that turn's end closes it.
    // Never removed, never re-queued, never closed `abandoned`.
    if (!verdict.answered && verdict.readBy !== null) {
      if (!verdict.readCompleted) {
        logger.info('[forwarded-turns] candidate read by a step still open — left to that turn\'s end', {
          session_id: input.sessionId,
          message_id: turn.messageId,
          read_by: verdict.readBy,
        });
        continue;
      }
      try {
        await deps.closeOlderTurn(input.sessionId, turn.opencodeSessionId, turn.messageId!);
        out.closedRead += 1;
        logger.info('[forwarded-turns] candidate was read by the ended step — closed completed', {
          session_id: input.sessionId,
          message_id: turn.messageId,
          read_by: verdict.readBy,
        });
      } catch (err) {
        logger.warn('[forwarded-turns] could not close a read forwarded turn', {
          session_id: input.sessionId,
          message_id: turn.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    const orphanedAtTip =
      !verdict.stranded &&
      !verdict.answered &&
      turn.state === 'active' &&
      tip.some((m) => m.role === 'user' && m.id === turn.messageId) &&
      !tipIsBusy(tip);
    if (!verdict.stranded && !orphanedAtTip) continue;
    if (verdict.stranded) out.stranded += 1;
    else out.orphaned += 1;
    // The tip, not just the ledger candidates: ANY placed, unanswered user
    // message above covers this one — a direct send included.
    if (openUserAbove(verdictTip, turn.messageId!)) {
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

