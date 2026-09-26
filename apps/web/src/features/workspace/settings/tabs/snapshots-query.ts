/**
 * Retry policy for `GET /projects/:id/snapshots`, shared by the Sandbox and
 * Snapshots tabs (both read one cache entry).
 *
 * The route reads the project's Dockerfile from the Git mirror and asks each
 * provider for build state. A cold mirror or a slow provider can hold it past
 * the client's 30 s timeout. The app default retries 3 times, so a timeout
 * held the skeleton for minutes before the error state could show. One retry
 * absorbs a blip. A 4xx is an answer, never retried.
 */
export function snapshotsQueryRetry(failureCount: number, error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number' && status >= 400 && status < 500) return false;
  return failureCount < 1;
}
