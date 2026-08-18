import { sessionLifecycleCommands } from '@kortix/db';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import type { SessionTurnEndReason } from '../sandbox-turn-lifecycle';
import { INBOX_HOLD_MS } from './inbox-rows';
import type { QueuedContinueSessionPayload, SessionLifecycleCommandRow } from './store';

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
          or(
            sql`${sessionLifecycleCommands.payload}->>'wireMessageId' = ${wireMessageId}`,
            sql`${sessionLifecycleCommands.payload}->>'redeliveredMessageId' = ${wireMessageId}`,
          ),
        ),
      )
      .orderBy(desc(sessionLifecycleCommands.createdAt))
      .limit(1);
    return row ?? null;
  },
  async requeue({ commandId, redeliveries, lastError, turnToken, held }) {
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
        payload: sql`${sessionLifecycleCommands.payload} || ${JSON.stringify({ redeliveries })}::jsonb`,
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
 */
export async function requeueAbandonedPrompt(
  input: {
    sessionId: string;
    wireMessageId: string | null;
    turnToken: string;
    endReason: SessionTurnEndReason;
    hold?: boolean;
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
    ...(input.hold ? { held: true } : {}),
  });
  return 'requeued';
}
