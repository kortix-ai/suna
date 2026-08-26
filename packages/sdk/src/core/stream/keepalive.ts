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
