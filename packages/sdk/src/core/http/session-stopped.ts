const stoppedListeners = new Set<(sessionId: string) => void>();

/**
 * Tell every open `useSession` that a user Stop succeeded, so it re-reads
 * `/start` now instead of waiting for its next poll. Called by
 * `stopProjectSession`, the one Stop every host goes through.
 */
export function noteSessionStopped(sessionId: string): void {
  for (const listener of stoppedListeners) {
    try {
      listener(sessionId);
    } catch {
      // One listener's failure must not hide the stop from the others.
    }
  }
}

/** Returns the unsubscribe. */
export function onSessionStopped(listener: (sessionId: string) => void): () => void {
  stoppedListeners.add(listener);
  return () => {
    stoppedListeners.delete(listener);
  };
}
