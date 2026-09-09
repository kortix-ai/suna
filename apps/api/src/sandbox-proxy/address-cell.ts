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

/**
 * Did the URL itself name the session?
 *
 * The browser's in-box base is `/v1/p/<id>/<port>`. When `<id>` is the
 * session's own `sandbox_id` — which IS its session id — `loadSandbox` resolved
 * that exact row and `record.sessionId` is the session being viewed, no matter
 * how many sessions the box holds. When `<id>` is the box's `external_id`, the
 * row is whichever the ordering preferred and says nothing about the viewer;
 * the caller must fall back to the sole-session rule (`soleSessionOfSandbox`).
 *
 * Pure, so the distinction is asserted rather than reproduced with two
 * sessions on one runner.
 */
export function sessionNamedByUrl(
  urlId: string | null | undefined,
  record: { sandboxId?: string | null; externalId?: string | null; sessionId?: string | null } | null | undefined,
): string | null {
  const id = urlId?.trim();
  if (!id || !record?.sandboxId || !record.sessionId) return null;
  // Named the session AND not the box. In real rows the two ids never
  // coincide (a uuid against `sbx_…`), so this costs nothing there; where a
  // fixture gives both the same value the stricter, box-shaped rule applies —
  // an ambiguous name must not be treated as an exact one.
  if (record.externalId === id) return null;
  return record.sandboxId === id ? record.sessionId : null;
}

/**
 * A CALLER THAT NAMES ITS SESSION GETS ITS OWN ROW, on a box that holds many.
 *
 * The API's own prompt delivery forwards by the BOX (`forwardToSandbox(
 * externalId, …)`) while carrying `callerSessionId`. Resolved by box on a
 * shared runner, the row was whichever session the ordering preferred, and
 * the turn admission then bound the prompt to THAT session: measured on dev
 * 2026-09-09, two sessions on one runner, the first delivered in 913 ms and
 * the second hung for 45 s (`delivered=+45267ms`) and never ran.
 *
 * `own` is the caller's session row, looked up separately. It is taken only
 * when it sits on the SAME box the URL resolved to — a caller must not be able
 * to redirect a request to a box it did not name — and when it really is the
 * caller's. Otherwise the resolved row stands.
 */
export function ownRowForCaller<R extends { externalId?: string | null; sessionId?: string | null }>(
  resolved: R,
  own: R | null | undefined,
  callerSessionId: string | null | undefined,
): R {
  const caller = callerSessionId?.trim();
  if (!caller || !own) return resolved;
  if (resolved.sessionId === caller) return resolved;
  if (own.sessionId !== caller) return resolved;
  if (!own.externalId || own.externalId !== resolved.externalId) return resolved;
  return own;
}

