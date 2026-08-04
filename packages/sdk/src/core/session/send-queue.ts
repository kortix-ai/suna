/**
 * One prompt at a time, in the order they were written.
 *
 * Sending while the agent is mid-run used to be fire-and-hope: the prompt went
 * out immediately and whatever the runtime did with it was invisible. The
 * reported symptom was "sending also without upload feels janky while agent is
 * working" — nothing on screen distinguished "waiting its turn" from "lost".
 *
 * This holds a prompt until the session is idle, then dispatches it. Ordering
 * is guaranteed HERE rather than assumed of the server, which matters because
 * the endpoint Kortix currently uses (`/session/{id}/prompt_async`) makes no
 * documented promise about what happens to a prompt that arrives mid-run. The
 * runtime does have a durable native queue (`delivery: 'queue'` on the v2
 * `/api/session/{id}/prompt` route, with `session.next.prompt.admitted` to
 * confirm promotion) — moving to it is the better long-term answer and is
 * tracked separately. Until then the queue lives here, with the one honest
 * caveat that a queue in a tab dies with the tab.
 *
 * Framework-free and timer-free: `isBusy` is injected and draining is driven by
 * the caller telling it the session went idle. Nothing here polls.
 */

/** Where a queued send has got to. Drives the label on the user's bubble. */
export type SendPhase = 'queued' | 'sending' | 'sent' | 'failed';

export interface QueuedSend {
  /** The optimistic message this send belongs to. */
  messageId: string;
  /** Actually put it on the wire. Rejects on failure. */
  dispatch: () => Promise<void>;
}

export interface SendQueueOptions {
  /** Is the session mid-run right now? */
  isBusy: (sessionId: string) => boolean;
  /** Report a phase change so a host can render it. */
  onPhase?: (sessionId: string, messageId: string, phase: SendPhase) => void;
}

export interface SendQueue {
  /**
   * Send now if the session is idle, otherwise hold it.
   *
   * Returns the phase the message entered, so a caller can render without
   * waiting for the `onPhase` callback to come back around.
   */
  submit: (sessionId: string, item: QueuedSend) => 'queued' | 'sending';
  /**
   * The session finished a run. Dispatch the next held prompt, if any.
   *
   * Called by whatever observes session status — deliberately not a poll, and
   * deliberately not a subscription this module owns, so it stays framework-
   * free and testable without fake timers.
   */
  drain: (sessionId: string) => void;
  /** Abandon a specific held send (the user discarded it). */
  cancel: (sessionId: string, messageId: string) => boolean;
  /** Abandon everything held for a session (it closed, or was cleared). */
  clear: (sessionId: string) => void;
  /** Message ids still waiting, oldest first. */
  pending: (sessionId: string) => string[];
}

export function createSendQueue(options: SendQueueOptions): SendQueue {
  const { isBusy, onPhase } = options;
  const queues = new Map<string, QueuedSend[]>();
  /** Sessions with a dispatch in flight, so `drain` never doubles up. */
  const inFlight = new Set<string>();

  const phase = (sessionId: string, messageId: string, next: SendPhase) => {
    onPhase?.(sessionId, messageId, next);
  };

  const run = (sessionId: string, item: QueuedSend) => {
    inFlight.add(sessionId);
    phase(sessionId, item.messageId, 'sending');
    void item
      .dispatch()
      .then(() => {
        phase(sessionId, item.messageId, 'sent');
      })
      .catch(() => {
        // A failed send must not wedge everything written after it. The
        // message keeps its own `failed` phase (the host offers a retry);
        // the queue moves on.
        phase(sessionId, item.messageId, 'failed');
      })
      .finally(() => {
        inFlight.delete(sessionId);
        // The run this send started has not begun yet — `drain` is driven by
        // the session going idle, and it is about to go busy. Only pull the
        // next item if the session never became busy at all (e.g. the send
        // failed outright), otherwise the idle transition will do it.
        if (!isBusy(sessionId)) drain(sessionId);
      });
  };

  const drain = (sessionId: string) => {
    if (inFlight.has(sessionId)) return;
    if (isBusy(sessionId)) return;
    const queue = queues.get(sessionId);
    if (!queue || queue.length === 0) return;
    const next = queue.shift();
    if (queue.length === 0) queues.delete(sessionId);
    if (next) run(sessionId, next);
  };

  return {
    submit: (sessionId, item) => {
      if (!isBusy(sessionId) && !inFlight.has(sessionId)) {
        const queue = queues.get(sessionId);
        // Never jump the line: if anything is already waiting, this one waits
        // behind it even though the session happens to be idle this instant.
        if (!queue || queue.length === 0) {
          run(sessionId, item);
          return 'sending';
        }
      }
      const queue = queues.get(sessionId);
      if (queue) queue.push(item);
      else queues.set(sessionId, [item]);
      phase(sessionId, item.messageId, 'queued');
      return 'queued';
    },

    drain,

    cancel: (sessionId, messageId) => {
      const queue = queues.get(sessionId);
      if (!queue) return false;
      const index = queue.findIndex((q) => q.messageId === messageId);
      if (index === -1) return false;
      queue.splice(index, 1);
      if (queue.length === 0) queues.delete(sessionId);
      return true;
    },

    clear: (sessionId) => {
      queues.delete(sessionId);
    },

    pending: (sessionId) => (queues.get(sessionId) ?? []).map((q) => q.messageId),
  };
}
