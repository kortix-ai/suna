/**
 * Poll schedule for the connector intake's `opened` phase.
 *
 * Pipedream's hosted connect page runs in a popup we cannot observe, and it has
 * no callback into us — so the only way this window learns the connection
 * landed is to ask the API. `POST /setup-links/connectors/:token/finalize` is
 * that question, and it is also what persists the credential and notifies the
 * requesting session, so the poll is load-bearing, not cosmetic.
 *
 * The first poll waits ~3s (nobody finishes an OAuth faster than that) and the
 * rest run every 5s, inside a 5-minute window. Bounded on purpose: an abandoned
 * tab must stop asking, and the public route is rate-limited to 30 requests per
 * token per minute — 12/min leaves room for a second tab on the same link.
 */
export const CONNECTOR_POLL_FIRST_DELAY_MS = 3_000;
export const CONNECTOR_POLL_INTERVAL_MS = 5_000;
export const CONNECTOR_POLL_WINDOW_MS = 5 * 60_000;

/**
 * Delay before poll number `attempt` (0-based), or `null` when the window has
 * closed and polling must stop. `elapsedMs` is measured from the moment the
 * connect popup was opened.
 */
export function nextConnectorPollDelay(attempt: number, elapsedMs: number): number | null {
  const delay = attempt === 0 ? CONNECTOR_POLL_FIRST_DELAY_MS : CONNECTOR_POLL_INTERVAL_MS;
  if (elapsedMs + delay > CONNECTOR_POLL_WINDOW_MS) return null;
  return delay;
}
