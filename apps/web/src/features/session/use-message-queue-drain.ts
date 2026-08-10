'use client';

/**
 * Drives the queue: watches the gates, waits for a real end-of-turn, and sends
 * exactly one message when it arrives.
 *
 * First come, first served. `queue[0]` goes out alone; everything behind it
 * waits for the turn that message starts to finish, then the new head goes.
 * That ordering IS the feature — merging the queue into one prompt would hand
 * the agent several unrelated instructions at once and lose the sequence the
 * user typed them in.
 *
 * What was broken was never the one-at-a-time rule. It was that the queue kept
 * stopping: a latch that waited for a busy period the tab might never observe,
 * and a gate that stayed closed forever after the stop button. Both are gone.
 * See `message-queue-boundary.ts`.
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
import { useCallback, useEffect, useRef } from 'react';
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
  /** Put the message on the wire. Must reject if the send did not land. */
  send: (message: WebQueuedMessage) => Promise<void>;
}

export interface MessageQueueDrainControls {
  /**
   * Stop auto-sending until the next enqueue or explicit send. Called when the
   * user presses stop: "stop doing things" has to include the queue, or the
   * interrupt is followed a beat later by exactly the message they were trying
   * to get ahead of.
   */
  pause: () => void;
  resume: () => void;
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
  const sendingRef = useRef(false);

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

  const dispatchOne = useCallback(
    async (claimed: WebQueuedMessage) => {
      sendingRef.current = true;
      try {
        await sendRef.current(claimed);
        useMessageQueueStore.getState().complete(sessionId);
      } catch (cause) {
        // Set it aside with its reason; never back at the head. Requeueing a
        // failure is how the queue used to wedge, and how a prompt the server
        // already accepted got sent a second time. The head moving on is the
        // point: one bad message must not stop the queue.
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
        // The head, and only the head.
        const claimed = useMessageQueueStore.getState().claimNext(sessionId);
        if (claimed) void dispatchOne(claimed);
        return;
      }
      case 'wait':
        // Nothing else will re-render to say the gates stayed clear.
        timerRef.current = setTimeout(() => tickRef.current(), action.ms + 1);
        return;
      case 'idle':
        return;
    }
  }, [sessionId, dispatchOne]);

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
      pausedRef.current = false;
    }
    previousCountRef.current = pendingCount;
    tick();
  }, [tick, pendingCount]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    clearTimeout(timerRef.current);
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    machineRef.current = createDrainMachine();
    tickRef.current();
  }, []);

  return { pause, resume };
}
