import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Config } from '../config/config'
import { runGit } from '../git/git'
import { logger } from '../log/logger'
import type { ProjectSnapshotDescriptor } from './contract'
import { fetchProjectSnapshotDescriptor } from './descriptor'
import { ProjectSnapshotError, errorMessage, type S3FailureReason } from './errors'
import { streamObject, type SnapshotTransferOptions } from './transfer'

/** Hydration runs after readiness: its own attempts and budget. */
export const HYDRATION_MAX_ATTEMPTS = 3

export const DEFAULT_HYDRATION_TIMEOUT_MS = 120_000

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

/**
 * The snapshot ships an index with no stat data, so the first `git status`
 * would stat and hash every file. Do that once here, right after activation,
 * off the boot path; it needs no blob. Best effort.
 */
export async function refreshSnapshotIndex(target: string): Promise<number> {
  const t0 = Date.now()
  const res = await runGit(['-C', target, 'update-index', '-q', '--refresh'])
  if (res.code !== 0) {
    logger.warn('[project-snapshot] index refresh after snapshot activation failed', { stderr: res.stderr.slice(0, 200) })
  }
  return Date.now() - t0
}

/**
 * Import the blob pack into the activated workspace through
 * `git index-pack --stdin`, hashing the stream on the way. index-pack
 * validates every object it writes; the digest check guards against the
 * wrong pack. Marks the imported pack promisor like the boot pack. Retries
 * transient failures; a refused (expired) URL re-fetches the descriptor once
 * per attempt. Returns a summary — never throws: a failed hydration leaves a
 * valid partial clone that fetches blobs lazily through the proxy.
 */
export async function hydrateProjectSnapshotBlobs(
  cfg: Config,
  target: string,
  descriptor: ProjectSnapshotDescriptor,
  options: SnapshotTransferOptions & { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SnapshotHydrationSummary> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS
  const packDir = join(target, '.git', 'objects', 'pack')
  let current = descriptor
  let attempts = 0
  let bytes = 0
  let lastError: ProjectSnapshotError | null = null
  while (attempts < HYDRATION_MAX_ATTEMPTS) {
    attempts += 1
    if (options.signal?.aborted) {
      lastError = new ProjectSnapshotError('hydrate', 'cancelled', 'hydration cancelled', attempts)
      break
    }
    const child = spawn('git', ['-C', target, 'index-pack', '--stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    child.stdin.on('error', () => {})
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }))
      child.on('error', () => resolve({ code: -1, signal: null }))
    })
    const packSum = () => stdout.match(/^pack\t([0-9a-f]{40,64})/m)?.[1] ?? null
    try {
      const streamed = await streamObject(
        current.blobs.url,
        { bytes: current.blobs.bytes, sha256: current.blobs.sha256 },
        { sink: child.stdin },
        {
          fetchImpl: options.fetchImpl,
          signal: options.signal,
          timeoutMs,
          inactivityTimeoutMs: options.inactivityTimeoutMs,
          accept: 'application/x-git-pack',
          stage: 'hydrate',
          digestStage: 'hydrate',
        },
      )
      bytes = streamed.received
      const exit = await exited
      const sum = packSum()
      if (exit.code !== 0 || !sum) {
        throw new ProjectSnapshotError('hydrate', 'malformed', `git index-pack exited ${exit.code}: ${stderr.trim().slice(0, 300)}`)
      }
      await writeFile(join(packDir, `pack-${sum}.promisor`), '')
      return { status: 'ok', attempts, bytes, ms: Date.now() - started, reason: null, error: null }
    } catch (err) {
      child.kill('SIGKILL')
      await exited
      // A pack index-pack finished writing from the WRONG bytes is valid git
      // data from another object; drop it rather than keep a stray.
      const sum = packSum()
      if (sum) {
        for (const ext of ['pack', 'idx', 'promisor', 'rev']) await rm(join(packDir, `pack-${sum}.${ext}`), { force: true }).catch(() => {})
      }
      const failure =
        err instanceof ProjectSnapshotError ? err : new ProjectSnapshotError('hydrate', 'unavailable', errorMessage(err), attempts, { cause: err })
      lastError = new ProjectSnapshotError(failure.stage, failure.reason, failure.message, attempts, { cause: failure.cause ?? failure })
      if (failure.reason === 'cancelled') break
      if (failure.reason === 'expired-authorization' && attempts < HYDRATION_MAX_ATTEMPTS) {
        try {
          current = await fetchProjectSnapshotDescriptor(cfg, descriptor.commit_sha, { fetchImpl: options.fetchImpl, signal: options.signal })
          continue
        } catch (refetch) {
          lastError = refetch instanceof ProjectSnapshotError ? refetch : lastError
          break
        }
      }
      if (!failure.retryable || attempts >= HYDRATION_MAX_ATTEMPTS) break
      const backoff = 500 * 2 ** (attempts - 1) + Math.floor(Math.random() * 250)
      logger.warn('[project-snapshot] hydration attempt failed; retrying', {
        attempt: attempts,
        reason: failure.reason,
        backoffMs: backoff,
        error: failure.message.slice(0, 200),
      })
      await new Promise((r) => setTimeout(r, backoff))
    }
  }
  return {
    status: 'failed',
    attempts,
    bytes,
    ms: Date.now() - started,
    reason: lastError?.reason ?? 'unavailable',
    error: (lastError?.message ?? 'hydration failed').slice(0, 300),
  }
}
