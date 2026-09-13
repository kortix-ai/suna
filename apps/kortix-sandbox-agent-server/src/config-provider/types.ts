/**
 * Shared contract between the config-provider coordinator and its two
 * transports (git, s3). Acquisition only: a provider lands the project at
 * `target` (or a private stage under it); selection, fallback, telemetry and
 * activation belong to `config-provider.ts`.
 */
import type { Config } from '../config'

export type ConfigProviderName = 'git' | 's3'

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

export class ConfigProviderError extends Error {
  constructor(
    readonly stage: S3Stage,
    readonly reason: S3FailureReason,
    message: string,
    readonly attempts = 0,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'ConfigProviderError'
  }
  get retryable(): boolean {
    return S3_RETRYABLE_REASONS.has(this.reason)
  }
}

export interface MaterializeRequest {
  cfg: Config
  /** The writable project directory (`cfg.projectTarget`). */
  target: string
  /** The base branch name (`cfg.defaultBranch`). */
  base: string
  /** Trusted exact full SHA the checkout must land on, when the API pinned one. */
  expectedSha: string | null
  /** Stops acquisition; a cancelled acquisition never falls back. */
  signal?: AbortSignal
  /** Total budget for the S3 attempt including retries. */
  deadlineMs: number
}

export interface S3AcquisitionMetrics {
  attempts: number
  bytes: number
  entries: number
  descriptorMs: number
  /** Transfer of the boot object into the stage file (hash + header guard run on the stream). */
  downloadMs: number
  /** Extraction of the verified file into the stage directory. */
  extractMs: number
  verifyMs: number
  /** Which extractor unpacked the tree: the system `tar` or the in-process fallback. */
  extractor: 'tar' | 'node-tar'
}

/**
 * The blob-pack import that follows activation. `pending` while it runs;
 * `failed` leaves a valid partial clone that fetches blobs lazily through the
 * Git proxy (slower, never broken). Never on the boot path.
 */
export interface SnapshotHydrationSummary {
  status: 'pending' | 'ok' | 'failed'
  attempts: number
  bytes: number
  ms: number
  reason: S3FailureReason | null
  error: string | null
}

export interface MaterializedProject {
  provider: ConfigProviderName
  /** HEAD after activation, read back from the workspace. */
  sha: string | null
  expectedSha: string | null
  workspacePath: string
  /** Per-stage wall clock, ms. */
  timings: Record<string, number>
  /** Present when S3 was attempted and the Git provider delivered instead. */
  fallback?: {
    from: 's3'
    stage: S3Stage
    reason: S3FailureReason
    attempts: number
    durationMs: number
  }
  s3?: S3AcquisitionMetrics
  /** Present on an S3 start: settles when the blob pack is imported (or given up on). */
  hydration?: Promise<SnapshotHydrationSummary>
}

/** Health-visible, low-cardinality summary of what this boot's acquisition did. */
export interface ConfigProviderSummary {
  mode: NonNullable<Config['projectSnapshotMode']>
  provider: ConfigProviderName | null
  expected_sha: string | null
  actual_sha: string | null
  sha_matches: boolean | null
  s3_attempted: boolean
  s3_attempts: number
  s3_failed: boolean
  /** Ineligible for S3 (not fresh, no pin, …): a Git-only start with the reason recorded, not a failure. */
  s3_skipped: boolean
  s3_stage: S3Stage | null
  s3_reason: S3FailureReason | null
  /** Which extractor unpacked the boot object on an S3 start. */
  s3_extractor: 'tar' | 'node-tar' | null
  fallback: boolean
  total_ms: number
  timings: Record<string, number>
  outcome: 'ok' | 'error'
  error: string | null
  /** Blob-pack import state after an S3 start; null on every other path. Updated in place as it settles. */
  hydration: SnapshotHydrationSummary | null
}
