'use client';

/**
 * Drives the queue: watches the gates, waits for a real end-of-turn, and sends
 * exactly one message when it arrives.
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
  QUEUE_SETTLE_MS,
  createDrainMachine,
  rearmDrainMachine,
  stepDrainMachine,
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
  /** Send one specific queued message right now, jumping the order. */
  dispatchNow: (id: string) => Promise<void>;
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
        // already accepted got sent a second time.
        useMessageQueueStore.getState().fail(sessionId, errorMessage(cause));
        // A failed send never made the session busy, so without this the
        // machine waits forever for a turn that never started.
        machineRef.current = rearmDrainMachine(machineRef.current);
      } finally {
        sendingRef.current = false;
        tickRef.current();
      }
    },
    [sessionId],
  );

  const tick = useCallback(() => {
    clearTimeout(timerRef.current);
    if (sendingRef.current) return;

    const queue = useMessageQueueStore.getState().getSessionQueue(sessionId);
    if (queue.pending.length === 0) return;

    const now = Date.now();
    const { machine, dispatch } = stepDrainMachine(
      machineRef.current,
      { ...gatesRef.current, isPaused: gatesRef.current.isPaused || pausedRef.current },
      now,
    );
    machineRef.current = machine;

    if (dispatch) {
      const claimed = useMessageQueueStore.getState().claimNext(sessionId);
      if (claimed) void dispatchOne(claimed);
      return;
    }

    // Armed but not settled yet — the gates are clear and staying clear is the
    // only thing left to prove, and nothing else will re-render to tell us.
    if (machine.clearSince !== null && machine.sawBusySinceDispatch) {
      const remaining = Math.max(0, QUEUE_SETTLE_MS - (now - machine.clearSince));
      timerRef.current = setTimeout(() => tickRef.current(), remaining + 1);
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
  useEffect(() => {
    tick();
  }, [tick, pendingCount]);

  const pause = useCallback(() => {
    pausedRef.current = true;
    clearTimeout(timerRef.current);
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    machineRef.current = rearmDrainMachine(machineRef.current);
    tickRef.current();
  }, []);

  const dispatchNow = useCallback(
    async (id: string) => {
      const queue = useMessageQueueStore.getState().getSessionQueue(sessionId);
      const target = queue.pending.find((m) => m.id === id);
      if (!target || target.id === queue.inFlightId) return;

      // Explicit user action, so order yields to intent: move it to the front,
      // clear the pause the stop button just set, and claim it.
      pausedRef.current = false;
      useMessageQueueStore.getState().reorder(sessionId, id, 0);
      machineRef.current = rearmDrainMachine(machineRef.current);
      const claimed = useMessageQueueStore.getState().claimNext(sessionId);
      if (claimed) await dispatchOne(claimed);
    },
    [sessionId, dispatchOne],
  );

  return { pause, resume, dispatchNow };
}
