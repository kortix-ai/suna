import { sessionLifecycleCommands } from '@kortix/db';
import { and, desc, eq, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import {
  type PromptTurnRecord,
  type SessionTurnEndReason,
  isRequestedStopName,
  readNewestPromptTurn,
} from '../session-turn-ledger';
import type { PlacementTipMessage } from './forwarded-placement';
import { INBOX_HOLD_MS, isStopPausedInboxRow } from './inbox-rows';
import {
  type QueuedContinueSessionPayload,
  type SessionLifecycleCommandRow,
  withNextDeliveryAttempt,
} from './store';
import { wireMessageIdMatches } from './wire-id-match';

/**
 * How many times one prompt may be given back to the inbox.
 *
 * A redelivery is only ever triggered by PROOF that a turn never ran, so the
 * cap is not a correctness bound — it is a blast-radius bound. A box that is
 * genuinely broken would otherwise take one prompt around this loop for the
 * lifetime of the session, and each pass costs a real delivery attempt.
 */
export const MAX_PROMPT_REDELIVERIES = 3;

/**
 * The only endings that mean "this prompt never ran".
 *
 * `completed` and `failed` are the daemon saying the turn RAN — it finished, or
 * it errored terminally. A `delivering` record can survive both of those: the
 * acceptance write is a separate statement, and when it loses (the documented
 * `[turn-lifecycle] acceptance persistence failed … reaper will reconcile
 * delivery` path) the record still says `delivering` while OpenCode answers the
 * prompt to the end. Requeueing on those reasons re-runs the user's message and
 * spends a second real LLM turn on it, which is the exact loss redelivery
 * exists to prevent — so the reason is a gate, not a label.
 */
export const PROMPT_NEVER_RAN_END_REASONS = new Set<SessionTurnEndReason>([
  'abandoned',
  'runtime_gone',
  'unknown',
]);

export type PromptRedelivery =
  | 'requeued'
  /** The end reason proves the turn RAN — nothing to give back. */
  | 'ran'
  /** The turn was not an inbox prompt (a channel/trigger delivery, or a
   *  browser prompt from before the inbox existed). */
  | 'no_prompt'
  /** `MAX_PROMPT_REDELIVERIES` reached; the command is dead-lettered. */
  | 'exhausted'
  /** The command is not in a state that can be requeued — something else
   *  already owns it. */
  | 'already_settled';

export interface RedeliveryDeps {
  findPromptByWireId: (
    sessionId: string,
    wireMessageId: string,
  ) => Promise<SessionLifecycleCommandRow | null>;
  requeue: (input: {
    commandId: string;
    redeliveries: number;
    lastError: string;
    turnToken: string;
    /** Come back VISIBLE but not due — see `requeueAbandonedPrompt`'s `hold`. */
    held?: boolean;
    /** See `requeueAbandonedPrompt`'s `resumable`. */
    resumable: boolean;
  }) => Promise<void>;
  deadLetter: (input: {
    commandId: string;
    redeliveries: number;
    lastError: string;
  }) => Promise<void>;
}

const liveDeps: RedeliveryDeps = {
  async findPromptByWireId(sessionId, wireMessageId) {
    const [row] = await db
      .select()
      .from(sessionLifecycleCommands)
      .where(
        and(
          eq(sessionLifecycleCommands.sessionId, sessionId),
          eq(sessionLifecycleCommands.commandType, 'continue_session'),
          // Shared with every other reader — see `wire-id-match.ts`. Before
          // 2026-08-20 this matched the payload only, so a turn that provably
          // never ran was never re-queued when the delivery went out under an
          // id only `result.forwarded_message_id` recorded.
          wireMessageIdMatches(wireMessageId),
        ),
      )
      .orderBy(desc(sessionLifecycleCommands.createdAt))
      .limit(1);
    return row ?? null;
  },
  async requeue({ commandId, redeliveries, lastError, turnToken, held, resumable }) {
    await db
      .update(sessionLifecycleCommands)
      .set({
        status: 'queued',
        // A HELD row is durable and visible but not due: the box it belonged to
        // was just parked, and a due-now row would have the next drain tick
        // wake it straight back up and bill the account for the resumed
        // compute. The user's next send — or "send now" on the row — releases
        // it, exactly as the composer's local pause always behaved.
        availableAt: held ? new Date(Date.now() + INBOX_HOLD_MS) : new Date(),
        // A redelivery starts a FRESH delivery budget. The previous attempts
        // were spent on a turn that provably never ran, so charging them to
        // the retry cap would dead-letter a prompt nothing has yet failed to
        // answer.
        attempts: 0,
        lockedBy: null,
        lockedUntil: null,
        lastError,
        // The row already went out once, so the next POST needs a key the
        // proxy's 10-minute dedupe claim cannot swallow — see
        // `withNextDeliveryAttempt`.
        // `resumeIfInterrupted` is written on EVERY requeue, so a later
        // requeue by a path that proves nothing clears an earlier one's mark.
        payload: withNextDeliveryAttempt(
          sql`${sessionLifecycleCommands.payload} || ${JSON.stringify({ redeliveries, resumeIfInterrupted: resumable })}::jsonb`,
        ),
        result: held
          ? { redelivered_from: turnToken, held: true }
          : { redelivered_from: turnToken },
        updatedAt: new Date(),
      })
      // `status = 'succeeded'` in the predicate, not just in the caller's
      // read: two reaper passes can observe the same abandoned turn, and the
      // second must not requeue a row the first already put back on the wire.
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, commandId),
          eq(sessionLifecycleCommands.status, 'succeeded'),
        ),
      );
  },
  async deadLetter({ commandId, redeliveries, lastError }) {
    await db
      .update(sessionLifecycleCommands)
      .set({
        status: 'dead_lettered',
        // AND IT IS NO LONGER ON THE WIRE. Every reader of "is this row at
        // OpenCode" keys on `result.status`, so a dead-lettered row that kept
        // `forwarded` read `delivering` for ever: filtered out of the composer's
        // queue strip, counted as live work by `countLiveInboxPrompts`, and
        // outside `reconcileForwardedPrompts`' scan — no retry, no remove, and
        // nothing that could ever close it. `- 'status'` rather than a replaced
        // result, because `forwarded_at`/`forwarded_message_id` are still the
        // only record of what this row did.
        result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb) - 'status'`,
        lockedBy: null,
        lockedUntil: null,
        lastError,
        payload: sql`${sessionLifecycleCommands.payload} || ${JSON.stringify({ redeliveries })}::jsonb`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(sessionLifecycleCommands.commandId, commandId),
          eq(sessionLifecycleCommands.status, 'succeeded'),
        ),
      );
  },
};

/**
 * A turn that was PROVEN never to run gives its prompt back to the inbox.
 *
 * Two independent conditions have to hold, and BOTH are checked here rather
 * than trusted from the caller:
 *
 *  - the WIRE MESSAGE ID matches a command. `beginSandboxTurn` recorded it from
 *    the delivery body (`extractTurnIdentity`), so the id names one delivery of
 *    one command and nothing looser can be requeued;
 *  - the end reason is one that means the turn NEVER RAN
 *    (`PROMPT_NEVER_RAN_END_REASONS`). A `delivering` record alone does not
 *    prove that — it only proves the acceptance write never landed.
 *
 * `endReason` is carried into `last_error` so the reason a prompt came back is
 * readable from the row alone.
 *
 * `hold` is for the caller that just PARKED the box (`applyStoppedState`): the
 * prompt comes back visible but not due, so the repair cannot resurrect the
 * runtime the stop just shut down.
 *
 * `resumable` is for a caller that PROVED the runtime under this turn is gone
 * (a provider stop, a restart) and that nobody asked for it to end. The row
 * then carries `resumeIfInterrupted`, and the drain continues a turn the loss
 * cut short instead of dropping its prompt as answered (`findInterruptedTurn`).
 * A Stop-paused row never carries it: a person stopped that turn.
 */
export async function requeueAbandonedPrompt(
  input: {
    sessionId: string;
    wireMessageId: string | null;
    turnToken: string;
    endReason: SessionTurnEndReason;
    hold?: boolean;
    resumable?: boolean;
  },
  deps: RedeliveryDeps = liveDeps,
): Promise<PromptRedelivery> {
  if (!input.wireMessageId) return 'no_prompt';
  if (!PROMPT_NEVER_RAN_END_REASONS.has(input.endReason)) return 'ran';

  const row = await deps.findPromptByWireId(input.sessionId, input.wireMessageId);
  if (!row) return 'no_prompt';
  // Only a command the drain reported DELIVERED can come back. Anything else
  // is already owned by another path (queued for its first attempt, running on
  // this pass, or given up on), and requeueing it would double-deliver.
  if (row.status !== 'succeeded') return 'already_settled';

  const payload = (row.payload ?? {}) as unknown as QueuedContinueSessionPayload;
  const redeliveries = Number(payload.redeliveries ?? 0) + 1;
  const lastError = `redelivered after ${input.endReason}`;

  // A STOP-PAUSED row is the prompt the user pressed Stop to get ahead of.
  // Stop aborts the running turn, OpenCode drops the in-memory queue with it,
  // and the reaper then sees a persisted message nothing will ever answer —
  // which is a genuine abandonment, so this function is right to act. What it
  // must not do is deliver it: coming back DUE would put the stopped prompt
  // back on the wire one reaper pass after the abort. It comes back HELD
  // instead — visible, and released by the user's next send or "send now".
  const stopPaused = isStopPausedInboxRow(row.result);

  if (redeliveries > MAX_PROMPT_REDELIVERIES) {
    await deps.deadLetter({
      commandId: row.commandId,
      redeliveries: redeliveries - 1,
      lastError: `prompt redelivery exhausted after ${input.endReason}`,
    });
    // Same alerting posture as the drain's dead-letter: a prompt being
    // abandoned is a user-visible loss, so it is an error, not a warn.
    logger.error('[session-lifecycle] prompt redelivery exhausted', {
      command_id: row.commandId,
      session_id: row.sessionId,
      project_id: row.projectId,
      account_id: row.accountId,
      turn_token: input.turnToken,
      end_reason: input.endReason,
      redeliveries: redeliveries - 1,
    });
    return 'exhausted';
  }

  await deps.requeue({
    commandId: row.commandId,
    redeliveries,
    lastError,
    turnToken: input.turnToken,
    ...(input.hold || stopPaused ? { held: true } : {}),
    resumable: !!input.resumable && !stopPaused,
  });
  return 'requeued';
}

/** A turn a runtime loss cut short, as its continuation names it. */
export interface InterruptedTurn {
  turnToken: string;
  endedAt: Date | null;
  /** The ledger's stated cause, shown to the agent. Null when none was named. */
  cause: string | null;
}

/**
 * The turn this prompt started that a runtime loss cut short, or null.
 *
 * The drain asks this only for a redelivered row marked `resumeIfInterrupted`
 * whose transcript already holds a reply. Every condition below must hold:
 *  - the newest ledger turn over the prompt's wire ids ended `runtime_gone`,
 *    and nobody asked for the stop (`UserStop`, `QueueInterrupt`);
 *  - the transcript holds that turn's user message, and no later delivery of
 *    this prompt landed after it. A later one owns the work: a continuation
 *    already on the box sends no second one (the retry after a lost answer);
 *  - the turn's newest reply has no `time.completed` (`turnTail`: an
 *    automatic compaction mid-turn re-parents the later steps). A completed
 *    reply means the turn finished and only its end frame was lost, and a
 *    second run would repeat its side effects (2026-09-17).
 *
 * VERIFIED for OpenCode on a box whose disk survives the stop: the open
 * assistant message stays in its store with no `time.completed`
 * (`runtime-restart-recovery.ts`). pi keeps its transcript in memory and
 * persists it at turn end, so after a hard stop the cut-off reply is not on
 * the box and the prompt reads unanswered: it is redelivered whole, as before.
 * ponytail: a box that dies BETWEEN two steps leaves a completed newest reply
 * and is dropped as answered; read the reply's `finish` if that shows up.
 */
export async function findInterruptedTurn(
  sessionId: string,
  deliveredIds: readonly string[],
  tip: readonly PlacementTipMessage[],
  readTurn: (sessionId: string, ids: readonly string[]) => Promise<PromptTurnRecord | null> = readNewestPromptTurn,
): Promise<InterruptedTurn | null> {
  const turn = await readTurn(sessionId, deliveredIds);
  if (!turn || turn.state !== 'ended' || turn.endReason !== 'runtime_gone') return null;
  if (isRequestedStopName(turn.endError?.name)) return null;
  const at = tip.findIndex((message) => message.id === turn.messageId);
  if (at < 0) return null;
  const later = tip.slice(at + 1);
  if (later.some((message) => message.role === 'user' && deliveredIds.includes(message.id))) return null;
  const reply = turnTail(later).filter((message) => message.role === 'assistant').at(-1);
  if (typeof reply?.completed === 'number') return null;
  return { turnToken: turn.turnToken, endedAt: turn.endedAt, cause: turn.endError?.message ?? null };
}

/**
 * The messages a turn wrote after its prompt: everything before the next user
 * message the turn did not write itself. An automatic compaction writes two
 * user messages inside a running turn (OpenCode `session/compaction.ts`): its
 * marker, and after the summary either a synthetic "continue" or a replay of
 * the prompt. The steps after them are parented on that second message, not
 * on the prompt.
 */
function turnTail(later: readonly PlacementTipMessage[]): PlacementTipMessage[] {
  const tail: PlacementTipMessage[] = [];
  let compacting = false;
  for (const message of later) {
    if (message.role === 'user') {
      if (message.autoCompaction) compacting = true;
      else if (compacting) compacting = false;
      else break;
    }
    tail.push(message);
  }
  return tail;
}

/** What a continuation tells the agent. One text for every continuation path. */
export function interruptedTurnContinuationText(turn: Pick<InterruptedTurn, 'endedAt' | 'cause'>): string {
  const at = turn.endedAt ? ` at ${turn.endedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC` : '';
  const cause = turn.cause ?? 'The runtime that ran it stopped.';
  return `[auto-recovery] The previous turn was interrupted${at}. ${cause} ` +
    'Continue from where you left off. Do not repeat steps that already completed.';
}
