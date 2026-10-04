import { UNKNOWN_DAEMON_ROUTE_ERROR } from '@kortix/api-contract/runtime-relay';

// Current daemons ship no share routes, so `/kortix/share` answers this.
export { UNKNOWN_DAEMON_ROUTE_ERROR };

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
