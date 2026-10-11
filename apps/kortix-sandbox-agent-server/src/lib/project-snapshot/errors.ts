/** How a project-snapshot transfer failed: the stage it reached and a classified reason. */

export type S3Stage =
  | 'precondition'
  | 'descriptor'
  | 'download'
  | 'extract'
  | 'verify'
  | 'activate'
  /** The post-activation blob-pack import (never on the boot path). */
  | 'hydrate'

/**
 * Why an S3 acquisition did not complete. Classified so the coordinator can
 * decide fallback vs. hard failure and so the telemetry names the cause.
 *
 *   retryable (within the total deadline): unavailable, timeout
 *   fallback-able, never retried:          missing, expired-authorization,
 *                                          malformed, digest-mismatch,
 *                                          revision-mismatch, limit-exceeded,
 *                                          no-pin, no-sha, pin-mismatch, not-fresh
 *   never fallback:                        denied (authorization is a denial),
 *                                          cancelled (the caller stopped boot)
 */
export type S3FailureReason =
  | 'not-fresh'
  | 'no-sha'
  | 'no-pin'
  | 'pin-mismatch'
  | 'not-configured'
  | 'missing'
  | 'denied'
  | 'expired-authorization'
  | 'unavailable'
  | 'timeout'
  | 'malformed'
  | 'digest-mismatch'
  | 'revision-mismatch'
  | 'limit-exceeded'
  | 'cancelled'

export const S3_RETRYABLE_REASONS: ReadonlySet<S3FailureReason> = new Set(['unavailable', 'timeout'])

export const S3_NO_FALLBACK_REASONS: ReadonlySet<S3FailureReason> = new Set(['denied', 'cancelled'])

export class ProjectSnapshotError extends Error {
  constructor(
    readonly stage: S3Stage,
    readonly reason: S3FailureReason,
    message: string,
    readonly attempts = 0,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ProjectSnapshotError'
  }
  get retryable(): boolean {
    return S3_RETRYABLE_REASONS.has(this.reason)
  }
}

export function abortReason(req: { signal?: AbortSignal }, timedOut: boolean): S3FailureReason {
  if (req.signal?.aborted) return 'cancelled'
  return timedOut ? 'timeout' : 'unavailable'
}

export function isAbortError(err: unknown): boolean {
  const name = (err as { name?: string })?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

export function errorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}
