import { sessionLifecycleCommands } from '@kortix/db';
import { and, asc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import type { SessionLifecycleCommandRow } from './store';

/**
 * The inbox's row operations — everything `GET/DELETE/retry/hold …/prompts`
 * does to `kortix.session_lifecycle_commands`.
 *
 * They live here rather than inline in `routes/r8.ts` for one reason: every one
 * of them has to carry the INBOX SCOPE, and a scope that is re-typed at four
 * call sites is a scope that will be forgotten at one of them. It already was:
 * `continue_session` is also how triggers, Slack and approval-resume deliver,
 * and those rows have no `clientMessageId`. Listing them put an automation's
 * internal prompt in the user's composer queue, and the row's remove button
 * destroyed a scheduled delivery the user never made.
 */

/** A `continue_session` row the USER created through the composer. */
function inboxScope(sessionId: string) {
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
 * anything new, or pressing "send now" on a row. The horizon exists only so a
 * held row cannot outlive a browser that never comes back: a day later the
 * queue drains rather than holding a prompt for ever.
 */
export const INBOX_HOLD_MS = 24 * 60 * 60 * 1000;

export async function listInboxPrompts(
  sessionId: string,
  limit: number,
): Promise<SessionLifecycleCommandRow[]> {
  // `succeeded` is EXCLUDED, not filtered by the caller: a delivered prompt is
  // in the transcript, and listing it would render it twice.
  return db
    .select()
    .from(sessionLifecycleCommands)
    .where(and(inboxScope(sessionId), ne(sessionLifecycleCommands.status, 'succeeded')))
    .orderBy(asc(sessionLifecycleCommands.createdAt))
    .limit(limit);
}

export type InboxPromptDeletion =
  /** Carries the row it removed: the DELETE is the only place the full prompt
   *  body still exists, and the client's undo has to re-create it exactly. */
  | { outcome: 'deleted'; row: SessionLifecycleCommandRow }
  | { outcome: 'delivering' }
  | { outcome: 'missing' };

export async function deleteInboxPrompt(
  sessionId: string,
  promptId: string,
): Promise<InboxPromptDeletion> {
  const deleted = await db
    .delete(sessionLifecycleCommands)
    .where(
      and(
        eq(sessionLifecycleCommands.commandId, promptId),
        inboxScope(sessionId),
        inArray(sessionLifecycleCommands.status, ['queued', 'failed', 'dead_lettered']),
      ),
    )
    .returning();
  if (deleted[0]) return { outcome: 'deleted', row: deleted[0] };

  // Separate the two "no row was removed" cases: a claimed row is on the wire
  // and cancelling it would be a lie, which is a 409, not a 404.
  const [existing] = await db
    .select({ status: sessionLifecycleCommands.status })
    .from(sessionLifecycleCommands)
    .where(and(eq(sessionLifecycleCommands.commandId, promptId), inboxScope(sessionId)))
    .limit(1);
  return existing?.status === 'running' ? { outcome: 'delivering' } : { outcome: 'missing' };
}

/**
 * Put one row at the front of the queue and make it due NOW.
 *
 * This is both "retry" and "send now" — one primitive, because they are one
 * intent: the user pointed at a row and asked for THAT message. `promoted`
 * is what the admission gate reads to let it past the ordering rule
 * (`older_prompt_pending`); turn authority still gates it, because delivering
 * into a live turn aborts the turn in progress no matter who asked.
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
  const [row] = await db
    .update(sessionLifecycleCommands)
    .set({
      status: 'queued',
      availableAt: new Date(),
      attempts: 0,
      lastError: null,
      lockedBy: null,
      lockedUntil: null,
      // Wholesale: this clears `admission_reason`, `admission_refusals` and
      // `held` along with the previous failure, which is exactly what "send
      // this one now" means for what the row DISPLAYS.
      result: { promoted: true },
      payload: sql`${sessionLifecycleCommands.payload} || '{"remintOnDelivery": true}'::jsonb`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sessionLifecycleCommands.commandId, promptId),
        inboxScope(sessionId),
        // `running` is excluded: it is already on the wire.
        inArray(sessionLifecycleCommands.status, ['queued', 'failed', 'dead_lettered']),
      ),
    )
    .returning();
  if (!row) return null;
  // The same rule the browser queue always had: an explicit dispatch lifts the
  // hold for the WHOLE queue, and the rest drains at the next boundary.
  await releaseInboxHold(sessionId);
  return row;
}

/**
 * Hold — or release — every queued prompt of one session.
 *
 * The Stop button's promise is "stop doing things, and that includes the
 * queue". With the queue in Postgres that promise has to be written there too:
 * pausing a browser-local drain leaves the server free to admit the prompt the
 * user pressed Stop to get ahead of, roughly one scheduler tick later.
 */
export async function holdInboxPrompts(sessionId: string, held: boolean): Promise<number> {
  const rows = held
    ? await db
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
        .returning({ commandId: sessionLifecycleCommands.commandId })
    : await db
        .update(sessionLifecycleCommands)
        .set({
          availableAt: new Date(),
          result: sql`COALESCE(${sessionLifecycleCommands.result}, '{}'::jsonb) - 'held'`,
          updatedAt: new Date(),
        })
        .where(
          and(
            inboxScope(sessionId),
            eq(sessionLifecycleCommands.status, 'queued'),
            sql`COALESCE(${sessionLifecycleCommands.result}->>'held', '') = 'true'`,
          ),
        )
        .returning({ commandId: sessionLifecycleCommands.commandId });
  return rows.length;
}

/** Release without asserting anything about whether a hold was set. */
export function releaseInboxHold(sessionId: string): Promise<number> {
  return holdInboxPrompts(sessionId, false);
}

/** Is this row deliberately held out of the drain? */
export function isHeldInboxRow(result: unknown): boolean {
  return (result as { held?: unknown } | null)?.held === true;
}
