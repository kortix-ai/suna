/**
 * TELLING THE CELL WHICH SESSION THE REQUEST IS FOR.
 *
 * The web client reaches the agent through the in-box path —
 * `/v1/p/<id>/8000/global/event`, `/session`, `/agent`, `/command` — and none
 * of those URLs names a session. A cell holds one isolate per session and picks
 * from `?c=`, so an unaddressed request can only be resolved from the node's
 * KORTIX_SESSION_ID: wrong on a shared host, and absent entirely on a box that
 * has been restarted (`sandbox.start` does not carry envVars). Either way the
 * cell refuses, the browser falls back to polling, and a reply that already
 * exists appears seconds later.
 *
 * The proxy has known the answer all along. `loadSandbox` resolves the row for
 * the id in the URL, and a session's `sandbox_id` IS its session id, so
 * `record.sessionId` is exactly the session being viewed. Measured on dev
 * 2026-09-09 while the user had the page open:
 *
 *   [probe] /global/event caller=ec9d2493… record=6d66d246-957f-48ad-8ecc-e567765a1832
 *
 * — `record` matching the session in the URL bar, on a box shared by four.
 *
 * Appending it is safe for every runtime, for the same reason `envPushUrl`
 * already appends one: this is a direct call to the sandbox's own origin and a
 * daemon ignores a parameter it does not read. An explicit `c=` from the caller
 * always wins, so nothing that already addresses a cell changes.
 */
export function addressCellSession(
  targetUrl: string,
  sessionId: string | null | undefined,
): string {
  const id = sessionId?.trim();
  if (!id) return targetUrl;
  try {
    const u = new URL(targetUrl);
    if (u.searchParams.has('c')) return targetUrl;
    u.searchParams.set('c', id);
    return u.toString();
  } catch {
    return targetUrl;
  }
}
