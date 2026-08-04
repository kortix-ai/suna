/**
 * When it is safe to release a queued message.
 *
 * This module exists because the previous answer was wrong in three separate
 * ways, and all three were invisible from the code that used them:
 *
 *   1. **A finished tool call counted as a boundary.** Any tool part reaching
 *      `completed` or `error` drained the whole queue. A turn that runs Bash →
 *      Read → Edit hit three "boundaries" while the agent was still working, so
 *      a message typed mid-turn landed mid-turn. That is the reported bug.
 *   2. **`isBusy` was read as "the turn ended".** It is a 300 ms fade timer for
 *      the busy indicator (`session-chat.tsx`), so any gap between agentic
 *      steps longer than the fade looked like completion. A UI timer is not a
 *      transaction boundary, which is why `QueueDrainGates` does not have an
 *      `isBusy` field for anyone to reach for.
 *   3. **Loading older history fired it.** The drain watched the `messages`
 *      array, so tool parts prepended by scrolling up counted as new
 *      completions. Nothing here reads `messages`.
 *
 * The replacement is a small state machine over signals that actually mean
 * something: the server's own session status, plus the gates that mean the run
 * is paused waiting for a human. It is pure and clock-injected, so every rule
 * below is asserted in a unit test rather than observed by hand.
 */

/**
 * How long every gate must stay continuously clear before a queued message is
 * released. `sessionStatus` flaps between agentic steps; this window is what
 * distinguishes a gap from an ending.
 */
export const QUEUE_SETTLE_MS = 700;

/**
 * Everything that means "do not send yet". All of these already exist in
 * `session-chat.tsx` — the drain simply reads the honest ones.
 */
export interface QueueDrainGates {
  /** The server says this session is running or retrying. The real signal. */
  isServerBusy: boolean;
  /** Our own send has not been acknowledged yet. */
  pendingSendInFlight: boolean;
  isOptimisticCompacting: boolean;
  /** The last assistant message is still open, whatever the status says. */
  hasIncompleteAssistant: boolean;
  /** A structured question is on screen. Draining would answer it with
   *  unrelated text. */
  hasActiveQuestion: boolean;
  /** A connector action is awaiting approval. Draining would bypass the gate. */
  hasPendingApproval: boolean;
  pendingPermissionCount: number;
  /** The user pressed stop. "Stop doing things" includes the queue. */
  isPaused: boolean;
  readOnly: boolean;
}

export function canDrainQueue(gates: QueueDrainGates): boolean {
  return (
    !gates.isServerBusy &&
    !gates.pendingSendInFlight &&
    !gates.isOptimisticCompacting &&
    !gates.hasIncompleteAssistant &&
    !gates.hasActiveQuestion &&
    !gates.hasPendingApproval &&
    gates.pendingPermissionCount === 0 &&
    !gates.isPaused &&
    !gates.readOnly
  );
}

export interface DrainMachine {
  /**
   * Whether a busy period has been observed since the last dispatch. This is
   * what makes one message go out per turn instead of the whole queue at once:
   * after dispatching, the machine will not fire again until the turn that
   * dispatch started has itself been seen and finished.
   *
   * Starts `true`, not `false`. A queue restored from storage on an idle
   * session never had a busy period this tab could observe, and requiring one
   * would wedge it forever.
   */
  sawBusySinceDispatch: boolean;
  /** When the gates last became clear, or null while any gate is closed. */
  clearSince: number | null;
}

export function createDrainMachine(): DrainMachine {
  return { sawBusySinceDispatch: true, clearSince: null };
}

/**
 * Let the queue move again without waiting for a busy period.
 *
 * Needed after a send that failed outright: it never made the session busy, so
 * `sawBusySinceDispatch` would stay false and every later message would be
 * stuck behind a turn that never happened. A failed item must never take the
 * rest of the queue down with it — that lockout is why the client queue was
 * deleted wholesale once before.
 */
export function rearmDrainMachine(machine: DrainMachine): DrainMachine {
  return { ...machine, sawBusySinceDispatch: true, clearSince: null };
}

/**
 * Advance the machine one observation.
 *
 * `now` is injected rather than read, so the settle window is asserted in tests
 * instead of slept through.
 */
export function stepDrainMachine(
  machine: DrainMachine,
  gates: QueueDrainGates,
  now: number,
  settleMs: number = QUEUE_SETTLE_MS,
): { machine: DrainMachine; dispatch: boolean } {
  if (gates.isServerBusy) {
    // The turn this dispatch is waiting on. Seeing it is what licenses the
    // next release, and it resets the settle clock.
    return { machine: { sawBusySinceDispatch: true, clearSince: null }, dispatch: false };
  }

  if (!canDrainQueue(gates)) {
    return { machine: { ...machine, clearSince: null }, dispatch: false };
  }

  const clearSince = machine.clearSince ?? now;
  if (!machine.sawBusySinceDispatch || now - clearSince < settleMs) {
    return { machine: { ...machine, clearSince }, dispatch: false };
  }

  return { machine: { sawBusySinceDispatch: false, clearSince: null }, dispatch: true };
}
