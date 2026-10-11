/**
 * Where a queued prompt is: the one definition of an inbox row's delivery state.
 *
 * A `continue_session` row in `kortix.session_lifecycle_commands` encodes its
 * state in three places, because `status` is the generic command machine and
 * `result` is replaced wholesale by some transitions:
 *
 * | State         | `status`        | `result`                                  | Written by |
 * |---------------|-----------------|-------------------------------------------|------------|
 * | queued        | queued          | —                                         | enqueue, every requeue |
 * | held          | queued          | `held: true`                              | Stop (`holdInboxPrompts`), a held redelivery, a Stop-paused park |
 * | running       | running         | `delivery_started_at` once admitted       | the claim (`claimDueLifecycleCommands`) |
 * | forwarded     | succeeded       | `status: 'forwarded'`, `forwarded_message_id` | `markCommandForwarded` |
 * | stop-paused   | succeeded       | `status: 'forwarded'`, `stop_paused`, `held` | Stop on a forwarded row |
 * | delivered     | succeeded       | `status: 'delivered'`                     | the turn ledger (`confirmInboxPromptConsumed`), a noReply send |
 * | failed        | failed / dead_lettered | —                                  | `markCommandFailed`, redelivery exhaustion |
 *
 * Marks that must survive a wholesale `result` write live in `payload`:
 * `stopPausedOnDelivery` (Stop on a claimed row), `consumedOnDelivery`,
 * `remintOnDelivery`, `deliveryAttempt`, `runtimeUnreachableRetries`,
 * `releasedBatchId`.
 *
 * Every reader uses the predicates below, so the encoding is spelled once. The
 * user-visible view of the same row is `promptState` (projects/lib/session-prompt-view.ts).
 *
 * A stored state column was considered (R9.1) and not built: old and new API
 * tasks run side by side during every rollout, so a column only new code
 * writes would be wrong for the length of each deploy.
 */
import { sessionLifecycleCommands } from '@kortix/db';
import { type SQL, sql } from 'drizzle-orm';

const result = sessionLifecycleCommands.result;
const payload = sessionLifecycleCommands.payload;

/** The user's Stop holds the row out of the line. */
export const heldSql: SQL = sql`COALESCE(${result}->>'held', '') = 'true'`;
export const notHeldSql: SQL = sql`COALESCE(${result}->>'held', '') <> 'true'`;

/** Posted to the runtime; no turn has consumed it yet. */
export const forwardedSql: SQL = sql`${result}->>'status' = 'forwarded'`;

/** Posted to the runtime, consumed or not. */
export const onWireSql: SQL = sql`${result}->>'status' IN ('forwarded', 'delivered')`;

/** A forwarded row that a Stop paused. */
export const stopPausedSql: SQL = sql`COALESCE(${result}->>'stop_paused', '') = 'true'`;
export const notStopPausedSql: SQL = sql`COALESCE(${result}->>'stop_paused', '') <> 'true'`;

/** Stop arrived while the drain held the row (`holdInboxPrompts`). */
export const stopPausedOnDeliverySql: SQL = sql`COALESCE(${payload}->>'stopPausedOnDelivery', '') = 'true'`;

/** A row any of the three Stop marks covers. */
export const stoppedByUserSql: SQL = sql`(${stopPausedOnDeliverySql} OR ${heldSql} OR ${stopPausedSql})`;

type Marks = Record<string, unknown> | null | undefined;

export function isHeld(rowResult: Marks): boolean {
  return rowResult?.held === true;
}

export function isForwarded(rowResult: Marks): boolean {
  return rowResult?.status === 'forwarded';
}

export function isStopPaused(rowResult: Marks): boolean {
  return rowResult?.stop_paused === true;
}

export function isStopPausedOnDelivery(rowPayload: Marks): boolean {
  return rowPayload?.stopPausedOnDelivery === true;
}
