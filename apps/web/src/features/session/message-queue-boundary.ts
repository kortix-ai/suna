/**
 * When it is safe to release the queue.
 *
 * The agent finishes the task it is on, and then **everything waiting goes out
 * together**, on one prompt, in the order it was typed. Nothing overtakes;
 * nothing is held back for a later turn.
 *
 * This module answers only *when* — how much is released is `claimBatch`'s in
 * `@kortix/sdk/message-queue`, and what the single prompt contains is
 * `queued-batch.ts`. Keeping those separate is why the batching change did not
 * have to touch a single gate below.
 *
 * The previous answer to *when* was wrong in three
 * separate ways, all of them invisible from the code that used them:
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
 *
 * ## Two release paths, matching Claude Code
 *
 * A queued message is an instruction the agent should react to NOW, not after
 * it finishes everything it had planned. So there are two ways out of the
 * queue:
 *
 *   1. **The interrupt** (`shouldInterruptForQueue` + `runQueueInterrupt`):
 *      while the server is busy and a NEW message is waiting, the run is
 *      stopped at the next tool boundary — the currently executing tool call
 *      is allowed to finish (never killed halfway; see `running-tool.ts`), the
 *      remainder of the turn is aborted, and the whole queue goes out
 *      immediately. The interrupt IS the boundary, so no settle window
 *      applies.
 *   2. **The ordinary drain** (`stepDrainMachine`): when the interrupt is held
 *      — a question on screen, an approval pending, the user pressed stop, a
 *      batch leftover with nothing newly typed — the queue waits for the real
 *      end of turn exactly as before.
 *
 * Rule 1 is why a finished tool call is still not a *drain* boundary: the
 * drain waits for the whole turn. The interrupt is the only path that acts at
 * a tool boundary, and it acts by ending the turn first.
 */

/**
 * How long every gate must stay continuously clear before a queued message is
 * released. `sessionStatus` flaps between agentic steps; this window is what
 * distinguishes a gap from an ending.
 */
export const QUEUE_SETTLE_MS = 700;

/**
 * How long an open assistant turn may block the drain while every OTHER gate —
 * server status included — says the session is idle.
 *
 * `hasIncompleteAssistant` exists to survive missed status events: a stale
 * idle status must not drain the queue into a turn that is really running. But
 * a sandbox that dies mid-turn and boots fresh leaves the last assistant
 * message permanently open — `time.completed` never set, no error ever patched
 * (no `session.error`, no `server.instance.disposed`: the process that owned
 * the turn is simply gone). That husk lives in the server's own transcript, so
 * it survives a hard refresh, and the queue wedged forever behind it.
 *
 * A live turn produces evidence: the status poll reports busy within one
 * liveness interval (10s), which resets this clock via the `isServerBusy`
 * gate. So an open message that goes this long with the server continuously
 * idle is a husk of a dead turn, not a running one — release the queue.
 */
export const OPEN_TURN_HUSK_MS = 10_000;

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
  /**
   * The sandbox is up and answering.
   *
   * The ONE gate whose polarity is inverted — every field above means "do not
   * send", this one means "may send". It keeps the name `runtimeReady` because
   * that is what the signal is called everywhere it comes from
   * (`useRuntimeReady`, `sessionComposerReadiness`), and a `runtimeAsleep`
   * spelling here would mean every call site negates it on the way in, which is
   * where polarity bugs actually happen.
   *
   * This gate is what lets the composer stay usable while the box is stopped.
   * Previously the composer was DISABLED until the runtime answered, because
   * `send()` only checks that an opencode session id exists — not that its
   * runtime is up — so a prompt submitted against a sleeping box is accepted
   * and lost. Holding it in the queue instead means the message survives, and
   * goes out by itself the moment the sandbox wakes.
   */
  runtimeReady: boolean;
  /**
   * A session rewind is staged (the user picked an earlier message to edit,
   * `session.revert` has been called, and the replacement prompt has not
   * been sent yet). Hard-closes the drain independent of every other gate.
   *
   * Without this, the OTHER gates read WRONG during a staged revert, and
   * wrong in the dangerous direction: the local hide window
   * (`messagesBeforeRewind`) removes the very messages
   * `hasIncompleteAssistant` and `isServerBusy` would otherwise be reading —
   * an in-progress or just-finished turn on the abandoned trajectory
   * disappears from view, so those gates can read CLEAR while a staged
   * revert sits open. That would let the drain open SOONER during a staged
   * revert than during an ordinary idle session — backwards. Draining into a
   * staged window sends the queued prompt into a trajectory the user has
   * already asked to discard, and it lands ahead of the replacement they are
   * about to type into the composer.
   *
   * `handleConfirmRewind` (`session-chat.tsx`) additionally clears this
   * session's queue outright on confirm — the queued messages belong to the
   * abandoned trajectory, not merely to a turn that has not started yet — so
   * this gate's job is closing the door to anyone (a slower `enqueue`, a
   * cross-tab enqueue) who queues something new WHILE staged, not draining
   * what was already there.
   */
  revertStaged: boolean;
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
    !gates.readOnly &&
    gates.runtimeReady &&
    !gates.revertStaged
  );
}

/**
 * Whether a message the user just submitted should join the queue rather than
 * go straight out.
 *
 * `isBusy` alone is not enough, and the gap is easy to miss. It is false during
 * the settle window, and false in the moment between claiming a message and the
 * server reporting the session busy. Submitting in either window sends the new
 * message *ahead* of everything already waiting — and, in the second case,
 * puts two prompts on the wire at once.
 *
 * So: anything waiting or in flight means this one waits too, however idle the
 * session looks this instant. Jumping the line is what "Stop & send" is for,
 * and that is a button, not a timing accident.
 */
export function shouldQueueInsteadOfSend(input: {
  isBusy: boolean;
  pendingCount: number;
  hasInFlight: boolean;
  /**
   * Defaults to `true` so every existing caller is unchanged. `false` — the
   * sandbox is stopped or still waking — routes the message to the queue,
   * which is what makes leaving the composer ENABLED safe: `send()` would
   * accept a prompt against a sleeping box and lose it, whereas the queue
   * holds it and `canDrainQueue`'s matching `runtimeReady` gate releases it
   * once the box answers.
   */
  runtimeReady?: boolean;
}): boolean {
  if (input.runtimeReady === false) return true;
  return input.isBusy || input.pendingCount > 0 || input.hasInFlight;
}

/**
 * Whether a queued message should interrupt the running turn right now.
 *
 * This is the Claude Code behavior: a message typed while the agent works is
 * not a note for later — it is the user steering. The agent finishes the tool
 * call it is executing (never killed halfway), the rest of the turn is
 * aborted, and the queue goes out immediately with the completed tool's result
 * already in the transcript.
 *
 * What must hold before firing:
 *
 *   - **Something NEW is pending.** `hasNewPending` is "a message enqueued
 *     since the last claim". A leftover from a split batch (the user changed
 *     model mid-queue, so `claimBatch` stopped early) was queued BEFORE the
 *     turn it did not join — it waits for that turn like any queued message,
 *     rather than killing the run its own batch-mates just started.
 *   - **The server says busy.** An idle session has nothing to interrupt; the
 *     ordinary drain owns that path and already dispatches there.
 *   - **No tool is executing.** The boundary. `hasRunningTool` comes from
 *     `running-tool.ts`; a `pending` tool does not block, because it has not
 *     started.
 *   - **No human is being waited on.** A question, approval, or permission
 *     prompt means the run is paused FOR the user — aborting it would answer
 *     on their behalf. The queue holds, exactly as the drain does.
 *   - **Nothing else holds the queue.** Stop's pause, read-only views, staged
 *     rewinds, a sleeping runtime, our own unacknowledged send, a compaction:
 *     all the reasons the drain would not release also mean do not interrupt.
 *   - **Not already busy doing this.** One send or one interrupt at a time.
 */
export function shouldInterruptForQueue(input: {
  gates: QueueDrainGates;
  hasRunningTool: boolean;
  /** A message was enqueued since the last claim — see above. */
  hasNewPending: boolean;
  /** A dispatch from an earlier tick is still awaiting its send. */
  sending: boolean;
  /** An earlier interrupt is still settling. */
  interrupting: boolean;
}): boolean {
  const { gates } = input;
  if (!input.hasNewPending || input.sending || input.interrupting) return false;
  if (!gates.isServerBusy) return false;
  if (input.hasRunningTool) return false;
  if (gates.hasActiveQuestion || gates.hasPendingApproval || gates.pendingPermissionCount > 0) {
    return false;
  }
  if (gates.isPaused || gates.readOnly || gates.revertStaged) return false;
  if (!gates.runtimeReady) return false;
  if (gates.pendingSendInFlight || gates.isOptimisticCompacting) return false;
  return true;
}

/**
 * Carry out one interrupt: abort the run, wait for that to settle, then claim
 * and dispatch the queue as one prompt.
 *
 * Injected like `stopThenSendNow` (session-chat.tsx), so the ordering is
 * asserted in tests rather than observed by hand. The rules:
 *
 *   - `interrupt()` resolves only once the abort has settled (server-confirmed
 *     or bounded-timeout — see `AbortSettlement`). If it REJECTS, nothing is
 *     dispatched: a prompt must never be fired into a turn that might still be
 *     running. The ordinary drain picks the queue up at the real end of turn.
 *   - `isHeld()` is re-checked after the abort settles. A stop pressed while
 *     the interrupt was in flight wins — "stop doing things" includes the
 *     queue, even a queue that was mid-interrupt.
 *   - An empty claim means another path (the ordinary drain, another view of
 *     this session) took the batch first; the store's claim is the lock, so
 *     this dispatches nothing rather than doubling up.
 */
export async function runQueueInterrupt<T>(deps: {
  interrupt: () => Promise<void>;
  isHeld: () => boolean;
  claimBatch: () => T[];
  dispatch: (claimed: T[]) => Promise<void>;
}): Promise<void> {
  try {
    await deps.interrupt();
  } catch {
    return;
  }
  if (deps.isHeld()) return;
  const claimed = deps.claimBatch();
  if (claimed.length === 0) return;
  await deps.dispatch(claimed);
}

/**
 * Whether pressing stop should stop auto-sending.
 *
 * Paired with `shouldClearPause` below, and they have to agree: pausing without
 * a way back means every message typed after a stop queues behind a queue that
 * never moves. That wedge is worse than the interruption the pause prevents.
 */
export function shouldClearPause(previousQueueSize: number, nextQueueSize: number): boolean {
  // Adding to the queue is the user saying "I want this sent". Whatever the
  // stop meant, it did not mean this.
  return nextQueueSize > previousQueueSize;
}

/**
 * The whole machine: one clock, no latch.
 *
 * ## Why the latch is gone, and why one-per-turn still holds without it
 *
 * It used to carry a second field, `sawBusySinceDispatch`: after releasing a
 * message it refused to release another until a NEW busy period had been
 * *observed by this tab*. The intent was right — the next message must wait for
 * the turn this one starts — but the mechanism was a second, weaker copy of
 * something the gates already do, and it failed open in the wrong direction.
 *
 * `isServerBusy` reads `useSyncStore.sessionStatus[sessionId]`. `handleSend`
 * calls `beginOptimisticSend`, which writes `{ type: 'busy' }` into that exact
 * slot **synchronously, before any await** — and `useSessionSync` additionally
 * forces busy while a prompt is observed in flight. So by the time the drain
 * ticks again after a dispatch, the busy gate is already closed. The head is
 * genuinely alone on the wire; the latch was asserting a fact the gate had
 * already established.
 *
 * What the latch uniquely did was fail closed. If that busy period never
 * arrived — a send that errored before reaching the server, a missed status
 * event, a tab that was asleep — every later message waited forever on a turn
 * that never started. That is the "the queue just stops sending" report, and it
 * is why a `rearmDrainMachine` escape hatch had to exist beside it and be
 * called from three places to paper over the cases anyone had thought of.
 *
 * Removing it leaves one honest question: have the gates been continuously
 * clear long enough to call this the end of a turn?
 */
export interface DrainMachine {
  /** When the gates last became clear, or null while any gate is closed. */
  clearSince: number | null;
  /**
   * When `hasIncompleteAssistant` became the ONLY closed gate, or null. After
   * `OPEN_TURN_HUSK_MS` of that state the open message is treated as a dead
   * turn's husk and stops blocking — see the constant's doc comment.
   */
  openTurnOnlySince: number | null;
}

export function createDrainMachine(): DrainMachine {
  return { clearSince: null, openTurnOnlySince: null };
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
  huskMs: number = OPEN_TURN_HUSK_MS,
): { machine: DrainMachine; dispatch: boolean } {
  // `isServerBusy` is one of the gates, so a running turn lands here too and
  // resets the clock. There is no separate busy branch to keep in sync.
  if (!canDrainQueue(gates)) {
    // The husk clock runs only while the open assistant message is the SOLE
    // reason the drain is blocked. Any other closed gate — the server saying
    // busy above all — is evidence of a real turn and resets it.
    const openTurnOnly =
      gates.hasIncompleteAssistant && canDrainQueue({ ...gates, hasIncompleteAssistant: false });
    if (!openTurnOnly) {
      return { machine: { clearSince: null, openTurnOnlySince: null }, dispatch: false };
    }
    const openTurnOnlySince = machine.openTurnOnlySince ?? now;
    if (now - openTurnOnlySince < huskMs) {
      return { machine: { clearSince: null, openTurnOnlySince }, dispatch: false };
    }
    // Husk expired — fall through with the gate overridden; the normal settle
    // window still applies from this point.
  }

  const clearSince = machine.clearSince ?? now;
  if (now - clearSince < settleMs) {
    return { machine: { ...machine, clearSince }, dispatch: false };
  }

  // Reset the clock on dispatch, so the message behind this one starts its wait
  // from scratch. Normally it never gets that far — the send closes the busy
  // gate synchronously — but when a send fails without ever reaching the server
  // the gates stay clear, and this is what keeps the next message a full settle
  // window behind rather than following it in the same instant.
  return { machine: { clearSince: null, openTurnOnlySince: null }, dispatch: true };
}

/**
 * What one observation should cause. `wait` carries the delay because nothing
 * re-renders while the gates merely stay clear — the caller must set a timer or
 * the queue stalls until some unrelated render happens to wake it.
 */
export type DrainAction =
  | { kind: 'idle' }
  | { kind: 'dispatch' }
  | { kind: 'wait'; ms: number };

/**
 * The whole drain decision, with no React and no clock of its own.
 *
 * This used to live inside the hook's `tick`, which meant none of it could be
 * asserted: not "an empty queue must not step the machine", not "a send already
 * on the wire must not start a second one", not the remaining-time arithmetic
 * that decides whether the queue moves at all. Those are the mistakes worth
 * catching, so they are inputs and outputs here and the hook is left holding
 * only the side effects.
 */
export function planDrainTick(input: {
  machine: DrainMachine;
  gates: QueueDrainGates;
  /** How many messages are waiting, in-flight ones included. */
  pendingCount: number;
  /** Whether a dispatch from an earlier tick is still awaiting its send. */
  sending: boolean;
  now: number;
  settleMs?: number;
}): { machine: DrainMachine; action: DrainAction } {
  const settleMs = input.settleMs ?? QUEUE_SETTLE_MS;

  // Nothing to send, or a send already out. Return the machine untouched: this
  // tick observed nothing, so it must not restart or advance the settle clock.
  if (input.sending || input.pendingCount === 0) {
    return { machine: input.machine, action: { kind: 'idle' } };
  }

  const { machine, dispatch } = stepDrainMachine(input.machine, input.gates, input.now, settleMs);
  if (dispatch) return { machine, action: { kind: 'dispatch' } };

  if (machine.clearSince === null) {
    // Waiting out a dead-turn husk. Nothing re-renders while it merely ages,
    // so hand back a timer — otherwise the override only fires when some
    // unrelated render happens to tick the drain.
    if (machine.openTurnOnlySince !== null) {
      const elapsed = input.now - machine.openTurnOnlySince;
      return { machine, action: { kind: 'wait', ms: Math.max(0, OPEN_TURN_HUSK_MS - elapsed) } };
    }
    // A closed gate will re-render when it opens; there is nothing to poll for.
    return { machine, action: { kind: 'idle' } };
  }

  const elapsed = input.now - machine.clearSince;
  return { machine, action: { kind: 'wait', ms: Math.max(0, settleMs - elapsed) } };
}
