import { rm } from 'node:fs/promises'

import type { Config } from '../config/config'
import { createStagePath } from '../git/git'
import { logger } from '../log/logger'
import { downloadAndExtractProjectSnapshot } from './archive'
import type { ProjectSnapshotDescriptor, ProjectSnapshotPin } from './contract'
import { fetchProjectSnapshotDescriptor, parseEnvProjectSnapshotDescriptor } from './descriptor'
import { ProjectSnapshotError, errorMessage } from './errors'
import type { SnapshotTransferOptions } from './transfer'
import { verifyExtractedProjectSnapshot } from './verify'

export interface StageProjectSnapshotRequest {
  cfg: Config
  /** The directory the private stage is created in (`createStagePath`). */
  target: string
  /** The commit, and the boot object's identity the caller pinned for it. */
  sha: string
  pin: ProjectSnapshotPin
  /** Total budget, every attempt included. */
  deadlineMs: number
  /** Stops the transfer; a cancelled staging is never retried. */
  signal?: AbortSignal
}

/** Attempts within the total deadline; only transient failures are retried. */
export const S3_MAX_ATTEMPTS = 3

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
  /** Where the descriptor that succeeded came from: the session env (presigned at create) or the Git proxy. */
  descriptorSource: 'env' | 'proxy'
}

export interface S3Acquisition {
  /** Verified stage under the target, ready for finalization. */
  stage: string
  descriptor: ProjectSnapshotDescriptor
  metrics: S3AcquisitionMetrics
}

/**
 * Acquire the pinned boot object into a fresh stage. Retries transient
 * failures with jittered backoff inside `req.deadlineMs`; returns the verified
 * stage. Never activates, never falls back, never leaves a stage behind on
 * failure.
 */
export async function stageProjectSnapshot(
  req: StageProjectSnapshotRequest,
  options: SnapshotTransferOptions = {},
): Promise<S3Acquisition> {
  const { sha, pin } = req
  // The descriptor the API presigned at create serves the FIRST attempt only
  // (one direct GET from the store, no proxy round trip); every retry asks the
  // proxy for fresh URLs.
  let envDescriptor = parseEnvProjectSnapshotDescriptor(req.cfg, sha)
  const deadline = Date.now() + req.deadlineMs
  let attempts = 0
  let lastError: ProjectSnapshotError | null = null
  while (attempts < S3_MAX_ATTEMPTS) {
    attempts += 1
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new ProjectSnapshotError(lastError?.stage ?? 'download', 'timeout', `S3 acquisition deadline (${req.deadlineMs}ms) exhausted after ${attempts - 1} attempt(s)`, attempts - 1, { cause: lastError })
    }
    if (req.signal?.aborted) throw new ProjectSnapshotError('download', 'cancelled', 'acquisition cancelled', attempts - 1)
    const stage = await createStagePath(req.target, 'snapshot')
    let descriptorSource: 'env' | 'proxy' = 'proxy'
    try {
      const t0 = Date.now()
      let descriptor: ProjectSnapshotDescriptor
      if (envDescriptor) {
        descriptor = envDescriptor
        envDescriptor = null
        descriptorSource = 'env'
      } else {
        descriptor = await fetchProjectSnapshotDescriptor(req.cfg, sha, { fetchImpl: options.fetchImpl, signal: req.signal })
      }
      const descriptorMs = Date.now() - t0
      if (descriptor.tree.sha256 !== pin.sha256 || descriptor.tree.bytes !== pin.bytes) {
        throw new ProjectSnapshotError('descriptor', 'revision-mismatch', 'descriptor names a different boot object than the session pin')
      }
      const downloaded = await downloadAndExtractProjectSnapshot(descriptor, stage, {
        fetchImpl: options.fetchImpl,
        signal: req.signal,
        timeoutMs: Math.max(1_000, deadline - Date.now()),
        inactivityTimeoutMs: options.inactivityTimeoutMs,
        tarBinary: options.tarBinary,
      })
      const v0 = Date.now()
      await verifyExtractedProjectSnapshot(stage, descriptor)
      return {
        stage,
        descriptor,
        metrics: {
          attempts,
          bytes: downloaded.bytes,
          entries: downloaded.entries,
          descriptorMs,
          downloadMs: downloaded.downloadMs,
          extractMs: downloaded.extractMs,
          verifyMs: Date.now() - v0,
          extractor: downloaded.extractor,
          descriptorSource,
        },
      }
    } catch (err) {
      await rm(stage, { recursive: true, force: true }).catch(() => {})
      await rm(`${stage}.tgz`, { force: true }).catch(() => {})
      const failure =
        err instanceof ProjectSnapshotError
          ? err
          : new ProjectSnapshotError('extract', 'unavailable', errorMessage(err), attempts, { cause: err })
      lastError = new ProjectSnapshotError(failure.stage, failure.reason, failure.message, attempts, { cause: failure.cause ?? failure })
      // A URL presigned at create that the store refuses (clock skew, a slow
      // provider create) is a stale descriptor, not a denial: the next attempt
      // asks the proxy for a fresh one instead of falling back to Git.
      const staleEnvUrl = descriptorSource === 'env' && failure.reason === 'expired-authorization'
      if (!(failure.retryable || staleEnvUrl) || attempts >= S3_MAX_ATTEMPTS) throw lastError
      const backoff = Math.min(300 * 2 ** (attempts - 1) + Math.floor(Math.random() * 250), Math.max(0, deadline - Date.now()))
      logger.warn('[project-snapshot] s3 attempt failed; retrying', {
        attempt: attempts,
        stage: failure.stage,
        reason: failure.reason,
        backoffMs: backoff,
        error: failure.message.slice(0, 200),
      })
      if (backoff > 0) await new Promise((r) => setTimeout(r, backoff))
    }
  }
  throw lastError ?? new ProjectSnapshotError('download', 'unavailable', 'S3 acquisition failed', attempts)
}
