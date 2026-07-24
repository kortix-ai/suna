/**
 * How a failed session create resolves, keyed by the server's error code.
 *
 * - `upgrade`  → open the Team-plan dialog (billing said no); stay put.
 * - `silent`   → the global 429 handler already surfaced it; stay put.
 * - `connect`  → a required connector isn't connected — open the connect-to-start
 *               gate so the user connects their own account and retries; stay put.
 * - `toast`    → terminal failure the user must see; stay put.
 *
 * Every branch stays on the current page: `useNewProjectSession` only navigates
 * AFTER a successful create, so there is no optimistic route to unwind. (The
 * old navigate-first flow bounced `router.replace` back to the index on ANY
 * rejection — including client-side timeouts where the server had actually
 * committed the row, which read as "the session appeared in the sidebar but I
 * never left the index page".)
 */
export function resolveCreateFailure(
  code: string | undefined,
): 'upgrade' | 'silent' | 'connect' | 'toast' {
  if (code === 'subscription_required' || code === 'no_account') return 'upgrade';
  if (code === 'concurrent_session_limit') return 'silent';
  if (code === 'CONNECTOR_CONNECTION_REQUIRED') return 'connect';
  return 'toast';
}
