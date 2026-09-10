/**
 * Promote the session's next queued inbox row, then kick its targeted drain —
 * but only ONCE THE SETTLE WINDOW HAS ELAPSED.
 *
 * Both halves live here because they are one decision, not two.
 * `promoteNextInboxRow` makes the row due `INBOX_TURN_SETTLE_MS` from now
 * (store.ts), and `drainSessionLifecycleQueue` claims by `idempotencyKey` AND
 * `availableAt <= now` (engine.ts `claimDueLifecycleCommands`). A kick fired in
 * the same tick as the promotion therefore claims ZERO rows, and nothing else
 * re-kicks one specific row — so the delay and the kick must never be separated
 * again. Every caller that promotes-then-kicks goes through this function; that
 * is what `settled-drain-kick.test.ts` pins.
 *
 * A lost kick is not fatal, only slower and less certain. The trigger scheduler
 * runs `drainSessionLifecycleQueue({ limit: 10 })` UNCONDITIONALLY on every
 * tick (`lib/triggers.ts:1323` — the `isLeader()` call above it gates a stall
 * log, not the drain), and the tick cadence is `triggerSchedulerIntervalMs()`,
 * which defaults to 1_000ms (`lib/triggers.ts:414-417`, `config.ts:665`; no
 * `KORTIX_TRIGGER_SCHEDULER_INTERVAL_MS` override is set in any `apps/api/.env*`).
 * So the floor is ~1s, not a minute. We still schedule the targeted kick rather
 * than lean on that floor: the fallback is a fleet-wide 10-row poll this
 * session competes in, while the targeted kick deterministically claims this
 * row AND its session's queued siblings as one delivery batch.
 *
 * `drain` is injected rather than imported so this module never pulls in
 * `engine` (which imports `store`, which this imports).
 */

import { INBOX_TURN_SETTLE_MS, promoteNextInboxRow } from './store';

export interface SettledDrainKickDeps {
  /** The targeted drain — `drainSessionLifecycleQueue` in production. */
  drain: (input: { idempotencyKey: string }) => Promise<unknown>;
  /** Test seam. Defaults to the real durable promotion. */
  promote?: (sessionId: string) => Promise<string | null>;
  /** Test seam. Defaults to `setTimeout`. */
  schedule?: (fn: () => void, ms: number) => unknown;
  /** Called when the kicked drain rejects. Absent = swallow. */
  onError?: (error: unknown, idempotencyKey: string) => void;
}

/**
 * Returns the promoted row's idempotency key, or `null` when the session had
 * nothing admissible queued. Resolves as soon as the PROMOTION is durable —
 * the kick it schedules is deliberately not awaited.
 */
export async function promoteAndKickNextInboxRow(
  sessionId: string,
  deps: SettledDrainKickDeps,
): Promise<string | null> {
  const promote = deps.promote ?? promoteNextInboxRow;
  const schedule = deps.schedule ?? setTimeout;
  const idempotencyKey = await promote(sessionId);
  if (!idempotencyKey) return null;
  schedule(() => {
    void Promise.resolve()
      .then(() => deps.drain({ idempotencyKey }))
      .catch((error) => deps.onError?.(error, idempotencyKey));
  }, INBOX_TURN_SETTLE_MS);
  return idempotencyKey;
}
