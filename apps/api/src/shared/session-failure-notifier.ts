/**
 * Dependency-inverted hook so the platform provisioning layer can tell a channel
 * (Slack today) that a session it spun up died during async provisioning — WITHOUT
 * platform/ importing channels/.
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
 */

// Return value is ignored (the relay's boolean result is irrelevant to the
// caller); allow any so a Promise<boolean>-returning relay registers cleanly.
type SessionFailureNotifier = (sessionId: string, message: string) => unknown;

let notifier: SessionFailureNotifier | null = null;

/** Channel layer registers its relay here at startup (idempotent — last wins). */
export function registerSessionFailureNotifier(fn: SessionFailureNotifier): void {
  notifier = fn;
}

/** Reset hook for tests. */
export function resetSessionFailureNotifier(): void {
  notifier = null;
}

/**
 * Tell the registered channel a session failed to provision. Never throws and
 * never blocks the caller — provisioning cleanup must not depend on it.
 */
export function notifySessionProvisioningFailed(sessionId: string, message: string): void {
  const fn = notifier;
  if (!fn || !sessionId) return;
  try {
    void Promise.resolve(fn(sessionId, message)).catch((err) =>
      console.warn('[session-failure-notifier] relay failed', { sessionId, err: (err as Error)?.message }),
    );
  } catch (err) {
    console.warn('[session-failure-notifier] relay threw', { sessionId, err: (err as Error)?.message });
  }
}
