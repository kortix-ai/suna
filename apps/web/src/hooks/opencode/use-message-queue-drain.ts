'use client';

/**
 * Message queue drain hook — modeled after OpenCode's `createEffect` drain
 * (research/opencode/packages/app/src/pages/session.tsx, lines 1814-1827)
 * but **fires all queued messages concurrently** instead of waiting for the
 * session to idle between each one.
 *
 * The OpenCode server's runner serializes prompt_async calls per-session via
 * its deferred chain (research/opencode/packages/opencode/src/effect/
 * runner.ts:111), so it's safe to fire N parallel HTTP requests — they get
 * processed in arrival order on the server side. Each queued item still
 * becomes its own user turn with its own assistant response; we just don't
 * wait between them client-side.
 *
 * One reactive effect, one re-entry guard ref. The effect re-runs whenever:
 *
 *   - the head item id changes (something was sent / removed)
 *   - the queue length changes (a new item was enqueued)
 *   - the `failed` flag changes (manual retry / clear)
 *   - the `paused` flag changes (set on session abort, cleared on enqueue)
 *   - the caller-provided `canDrain` boolean changes (e.g. pending question)
 *
 * The hook delegates ALL state mutations to `sendFn` — it just snapshots the
 * current queue, fires sendFn(batch), and releases the lock when done. sendFn
 * is responsible for removing successful items and marking failed ones.
 */

import { useEffect, useRef } from 'react';
import {
  useMessageQueueStore,
  type QueuedMessage,
} from '@/stores/message-queue-store';

export interface UseMessageQueueDrainOptions {
  sessionId: string;
  /** When false, the drain is paused (e.g. a structured question is pending). */
  canDrain: boolean;
  /**
   * Send a batch of queued messages. Implementation owns the per-item
   * success/failure store mutations (remove on success, setFailed on error).
   * The hook only awaits this for the re-entry lock.
   */
  sendFn: (msgs: QueuedMessage[]) => Promise<void>;
}

export function useMessageQueueDrain({
  sessionId,
  canDrain,
  sendFn,
}: UseMessageQueueDrainOptions): void {
  // Read the full session queue. Reference-stable until items change.
  const items = useMessageQueueStore((s) => s.items[sessionId]);
  const failed = useMessageQueueStore((s) => s.failed[sessionId]);
  const paused = useMessageQueueStore((s) => s.paused[sessionId]);

  // Single re-entry guard. The effect can't await, so a ref is the only
  // way to know "a batch is already in flight, don't fire another one".
  const sendingRef = useRef(false);

  // Always read the latest sendFn from a ref so the effect's dep array
  // doesn't trigger on identity changes alone.
  const sendFnRef = useRef(sendFn);
  sendFnRef.current = sendFn;

  const headId = items?.[0]?.id;
  const length = items?.length ?? 0;

  useEffect(() => {
    if (sendingRef.current) return;
    if (!items || items.length === 0) return;
    if (failed === items[0].id) return;
    if (paused) return;
    if (!canDrain) return;

    // Snapshot the batch at send time. New items enqueued during the
    // in-flight send stay in the queue and trigger the next drain cycle.
    const batch = items.slice();

    sendingRef.current = true;
    void Promise.resolve()
      .then(() => sendFnRef.current(batch))
      .catch((err) => {
        // sendFn is expected to handle its own per-item state mutations.
        // A throw here is unexpected — log and let the gates re-evaluate.
        console.error('[message-queue-drain] sendFn threw', {
          sessionId,
          batchSize: batch.length,
          err,
        });
      })
      .finally(() => {
        sendingRef.current = false;
      });
  }, [sessionId, headId, length, failed, paused, canDrain, items]);
}
