/**
 * Dependency-inverted hook so the platform provisioning layer can tell a channel
 * (Slack, Teams) that a session it spun up died during async provisioning —
 * WITHOUT platform/ importing channels/.
 *
 * Why this exists: a Slack mention creates a session and returns immediately; the
 * sandbox provisions in a detached background task. If that fails (provider at
 * capacity, git-auth, …) the agent never runs, so no step/answer ever reaches the
 * thread and the ⏳ sits until the 30-min GC closes it with the wrong reason. The
 * channel registers a notifier at startup; provisioning calls
 * notifySessionProvisioningFailed() so the friendly reason reaches the thread in
 * seconds.
 *
 * Fire-and-forget + best-effort: a relay failure must never break provisioning
 * cleanup, and it's a no-op when no channel registered or the session isn't
 * channel-backed (the relay just finds no turn to close).
 *
 * Every channel's relay is called, and each acts only on its own turn row: a
 * Slack row has no `channel_ref`, a Teams row has one. This used to hold ONE
 * notifier ("last wins"). Slack registered it and loaded any turn row by
 * session id, so in a project with both installed a Teams session that failed
 * to start was taken for a Slack turn: the Slack post failed, and the Teams
 * turn row was deleted with its card still spinning.
 */

// Return value is ignored (the relay's boolean result is irrelevant to the
// caller); allow any so a Promise<boolean>-returning relay registers cleanly.
type SessionFailureNotifier = (sessionId: string, message: string) => unknown;

const notifiers = new Set<SessionFailureNotifier>();

/**
 * A channel registers its relay here at startup. Registering the same function
 * twice keeps one. Returns the function that removes it.
 */
export function registerSessionFailureNotifier(fn: SessionFailureNotifier): () => void {
  notifiers.add(fn);
  return () => {
    notifiers.delete(fn);
  };
}

/**
 * Tell every registered channel a session failed to provision. Never throws and
 * never blocks the caller — provisioning cleanup must not depend on it, and one
 * channel's failure does not stop another's.
 */
export function notifySessionProvisioningFailed(sessionId: string, message: string): void {
  if (!sessionId) return;
  for (const fn of notifiers) {
    try {
      void Promise.resolve(fn(sessionId, message)).catch((err) =>
        console.warn('[session-failure-notifier] relay failed', { sessionId, err: (err as Error)?.message }),
      );
    } catch (err) {
      console.warn('[session-failure-notifier] relay threw', { sessionId, err: (err as Error)?.message });
    }
  }
}
