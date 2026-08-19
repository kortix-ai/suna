export function markSessionReadinessTimeoutRetryable(error: unknown, sessionId: string): unknown {
  if (
    error instanceof Error &&
    error.message === `Timed out waiting for session runtime ready for ${sessionId}`
  ) {
    (error as Error & { ke2eRetryable?: boolean }).ke2eRetryable = true;
  }
  return error;
}
