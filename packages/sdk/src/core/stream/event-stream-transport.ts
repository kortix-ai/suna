/**
 * The injectable SSE wire.
 *
 * WHY THIS EXISTS. `openEventStream` owns every hard part of live streaming —
 * connect timeout, idle heartbeat watchdog, event coalescing, exponential
 * reconnect backoff, and the terminal "parked" state for a dead sandbox. What
 * it does NOT own is how the bytes arrive: that comes from
 * `client.global.event()` in `@opencode-ai/sdk`, which reads
 *
 *     response.body.pipeThrough(new TextDecoderStream()).getReader()
 *
 * React Native's `fetch` has no `response.body`, and Hermes has no
 * `TextDecoderStream`. So that one call can never resolve on RN, and the whole
 * stream — reconnect logic included — was unreachable from `apps/mobile`.
 *
 * The cost of having no seam here was a 655-line second implementation of
 * reconnect/backoff/heartbeat/coalescing in `apps/mobile/lib/opencode/
 * event-stream.ts`, sitting beside this package's own. Two divergent copies of
 * the most failure-prone logic in the product, and a bug fixed in one was a bug
 * still live in the other.
 *
 * WHAT A TRANSPORT MAY DECIDE, AND WHAT IT MAY NOT. A transport answers exactly
 * one question: given a runtime URL and an abort signal, produce an async
 * iterable of OpenCode events. It must not retry, back off, or reconnect —
 * `openEventStream` does all of that, identically for every host, and
 * `event-stream-transport.test.ts` pins that a rejecting transport is retried
 * on the SHARED backoff schedule. A transport that grows its own retry loop
 * recreates the divergence this seam removed.
 *
 * WHY A MODULE-LEVEL REGISTRATION rather than an option threaded through every
 * call site: the wire is a property of the HOST, not of any one stream. A React
 * Native host registers once at startup, and every `useSession` in the app
 * streams without passing anything. This matches how the SDK already treats the
 * ambient runtime (`setCurrentRuntime`) and keeps the "one client per host"
 * rule intact.
 *
 * Framework-free and global-free by construction: this module holds a single
 * module-scoped variable and touches no `window`, `document`, or `process`.
 */

/** What a transport is told in order to open one connection. */
export interface EventStreamTransportInput {
  /**
   * Absolute base URL of the session runtime — the `/p/<externalId>/<port>`
   * proxy origin, with no trailing slash and no `/global/event` suffix. The
   * transport appends whatever path its wire needs.
   */
  url: string;
  /**
   * Aborts THIS connect attempt and the stream it produced. Fires on
   * `handle.close()`, on a heartbeat-forced reconnect, and on the connect
   * timeout. A transport must stop its connection when this fires and end its
   * iterable; leaking a live connection past an abort is what stacks duplicate
   * streams under a flapping sandbox.
   */
  signal: AbortSignal;
}

/**
 * Opens one SSE connection and returns its event stream.
 *
 * Reject to signal a failed connect — `openEventStream` classifies the failure
 * and schedules the retry. Never retry internally.
 */
export type EventStreamTransport = (
  input: EventStreamTransportInput,
) => Promise<{ stream: AsyncIterable<unknown> }>;

let registered: EventStreamTransport | null = null;

/**
 * Install the host's SSE wire, or pass `null` to fall back to the vendor
 * client's streaming `fetch`. Call once, at host startup, before any session
 * mounts.
 */
export function setEventStreamTransport(transport: EventStreamTransport | null): void {
  registered = transport;
}

/** The installed wire, or `null` when the vendor client's own stream is used. */
export function getEventStreamTransport(): EventStreamTransport | null {
  return registered;
}
