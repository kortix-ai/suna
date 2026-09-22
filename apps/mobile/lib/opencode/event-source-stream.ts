/**
 * EventSource → AsyncIterable. The whole of mobile's live-streaming code.
 *
 * WHY THIS IS ALL THAT IS LEFT. This file replaces `event-stream.ts`, 655 lines
 * that reimplemented reconnect, exponential backoff, a heartbeat watchdog, event
 * coalescing and gap rehydration — every one of them a second copy of logic
 * `@kortix/sdk`'s `openEventStream` already owned. The copies had diverged, and
 * a bug fixed in one stayed live in the other.
 *
 * The only thing that was ever genuinely mobile-specific is the wire: React
 * Native's `fetch` exposes no `response.body` and Hermes has no
 * `TextDecoderStream`, so `@opencode-ai/sdk`'s `client.global.event()` — which
 * reads `response.body.pipeThrough(new TextDecoderStream()).getReader()` —
 * cannot resolve here at all. `react-native-sse` can.
 *
 * So this bridges that one difference and stops. It opens a connection, parses
 * frames, and reports failure. It does NOT retry: the SDK's
 * `EventStreamTransport` contract is explicit that a rejection means "this
 * attempt failed", and `openEventStream` decides whether and when to try again.
 * A retry added here would recreate the divergence this file exists to end.
 *
 * `event-source-stream.test.ts` pins both halves of that contract.
 */

/** The slice of `react-native-sse`'s EventSource this bridge uses. */
export interface EventSourceLike {
  addEventListener(type: string, listener: EventSourceListener): void;
  close(): void;
}

export type EventSourceListener = (event: any) => void;

export interface OpenEventSourceStreamOptions {
  /** Runtime base url — the `/p/<externalId>/<port>` proxy origin. */
  url: string;
  /** Aborts this attempt; ends the iterable and closes the connection. */
  signal: AbortSignal;
  /** Injected so the bridge is testable without a React Native runtime. */
  createEventSource: (url: string) => EventSourceLike;
}

/**
 * An error carrying the HTTP status in the shape `openEventStream` reads.
 *
 * Its hard-failure classifier looks at
 * `(error as { cause?: { status?: unknown } }).cause?.status` — the shape
 * `@opencode-ai/sdk`'s error-interceptor produces on web. Matching it here is
 * what lets a 401/403 from a dead or foreign sandbox reach the SDK's park path
 * instead of retrying forever. The old stream had to keep its own
 * `authFailedUrlRef` halt precisely because nothing carried the status across.
 */
function eventSourceError(message: string, status?: number): Error {
  return new Error(message, status === undefined ? undefined : { cause: { status } });
}

/**
 * Open one SSE connection and expose its frames as an async iterable.
 *
 * Resolves values verbatim — the GlobalEvent envelope
 * (`{ directory, payload }`) is left intact, because `openEventStream` unwraps
 * `payload` itself. Unwrapping here too would double-unwrap.
 */
export function openEventSourceStream(
  options: OpenEventSourceStreamOptions,
): AsyncIterable<unknown> {
  const { url, signal, createEventSource } = options;

  const buffered: unknown[] = [];
  let waiter: {
    resolve: (result: IteratorResult<unknown>) => void;
    reject: (error: unknown) => void;
  } | null = null;
  let ended = false;
  let pendingError: unknown = null;
  let source: EventSourceLike | null = null;

  const finish = (error?: unknown): void => {
    if (ended) return;
    ended = true;
    source?.close();
    source = null;
    if (!waiter) {
      if (error) pendingError = error;
      return;
    }
    const settle = waiter;
    waiter = null;
    if (error) settle.reject(error);
    else settle.resolve({ value: undefined, done: true });
  };

  const push = (value: unknown): void => {
    if (ended) return;
    if (!waiter) {
      buffered.push(value);
      return;
    }
    const settle = waiter;
    waiter = null;
    settle.resolve({ value, done: false });
  };

  // An attempt aborted before it opened must not leave a live connection
  // behind — that is how a flapping sandbox stacks duplicate streams.
  if (!signal.aborted) {
    signal.addEventListener('abort', () => finish(), { once: true });
    source = createEventSource(`${url}/global/event`);

    source.addEventListener('message', (event) => {
      const data = event?.data;
      // Keepalives arrive as empty frames and malformed frames do happen; both
      // are noise, not the end of the stream.
      if (typeof data !== 'string' || data.length === 0) return;
      try {
        push(JSON.parse(data));
      } catch {
        // Not JSON — ignore, exactly as a keepalive.
      }
    });

    source.addEventListener('error', (event) => {
      const status = typeof event?.xhrStatus === 'number' ? event.xhrStatus : undefined;
      finish(eventSourceError(event?.message || 'SSE connection error', status));
    });
  } else {
    ended = true;
  }

  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown> {
      return {
        next: (): Promise<IteratorResult<unknown>> => {
          if (buffered.length > 0) {
            return Promise.resolve({ value: buffered.shift(), done: false });
          }
          if (pendingError) {
            const error = pendingError;
            pendingError = null;
            return Promise.reject(error);
          }
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve, reject) => {
            waiter = { resolve, reject };
          });
        },
        return: (): Promise<IteratorResult<unknown>> => {
          finish();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}
