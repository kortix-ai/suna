/**
 * Shared contract between `provideWorkspace` (workspace-provider.ts) and its
 * two transports, git and s3 (acquire.ts). A transport lands the project at
 * `target` (or a private stage under it); selection, fallback, telemetry and
 * activation belong to the provider.
 */
import type { Config } from '@/lib/config/config'
import type { S3FailureReason, S3Stage } from '@/lib/project-snapshot/errors'
import type { SnapshotHydrationSummary } from '@/lib/project-snapshot/hydrate'
import type { S3AcquisitionMetrics } from '@/lib/project-snapshot/stage'

/** The transport that delivered the checkout. `provider` on the wire (`/kortix/health`). */
export type WorkspaceTransport = 'git' | 's3'

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

export interface MaterializedProject {
  provider: WorkspaceTransport
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
export interface WorkspaceProviderSummary {
  mode: NonNullable<Config['projectSnapshotMode']>
  provider: WorkspaceTransport | null
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
  /** On an S3 start: whether the descriptor came presigned in the env or was fetched from the proxy. */
  s3_descriptor: 'env' | 'proxy' | null
  fallback: boolean
  total_ms: number
  timings: Record<string, number>
  outcome: 'ok' | 'error'
  error: string | null
  /** Blob-pack import state after an S3 start; null on every other path. Updated in place as it settles. */
  hydration: SnapshotHydrationSummary | null
}
