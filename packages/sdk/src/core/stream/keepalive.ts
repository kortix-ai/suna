/**
 * The frame the sandbox daemon injects to keep an idle SSE connection warm
 * (`apps/kortix-sandbox-agent-server/src/sse-keepalive.ts`). It is minted one hop
 * ABOVE opencode, so it proves the proxy is reachable and says nothing about the
 * runtime.
 */
export const KORTIX_KEEPALIVE_EVENT = 'kortix.keepalive';

/**
 * Does this frame count as proof the RUNTIME is alive?
 *
 * Not re-exported from the package index; kept out of the public surface by
 * living in a file the SDK's `exports` map never lists.
 */
export function isRuntimeLivenessEvent(e: { type?: unknown } | undefined): boolean {
  if (!e || typeof e.type !== 'string' || e.type.length === 0) return false;
  return e.type !== KORTIX_KEEPALIVE_EVENT;
}

/**
 * Frames that prove only that a connection is open: the daemon keepalive, the
 * frame OpenCode writes when a subscription opens, and OpenCode's periodic
 * heartbeat. None of them carries runtime output.
 */
const CONNECTION_ONLY_EVENTS: ReadonlySet<string> = new Set([
  KORTIX_KEEPALIVE_EVENT,
  'server.connected',
  'server.heartbeat',
]);

/**
 * Does this frame carry runtime CONTENT?
 *
 * The event stream measures a reconnect gap from the last content frame, and
 * resyncs after a reconnect only when the dropped subscription delivered
 * content. A connection-only frame keeps the heartbeat watchdog quiet but says
 * nothing about whether the runtime's output still reaches this subscriber.
 */
export function isStreamContentEvent(e: { type?: unknown } | undefined): boolean {
  if (!e || typeof e.type !== 'string' || e.type.length === 0) return false;
  return !CONNECTION_ONLY_EVENTS.has(e.type);
}
