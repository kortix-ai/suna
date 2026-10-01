/**
 * sse-transport — how the live session stream's bytes arrive on React Native.
 *
 * `@kortix/sdk` owns the stream: reconnect, backoff, resume, the heartbeat
 * watchdog, coalescing and the reducer. It asks the host for one connection at
 * a time (`configureKortix({ eventStreamTransport })`). This adapter supplies
 * that connection over `react-native-sse`, an `XMLHttpRequest` wire, which is
 * the wire this app has always used on a device.
 *
 * The XHR keeps the whole response body in one JS string until the connection
 * closes. Past `STREAM_RECYCLE_BYTES` the adapter ends the connection, after
 * the network chunk in hand is delivered. The SDK reconnects at once and
 * re-reads the open transcripts, so nothing emitted in between is lost.
 *
 * No React Native import: `bun test` drives it with a fake `EventSource`.
 */
import type { RuntimeEventMessage, RuntimeEventTransport } from '@kortix/sdk';

/** Received bytes after which one connection is recycled. */
export const STREAM_RECYCLE_BYTES = 2 * 1024 * 1024;

/** The part of `react-native-sse`'s `EventSource` this adapter uses. */
export interface SseEventSource {
  addEventListener(type: 'message' | 'error' | 'close', listener: (event: any) => void): void;
  removeAllEventListeners(): void;
  close(): void;
  /** Library internal: called when a response finishes, to open the next one. */
  _pollAgain?: (time: number, allowZero: boolean) => void;
}

export interface SseTransportDeps {
  EventSource: new (
    url: string,
    options: { headers: Record<string, string>; pollingInterval: number; timeoutBeforeConnection: number },
  ) => SseEventSource;
  /** The stream answered 401 or 403: check whether the login ended. */
  onUnauthorized?: () => void;
  recycleBytes?: number;
}

export function createSseTransport(deps: SseTransportDeps): RuntimeEventTransport {
  const recycleBytes = deps.recycleBytes ?? STREAM_RECYCLE_BYTES;
  return async function* ({ url, headers, signal }) {
    const queue: RuntimeEventMessage[] = [];
    let ended = false;
    let failure: Error | null = null;
    let wake: (() => void) | null = null;
    let received = 0;
    let recycleTimer: ReturnType<typeof setTimeout> | null = null;

    const end = (error?: Error) => {
      if (ended) return;
      ended = true;
      failure = error ?? null;
      wake?.();
    };

    const requestHeaders: Record<string, string> = {};
    headers.forEach((value, name) => {
      requestHeaders[name] = value;
    });
    // `pollingInterval: 0`: the library never re-opens a finished response by
    // itself. The constructor has already scheduled the one open.
    const source = new deps.EventSource(url, {
      headers: requestHeaders,
      pollingInterval: 0,
      timeoutBeforeConnection: 0,
    });
    // A finished response calls this whatever `pollingInterval` is: it ends
    // the connection, and the SDK decides when the next one opens.
    if (typeof source._pollAgain === 'function') source._pollAgain = () => end();

    source.addEventListener('message', (event) => {
      if (ended || typeof event?.data !== 'string' || !event.data) return;
      queue.push(typeof event.lastEventId === 'string' ? { data: event.data, id: event.lastEventId } : { data: event.data });
      received += event.data.length;
      // After this dispatch: the library delivers the rest of the network
      // chunk synchronously, and ending now would drop it.
      if (received >= recycleBytes && !recycleTimer) recycleTimer = setTimeout(() => end(), 0);
      wake?.();
    });
    source.addEventListener('error', (event) => {
      const status = typeof event?.xhrStatus === 'number' && event.xhrStatus > 0 ? event.xhrStatus : undefined;
      if (status === 401 || status === 403) deps.onUnauthorized?.();
      const error = new Error(`SSE failed: ${status ?? event?.type ?? 'error'}`);
      end(status === undefined ? error : Object.assign(error, { status }));
    });
    source.addEventListener('close', () => end());
    const onAbort = () => end();
    if (signal.aborted) end();
    else signal.addEventListener('abort', onAbort);

    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift() as RuntimeEventMessage;
        if (ended) {
          if (failure) throw failure;
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    } finally {
      ended = true;
      signal.removeEventListener('abort', onAbort);
      if (recycleTimer) clearTimeout(recycleTimer);
      // Listeners first: `close()` dispatches `close`, and the library can
      // still deliver a buffered error after it.
      source.removeAllEventListeners();
      source.close();
    }
  };
}
