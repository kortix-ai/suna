/**
 * `acquire` — a fresh checkout of the session's base, from the transport the
 * mode and the session allow:
 *
 *   mode `git`         Git (compiled / scaffold+delta / clone)
 *   mode `prefer-s3`   S3 (pinned archive) → on failure: Git
 *   mode `require-s3`  S3, no fallback
 *
 * The S3 transport is the project snapshot (lib/project-snapshot) finished
 * into a session checkout (checkout.ts); the Git transport is git.ts. Both
 * leave the same checkout. `provideWorkspace` (workspace-provider.ts) calls
 * this after the warm adoption, so the target is always empty here.
 */
import type { ProjectSnapshotMode } from '@/lib/config/config'
import { readRepoInfo } from '@/lib/git/git'
import { logger } from '@/lib/log/logger'
import { parseProjectSnapshotPin, type ProjectSnapshotPin } from '@/lib/project-snapshot/contract'
import { ProjectSnapshotError, S3_NO_FALLBACK_REASONS } from '@/lib/project-snapshot/errors'
import { hydrateProjectSnapshotBlobs, refreshSnapshotIndex } from '@/lib/project-snapshot/hydrate'
import { stageProjectSnapshot } from '@/lib/project-snapshot/stage'
import type { SnapshotTransferOptions } from '@/lib/project-snapshot/transfer'
import { clearDirContents, finalizeSnapshotStage } from './checkout'
import { acquireProjectViaGit } from './git'
import type { MaterializeRequest, MaterializedProject } from './types'

/** What `acquire` did with S3. Written in place, so the provider's summary has it when `acquire` throws. */
export interface S3Attempt {
  attempted: boolean
  attempts: number
  error: ProjectSnapshotError | null
  skipped: ProjectSnapshotError | null
}

/** The provider's state `acquire` reports into. */
export interface AcquireTrace {
  mode: ProjectSnapshotMode
  mark: (label: string) => void
  /** Per-stage wall clock; the provider's summary reads it. */
  timings: Record<string, number>
  s3: S3Attempt
}

/**
 * Is this boot eligible for an S3 attempt at all? Throws a `precondition`
 * ProjectSnapshotError naming why not. The coordinator treats these as
 * SKIPS (a Git-only start with a recorded reason), never as S3 failures: a
 * resumed/replacement session (`not-fresh`) must keep its remote-branch
 * restore semantics, and a session the API could not pin (`no-pin` = cache
 * miss) was never a pinned S3 attempt.
 */
export function checkS3Eligibility(req: MaterializeRequest): { sha: string; pin: ProjectSnapshotPin } {
  const cfg = req.cfg
  if (!cfg.sessionFresh) throw new ProjectSnapshotError('precondition', 'not-fresh', 'only a fresh session may materialize from a snapshot')
  if (!req.expectedSha) throw new ProjectSnapshotError('precondition', 'no-sha', 'no trusted base SHA (KORTIX_BASE_SHA) for this session')
  const pin = parseProjectSnapshotPin(cfg.projectSnapshotPin)
  if (!pin) throw new ProjectSnapshotError('precondition', 'no-pin', 'no prepared archive pinned for this session (cache miss)')
  if (pin.sha !== req.expectedSha) throw new ProjectSnapshotError('precondition', 'pin-mismatch', `pinned archive is for ${pin.sha}, session base is ${req.expectedSha}`)
  if (!cfg.repoUrl || !cfg.sandboxToken) throw new ProjectSnapshotError('precondition', 'not-configured', 'KORTIX_REPO_URL and KORTIX_TOKEN are required')
  return { sha: pin.sha, pin }
}

/**
 * Git transport: a thin adapter over the existing, optimized acquisition path
 * in `git.ts` (compiled checkout → image-baked scaffold + delta → clone). The
 * warm-checkout adoption runs in the provider before any transport, so this
 * always starts from an empty target. Nothing here changes what Git does; it
 * only reports what it delivered.
 */
async function materializeViaGit(req: MaterializeRequest): Promise<MaterializedProject> {
  const started = Date.now()
  await acquireProjectViaGit(req.cfg)
  const gitMs = Date.now() - started
  const info = await readRepoInfo(req.target)
  return {
    provider: 'git',
    sha: info?.commit ?? null,
    expectedSha: req.expectedSha,
    workspacePath: req.target,
    timings: { git: gitMs },
  }
}

export async function acquire(
  req: MaterializeRequest,
  trace: AcquireTrace,
  transport: SnapshotTransferOptions,
): Promise<MaterializedProject> {
  const { cfg, expectedSha } = req
  const { mode, mark, timings, s3: s3State } = trace

  if (mode === 'git') {
    const git = await materializeViaGit(req)
    return { ...git, timings: { ...timings, ...git.timings } }
  }

  // prefer-s3 / require-s3 — eligibility first. An ineligible boot is a
  // Git-only start with a RECORDED reason, never "a failed S3 attempt": a
  // resumed/replacement runtime (`not-fresh`) keeps its remote-branch restore
  // path in every mode; a session the API could not pin (`no-pin`, a cache
  // miss) never becomes a pinned S3 attempt and is fatal only under
  // require-s3, where "no prepared archive" is exactly what must surface.
  let eligible: { sha: string; pin: ProjectSnapshotPin }
  try {
    eligible = checkS3Eligibility(req)
  } catch (err) {
    const skip =
      err instanceof ProjectSnapshotError
        ? err
        : new ProjectSnapshotError('precondition', 'not-configured', (err as Error)?.message ?? String(err))
    if (mode === 'require-s3' && skip.reason !== 'not-fresh') throw skip
    s3State.skipped = skip
    logger.info('[workspace-provider] s3 skipped; git-only start', {
      event: 'config_provider_s3_skipped',
      mode,
      reason: skip.reason,
      expectedSha,
    })
    mark(`config-provider:s3:skipped:${skip.reason}`)
    const git = await materializeViaGit(req)
    return { ...git, timings: { ...timings, ...git.timings } }
  }
  s3State.attempted = true
  const s3Started = Date.now()
  try {
    const acquired = await stageProjectSnapshot(
      { cfg, target: req.target, sha: eligible.sha, pin: eligible.pin, deadlineMs: req.deadlineMs, signal: req.signal },
      {
        fetchImpl: transport.fetchImpl,
        inactivityTimeoutMs: transport.inactivityTimeoutMs,
        tarBinary: transport.tarBinary,
      },
    )
    s3State.attempts = acquired.metrics.attempts
    timings.s3_acquire = Date.now() - s3Started
    const a0 = Date.now()
    try {
      await finalizeSnapshotStage(cfg, acquired.stage)
    } catch (err) {
      throw new ProjectSnapshotError('activate', 'malformed', `snapshot activation failed: ${(err as Error)?.message ?? String(err)}`, acquired.metrics.attempts, { cause: err })
    }
    timings.s3_activate = Date.now() - a0
    const info = await readRepoInfo(cfg.projectTarget)

    // The boot path ends here. Two things follow OFF it, concurrently with
    // the runtime spawn: the one-time index refresh (so the agent's first
    // `git status` is instant; it takes the index lock, so it goes first)
    // and then the blob-pack import. Neither gates readiness; a failed
    // import leaves a valid partial clone.
    const hydration = refreshSnapshotIndex(cfg.projectTarget)
      .then(
        (ms) => logger.info('[workspace-provider] snapshot index refreshed', { ms }),
        (err) => logger.warn('[workspace-provider] snapshot index refresh errored', { err: (err as Error)?.message ?? String(err) }),
      )
      .then(() =>
        hydrateProjectSnapshotBlobs(cfg, cfg.projectTarget, acquired.descriptor, {
          fetchImpl: transport.fetchImpl,
          inactivityTimeoutMs: transport.inactivityTimeoutMs,
          signal: req.signal,
        }),
      )
    return {
      provider: 's3',
      sha: info?.commit ?? null,
      expectedSha,
      workspacePath: cfg.projectTarget,
      timings: { ...timings },
      s3: acquired.metrics,
      hydration,
    }
  } catch (err) {
    const failure =
      err instanceof ProjectSnapshotError
        ? err
        : new ProjectSnapshotError('download', 'unavailable', (err as Error)?.message ?? String(err))
    s3State.error = failure
    s3State.attempts = Math.max(s3State.attempts, failure.attempts)
    const s3DurationMs = Date.now() - s3Started
    timings.s3_failed = s3DurationMs
    logger.warn('[workspace-provider] s3 acquisition failed', {
      event: 'config_provider_s3_failed',
      mode: mode,
      projectId: cfg.projectId,
      sessionId: cfg.branchName,
      expectedSha,
      stage: failure.stage,
      reason: failure.reason,
      attempts: failure.attempts,
      durationMs: s3DurationMs,
      error: failure.message.slice(0, 300),
    })
    mark(`config-provider:s3:failed:${failure.reason}`)
    if (S3_NO_FALLBACK_REASONS.has(failure.reason) || mode === 'require-s3') {
      throw failure
    }
    logger.warn('[workspace-provider] falling back to git', {
      event: 'config_provider_fallback',
      from: 's3',
      to: 'git',
      reason: failure.reason,
      stage: failure.stage,
      expectedSha,
    })
    mark('config-provider:fallback')
    // ONE coordinated transition: the S3 stage is already gone; make sure no
    // partial activation survives either, then hand the SAME pinned request
    // to Git.
    await clearDirContents(cfg.projectTarget).catch(() => {})
    const git = await materializeViaGit(req)
    return {
      ...git,
      timings: { ...timings, ...git.timings },
      fallback: {
        from: 's3',
        stage: failure.stage,
        reason: failure.reason,
        attempts: failure.attempts,
        durationMs: s3DurationMs,
      },
    }
  }
}
