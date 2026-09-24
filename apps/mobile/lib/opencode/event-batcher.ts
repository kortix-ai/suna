/**
 * Queue for OpenCode SSE events: coalesces token deltas and throttles store
 * writes. Framework-free; timers are injectable for tests.
 *
 * Deltas arrive at ~30 events/s with bursts far above that. Writing the store
 * once per network read re-renders the session screen once per read, which
 * starves the JS thread. The batcher bounds writes to one per
 * `FLUSH_INTERVAL_MS` while events keep arriving, and flushes status changes
 * on the next tick so "Working" and questions never lag.
 */

export interface StreamEvent {
  type: string;
  // Wire payloads are untyped JSON; the reducer in event-stream.ts narrows them.
  properties: Record<string, any>;
}

/** Minimum spacing between flushes while events keep arriving (~15 writes/s). */
export const FLUSH_INTERVAL_MS = 64;

/** A queue this long flushes inline so a burst cannot grow it without bound. */
export const MAX_QUEUE_SIZE = 200;

/** Events that change what the user must see now: flush on the next tick. */
const URGENT_EVENT_TYPES = new Set([
  'session.idle',
  'session.status',
  'session.error',
  'question.asked',
  'permission.asked',
]);

const DELTA = 'message.part.delta';

type TimerHandle = unknown;

export interface EventBatcherOptions {
  apply: (events: StreamEvent[]) => void;
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export interface EventBatcher {
  enqueue: (event: StreamEvent) => void;
  /** Apply everything queued now, synchronously. */
  flush: () => void;
  /** Drop everything queued and cancel the pending flush. */
  clear: () => void;
}

interface DeltaRun {
  /** Output position of the run's first delta. */
  index: number;
  chunks: string[];
  partID: string;
  messageID: string;
  sessionID: string;
}

/**
 * Merge `message.part.delta` events per (messageID, partID, field) across the
 * whole queue. A merged delta takes the position of its first chunk. Any
 * other event that touches the same part, its message, or its session closes
 * the run, so a later delta for that part starts a new one after it:
 * delta, part.updated, delta stays in that order.
 */
export function coalesceEvents(events: readonly StreamEvent[]): StreamEvent[] {
  const out: StreamEvent[] = [];
  const open = new Map<string, DeltaRun>();
  const merged: DeltaRun[] = [];

  const closeRuns = (matches: (run: DeltaRun) => boolean) => {
    for (const [key, run] of open) {
      if (matches(run)) open.delete(key);
    }
  };

  for (const event of events) {
    const props = event.properties ?? {};
    if (event.type === DELTA) {
      const key = `${props.messageID ?? ''}|${props.partID ?? ''}|${props.field ?? ''}`;
      const run = open.get(key);
      if (run) {
        if (run.chunks.length === 1) merged.push(run);
        run.chunks.push(String(props.delta ?? ''));
        continue;
      }
      open.set(key, {
        index: out.length,
        chunks: [String(props.delta ?? '')],
        partID: props.partID ?? '',
        messageID: props.messageID ?? '',
        sessionID: props.sessionID ?? '',
      });
      out.push(event);
      continue;
    }

    if (open.size > 0) {
      const part = props.part;
      const partID: string | undefined = part?.id ?? props.partID;
      const messageID: string | undefined = part?.messageID ?? props.messageID ?? props.info?.id;
      if (event.type.startsWith('message.part.')) {
        if (partID) closeRuns((run) => run.partID === partID);
        else if (messageID) closeRuns((run) => run.messageID === messageID);
      } else if (event.type.startsWith('message.')) {
        if (messageID) closeRuns((run) => run.messageID === messageID);
        // A delta that arrives before its session's user message is dropped
        // (no stub without a user message); merging it with later chunks
        // would drop those too.
        const info = props.info;
        if (event.type === 'message.updated' && info?.role === 'user' && info.sessionID) {
          closeRuns((run) => run.sessionID === info.sessionID);
        }
      } else if (event.type.startsWith('session.')) {
        // `session.updated` / `session.deleted` carry the session as `info`.
        const sessionID: string | undefined = props.sessionID ?? props.info?.id;
        if (sessionID) closeRuns((run) => run.sessionID === sessionID);
        else open.clear();
      }
    }
    out.push(event);
  }

  for (const run of merged) {
    const template = out[run.index];
    out[run.index] = {
      ...template,
      properties: { ...template.properties, delta: run.chunks.join('') },
    };
  }
  return out;
}

export function createEventBatcher(options: EventBatcherOptions): EventBatcher {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let queue: StreamEvent[] = [];
  let timer: TimerHandle | undefined;
  /** Whether the pending timer is the next-tick (urgent) one. */
  let timerIsUrgent = false;

  const cancelTimer = () => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
    timerIsUrgent = false;
  };

  const flush = () => {
    cancelTimer();
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    options.apply(coalesceEvents(batch));
  };

  const arm = (urgent: boolean) => {
    if (timer !== undefined && (timerIsUrgent || !urgent)) return;
    cancelTimer();
    timerIsUrgent = urgent;
    // A trailing window: the first event of a batch waits at most one
    // interval, and the next timer is armed only after this one flushes.
    timer = setTimer(
      () => {
        timer = undefined;
        timerIsUrgent = false;
        flush();
      },
      urgent ? 0 : FLUSH_INTERVAL_MS,
    );
  };

  return {
    enqueue(event) {
      queue.push(event);
      if (queue.length >= MAX_QUEUE_SIZE) {
        flush();
        return;
      }
      arm(URGENT_EVENT_TYPES.has(event.type));
    },
    flush,
    clear() {
      cancelTimer();
      queue = [];
    },
  };
}
