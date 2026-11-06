import type { AbortSettlement } from '@kortix/sdk/react';

/**
 * The order of one Stop, as data, so a test can count the requests.
 *
 * One Stop sends ONE inbox hold and ONE abort.
 *
 * - With a mounted `useSession` (`sdkCancel`), the SDK owns the whole stop:
 *   `cancelSessionTurn` → `stopWithReceipt` holds the inbox (bounded), paints
 *   the optimistic abort, and then aborts. The host must not hold first: that
 *   was a second hold request and up to 2 × 1.5 s before the abort left.
 * - Without it (a child-session mount), the host does the same pairing
 *   itself: hold, bounded by `holdDeadlineMs`, then the raw abort.
 *
 * A refused hold (the viewer may not stop this turn) sends no abort: the abort
 * would be refused for the same reason.
 */
export type StopOutcome =
  | { kind: 'cancelled'; settlement: AbortSettlement }
  | { kind: 'refused'; message: string };

export interface StopSequenceDeps {
  /** `useSession().cancel` when the session hook is mounted. */
  sdkCancel?: () => Promise<AbortSettlement>;
  /** Fallback path only: hold the server-side prompt inbox. */
  holdInbox: () => Promise<unknown>;
  /** Fallback path only: the raw abort, settled (never rejects). */
  fallbackCancel: () => Promise<AbortSettlement>;
  /** Fallback path only: paint "Interrupted" and clear the send receipt. */
  paintOptimisticAbort: () => void;
  /** The refusal text for a hold error, or null when it is not a refusal. */
  refusalOf: (error: unknown) => string | null;
  /** A hold that failed for any other reason: the queue is not paused. */
  onHoldFailed: (error: unknown) => void;
  holdDeadlineMs: number;
}

export async function runStopSequence(deps: StopSequenceDeps): Promise<StopOutcome> {
  if (deps.sdkCancel) {
    return { kind: 'cancelled', settlement: await deps.sdkCancel() };
  }
  deps.paintOptimisticAbort();
  let refusal: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    deps.holdInbox().catch((error: unknown) => {
      refusal = deps.refusalOf(error);
      if (!refusal) deps.onHoldFailed(error);
    }),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, deps.holdDeadlineMs);
    }),
  ]);
  clearTimeout(timer);
  if (refusal) return { kind: 'refused', message: refusal };
  return { kind: 'cancelled', settlement: await deps.fallbackCancel() };
}

/**
 * A synchronous latch: the second Stop while the first is still settling does
 * nothing. A ref, not React Query's `isPending`: `isPending` turns true only
 * after a re-render, and the SDK path never touched the host mutation at all,
 * so Stop → Esc×3 → Stop sent three stops.
 */
export function createStopLatch() {
  let inFlight = false;
  return {
    get inFlight() {
      return inFlight;
    },
    async run<T>(fn: () => Promise<T>): Promise<T | undefined> {
      if (inFlight) return undefined;
      inFlight = true;
      try {
        return await fn();
      } finally {
        inFlight = false;
      }
    },
  };
}

/** A stop the server did not confirm: the turn may still be running. */
export function stopLeftTurnRunning(outcome: StopOutcome | undefined): boolean {
  if (!outcome) return false;
  if (outcome.kind === 'refused') return true;
  return outcome.settlement.status === 'timed-out' || outcome.settlement.status === 'failed';
}
