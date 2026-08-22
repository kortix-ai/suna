import { sessionLifecycleCommands } from '@kortix/db';
import { type SQL, or, sql } from 'drizzle-orm';

/**
 * "Which inbox row does this wire message id name?" — ONE predicate, one place.
 *
 * A `continue_session` row can carry the id it went out under in three
 * different columns, written by three different steps:
 *
 *  - `payload.wireMessageId` — the id the CLIENT minted when the user pressed
 *    Enter, persisted at create (`store.ts`).
 *  - `payload.redeliveredMessageId` — the id a RE-MINT placed it under, when
 *    the row waited behind a live turn or came back from a strand
 *    (`engine.ts`'s `remintWireMessageId`).
 *  - `result.forwarded_message_id` — the id the delivery ACTUALLY used,
 *    written by `markCommandForwarded` (`store.ts:518`) precisely so a reader
 *    does not have to re-derive which of the two payload ids the attempt
 *    picked.
 *
 * The third is not redundant. `markCommandForwarded` records what went on the
 * wire; the payload records what was intended. A row whose
 * `forwarded_message_id` differs from BOTH payload ids is unreachable through
 * the payload alone — and until this module existed, three of the four readers
 * matched on the payload only:
 *
 *   consumption.ts (`confirm`)           payload only -> row never closed,
 *                                                        strip reads
 *                                                        "delivering" forever
 *   redelivery.ts (`findPromptByWireId`) payload only -> a turn that never ran
 *                                                        is never re-queued
 *   forwarded-strand-reconcile.ts        payload only -> a stranded prompt is
 *     (`requeueStranded`)                                 never redelivered
 *   cancel-forwarded.ts                  all three    -> found it
 *
 * `consumption.ts` asserted in a comment that its predicate and
 * `redelivery.ts`'s "can never disagree about which row a wire id names".
 * They could not disagree with each other — they were identical — but both
 * disagreed with `cancel-forwarded.ts`. The assertion is now structural:
 * every reader calls this function, so a fourth id column added later lands
 * at every call site at once.
 *
 * Callers add their own scope (session, command type, status) — this is only
 * the id half of the `where`.
 */
export function wireMessageIdMatches(messageId: string): SQL | undefined {
  return or(
    sql`${sessionLifecycleCommands.payload}->>'wireMessageId' = ${messageId}`,
    sql`${sessionLifecycleCommands.payload}->>'redeliveredMessageId' = ${messageId}`,
    sql`${sessionLifecycleCommands.result}->>'forwarded_message_id' = ${messageId}`,
  );
}
