'use client';

/**
 * Drives the queue: watches the gates, waits for a real end-of-turn, and sends
 * everything that is waiting when it arrives.
 *
 * **The whole queue goes out together, on one prompt.** Three messages typed
 * during a turn reach the agent as one turn's worth of instructions, in the
 * order they were typed. This is what Claude Code and Codex do, and it is what
 * a queue means to the person typing into it: the follow-ups are usually parts
 * of one thought ("also fix the tests", "and update the docs"), not three
 * separate errands that each deserve their own agent run.
 *
 * It replaces a one-message-per-turn rule that was a correct fix aimed at the
 * wrong target. The bug it was written against (`a9fc74d9d3`, RC4 in the
 * design doc) was a drain that *looped* `handleSend` over the queue — and
 * since `handleSend` resolves when the server ACKs the prompt, not when the
 * turn ends, messages 2..N were dispatched into message 1's live turn. The
 * answer to N racing turns is one turn carrying N messages, not N turns in
 * series: with the latter, a user who typed three quick follow-ups waited for
 * three full agent runs, and the agent answered each in isolation without ever
 * seeing the other two.
 *
 * The batching is `claimBatch`'s, in the SDK. It stops at a change of
 * agent/model/variant, because one prompt carries one of each — so a message
 * still sends under the model it was queued with.
 *
 * What was broken beyond the batching was that the queue kept stopping: a
 * latch that waited for a busy period the tab might never observe, and a gate
 * that stayed closed forever after the stop button. Both are gone. See
 * `message-queue-boundary.ts`.
 *
 * All of the judgment lives in `message-queue-boundary.ts` as pure functions,
 * and the claim/complete/fail bookkeeping lives in the store. What is left here
 * is the part that genuinely needs React and a clock: re-evaluating when a gate
 * changes, and setting one timer for the settle window.
 *
 * Two things this hook deliberately does NOT do, both of them root causes of
 * the bug it replaces:
 *
 *   - It never reads `messages`. The old drain watched the message array for
 *     tool parts flipping to `completed`, which fired mid-turn on every tool
 *     call and again whenever scrolling up loaded older history.
 *   - It never reads `isBusy`. That is a 300 ms fade timer for the busy
 *     indicator; `QueueDrainGates` does not expose it.
 *
 * The dispatch lock is the store's `claimNext`, not a ref here. Two mounted
 * views of one session share the store, so the claim is genuinely exclusive —
 * a ref would only be exclusive per component.
 */

import { useMessageQueueStore, type WebQueuedMessage } from '@/stores/message-queue-store';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createDrainMachine,
  planDrainTick,
  shouldClearPause,
  type DrainMachine,
  type QueueDrainGates,
} from './message-queue-boundary';

export interface UseMessageQueueDrainOptions {
  sessionId: string;
  gates: QueueDrainGates;
  /**
   * Put the batch on the wire as ONE prompt, in the order given. Must reject
   * if the send did not land.
   *
   * Never a loop over sends. A second prompt issued before the first turn ends
   * lands inside it, which is the interleaving this queue exists to prevent.
   */
  send: (messages: WebQueuedMessage[]) => Promise<void>;
}

export interface MessageQueueDrainControls {
  /**
   * Stop auto-sending until the next enqueue or an explicit `resume`. Called
   * when the user presses stop: "stop doing things" has to include the queue,
   * or the interrupt is followed a beat later by exactly the message they were
   * trying to get ahead of.
   */
  pause: () => void;
  resume: () => void;
  /** Send one specific queued message right now, jumping the order. */
  dispatchNow: (id: string) => Promise<void>;
  /**
   * Whether the queue is held by a stop. **Render this.**
   *
   * A pause with nothing on screen to show for it is indistinguishable from a
   * broken queue, and that is not hypothetical: messages queued before a stop
   * sat untouched for as long as anyone waited, because the only thing that
   * cleared the pause was queueing *another* message. The user sees their
   * queue simply stop working, with no indication and no way out.
   *
   * Mirrored from the ref rather than replacing it: `tick` reads the ref so a
   * pause takes effect in the same tick it is set, while this drives the paint.
   */
  paused: boolean;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === 'string' ? cause : 'Send failed';
}

export function useMessageQueueDrain({
  sessionId,
  gates,
  send,
}: UseMessageQueueDrainOptions): MessageQueueDrainControls {
  const machineRef = useRef<DrainMachine>(createDrainMachine());
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pausedRef = useRef(false);
  const [paused, setPaused] = useState(false);
  const sendingRef = useRef(false);

  /** Keep the tick-visible ref and the render-visible state in lockstep. */
  const setPausedState = useCallback((next: boolean) => {
    pausedRef.current = next;
    setPaused(next);
  }, []);

  // Read inside callbacks rather than closed over, so the timer callback always
  // sees current values without re-creating itself on every render. Written in
  // an effect, never during render — see the sync effect below.
  const gatesRef = useRef(gates);
  const sendRef = useRef(send);

  const hydrated = useMessageQueueStore((s) => s.hydrated);
  useEffect(() => {
    if (!hydrated) useMessageQueueStore.getState().hydrate();
  }, [hydrated]);

  const tickRef = useRef<() => void>(() => {});

  const dispatchClaimed = useCallback(
    async (claimed: WebQueuedMessage[]) => {
      if (claimed.length === 0) return;
      sendingRef.current = true;
      try {
        await sendRef.current(claimed);
        useMessageQueueStore.getState().complete(sessionId);
      } catch (cause) {
        // Set them aside with the reason; never back at the head. Requeueing a
        // failure is how the queue used to wedge, and how a prompt the server
        // already accepted got sent a second time. The queue moving on is the
        // point: one bad send must not stop it.
        useMessageQueueStore.getState().fail(sessionId, errorMessage(cause));
      } finally {
        sendingRef.current = false;
        tickRef.current();
      }
    },
    [sessionId],
  );

  // Every decision below is `planDrainTick`'s; what is left here is carrying it
  // out. The store read, the timer and the claim are the only parts that
  // genuinely cannot be a pure function.
  const tick = useCallback(() => {
    clearTimeout(timerRef.current);

    const { machine, action } = planDrainTick({
      machine: machineRef.current,
      gates: { ...gatesRef.current, isPaused: gatesRef.current.isPaused || pausedRef.current },
      pendingCount: useMessageQueueStore.getState().getSessionQueue(sessionId).pending.length,
      sending: sendingRef.current,
      now: Date.now(),
    });
    machineRef.current = machine;

    switch (action.kind) {
      case 'dispatch': {
        // Everything waiting, as one prompt.
        const claimed = useMessageQueueStore.getState().claimBatch(sessionId);
        void dispatchClaimed(claimed);
        return;
      }
      case 'wait':
        // Nothing else will re-render to say the gates stayed clear.
        timerRef.current = setTimeout(() => tickRef.current(), action.ms + 1);
        return;
      case 'idle':
        return;
    }
  }, [sessionId, dispatchClaimed]);

  // Refresh the mutable reads after every commit. Declared BEFORE the gate
  // effect below, so by the time a gate change calls `tick`, the refs it reads
  // already hold this render's values. Writing them during render instead would
  // tear under React Compiler.
  useEffect(() => {
    gatesRef.current = gates;
    sendRef.current = send;
    tickRef.current = tick;
  });

  // One dependency per gate, spelled out. `messages` is absent by design (root
  // cause 3): a history load must never look like the end of a turn.
  useEffect(() => {
    tick();
    return () => clearTimeout(timerRef.current);
  }, [
    tick,
    hydrated,
    gates.isServerBusy,
    gates.pendingSendInFlight,
    gates.isOptimisticCompacting,
    gates.hasIncompleteAssistant,
    gates.hasActiveQuestion,
    gates.hasPendingApproval,
    gates.pendingPermissionCount,
    gates.isPaused,
    gates.readOnly,
    gates.revertStaged,
  ]);

  // Re-evaluate when the queue itself changes — a new message on an already
  // idle session has nothing else to wake it.
  const pendingCount = useMessageQueueStore(
    (s) => (s.queues[sessionId]?.pending.length ?? 0) + (s.queues[sessionId]?.failed.length ?? 0),
  );
  const previousCountRef = useRef(pendingCount);
  useEffect(() => {
    // Queueing something new lifts a pause left by the stop button. Without
    // this, stop wedges the queue forever: everything typed afterwards lands
    // behind messages that never drain. Whatever the stop meant, it did not
    // mean "discard what I type from now on".
    if (shouldClearPause(previousCountRef.current, pendingCount)) {
      setPausedState(false);
    }
    previousCountRef.current = pendingCount;
    tick();
  }, [tick, pendingCount, setPausedState]);

  const pause = useCallback(() => {
    setPausedState(true);
    clearTimeout(timerRef.current);
  }, [setPausedState]);

  const resume = useCallback(() => {
    setPausedState(false);
    machineRef.current = createDrainMachine();
    tickRef.current();
  }, [setPausedState]);

  const dispatchNow = useCallback(
    async (id: string) => {
      const store = useMessageQueueStore.getState();
      const target = store.getSessionQueue(sessionId).pending.find((m) => m.id === id);
      if (!target || store.getInFlightIds(sessionId).includes(id)) return;

      // Explicit user action, so order yields to intent: move it to the front,
      // clear the pause the stop button just set, and claim it — alone. This is
      // the one path that jumps the queue, and it only ever runs from a click.
      //
      // Alone, and deliberately not `claimBatch`: the button lives on one row
      // and says "send this". Interrupting the agent to send three messages
      // when the user pointed at one is not what the click asked for. The rest
      // of the queue drains together at the next boundary, as usual.
      setPausedState(false);
      useMessageQueueStore.getState().reorder(sessionId, id, 0);
      machineRef.current = createDrainMachine();
      const claimed = useMessageQueueStore.getState().claimNext(sessionId);
      if (claimed) await dispatchClaimed([claimed]);
    },
    [sessionId, dispatchClaimed, setPausedState],
  );

  return { pause, resume, paused, dispatchNow };
}
