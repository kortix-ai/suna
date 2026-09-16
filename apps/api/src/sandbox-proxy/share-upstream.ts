/**
 * The body the sandbox daemon returns for a `/kortix/*` path it does not serve
 * (kortix-sandbox-agent-server `proxy.ts`). Current daemons ship no share
 * routes, so `/kortix/share` answers this.
 */
export const UNKNOWN_DAEMON_ROUTE_ERROR = 'unknown kortix route';

/**
 * Map a daemon share answer to the `/v1/p/share` answer. A daemon without share
 * routes is a 501, so a 404 keeps meaning that the sandbox or the share token
 * does not exist. Not 502: the edge middleware in `index.ts` sends every 502 as
 * a retryable 503, and no retry adds a missing route. Every other answer passes
 * through.
 */
export function shareUpstreamResult(
  status: number,
  body: Record<string, unknown>,
): { status: number; body: Record<string, unknown> } {
  if (status === 404 && body.error === UNKNOWN_DAEMON_ROUTE_ERROR) {
    return { status: 501, body: { error: 'This sandbox does not support share links' } };
  }
  return { status, body };
}
