import { KE2E_RETRY_CLASS } from './flow';

/**
 * Mark the named session-runtime readiness timeout as retryable AND tag its
 * retry class, so the runner can give it its own (smaller) attempt budget
 * instead of the general infra budget. A 5–7 minute readiness wait retried
 * three times is one of the two biggest wall-clock multipliers in the suite.
 */
export function markSessionReadinessTimeoutRetryable(error: unknown, sessionId: string): unknown {
  if (
    error instanceof Error &&
    error.message === `Timed out waiting for session runtime ready for ${sessionId}`
  ) {
    const marked = error as Error & { ke2eRetryable?: boolean; ke2eRetryClass?: string };
    marked.ke2eRetryable = true;
    marked[KE2E_RETRY_CLASS as 'ke2eRetryClass'] = 'session-runtime';
  }
  return error;
}
