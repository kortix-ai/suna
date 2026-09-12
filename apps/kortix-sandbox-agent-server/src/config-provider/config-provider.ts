/**
 * Config provider coordinator — the ONE entry point for fresh-boot project
 * acquisition. Owns selection, bounded fallback, telemetry and activation;
 * the transports (git/, s3/) own acquisition only.
 *
 *   mode `git`         warm adoption → Git (compiled / scaffold+delta / clone)
 *   mode `prefer-s3`   warm adoption → S3 (pinned archive) → on failure: Git
 *   mode `require-s3`  warm adoption → S3, no fallback
 *
 * The expected revision is pinned ONCE from KORTIX_BASE_SHA and preserved into
 * the Git fallback request. A fallback is never silent: the S3 failure is
 * logged as `config_provider_s3_failed`, the transition as
 * `config_provider_fallback`, and both stay visible on `/kortix/health`
 * (`config_provider`) and in the boot timeline the daemon relays at readiness.
 *
 * Never recurses between providers, never mixes a partial S3 stage with a Git
 * checkout (the stage is private and removed on failure; the target is
 * cleared before Git runs), and never falls back on cancellation or an
 * authorization denial.
 */
import type { Config, ProjectSnapshotMode } from '../config'
import { adoptOrClearBakedCheckout, clearDirContents, finalizeSnapshotStage, readRepoInfo } from '../git'
import { logger } from '../logger'
import { materializeViaGit } from './git/git-config-provider'
import { materializeFromS3 } from './s3/s3-config-provider'
import {
  ConfigProviderError,
  S3_NO_FALLBACK_REASONS,
  type ConfigProviderSummary,
  type MaterializeRequest,
  type MaterializedProject,
} from './types'

/** Total S3 budget (descriptor + download + extract + verify, all retries). */
export const DEFAULT_S3_DEADLINE_MS = 45_000

export interface MaterializeProjectOptions {
  signal?: AbortSignal
  bootMark?: (label: string) => void
  deadlineMs?: number
  /** Receives the health-visible summary on success AND on failure. */
  onSummary?: (summary: ConfigProviderSummary) => void
  /** Test seam for the S3 transport's HTTP. */
  fetchImpl?: typeof fetch
  /** Stall detector for the archive transfer; see DEFAULT_INACTIVITY_TIMEOUT_MS. */
  inactivityTimeoutMs?: number
}

export type MaterializeProjectResult = MaterializedProject & { summary: ConfigProviderSummary }

function trustedSha(cfg: Config): string | null {
  const sha = (cfg.baseSha ?? '').trim().toLowerCase()
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

function summarize(
  cfg: Config,
  mode: ProjectSnapshotMode,
  started: number,
  result: Partial<MaterializedProject> & { timings: Record<string, number> },
  s3: { attempted: boolean; attempts: number; error: ConfigProviderError | null },
  outcome: { ok: true } | { ok: false; error: string },
): ConfigProviderSummary {
  const expected = trustedSha(cfg)
  const actual = result.sha ?? null
  return {
    mode: mode,
    provider: result.provider ?? null,
    expected_sha: expected,
    actual_sha: actual,
    sha_matches: expected && actual ? expected === actual : null,
    s3_attempted: s3.attempted,
    s3_attempts: s3.attempts,
    s3_failed: s3.error !== null,
    s3_stage: s3.error?.stage ?? null,
    s3_reason: s3.error?.reason ?? null,
    fallback: result.fallback !== undefined,
    total_ms: Date.now() - started,
    timings: result.timings,
    outcome: outcome.ok ? 'ok' : 'error',
    error: outcome.ok ? null : outcome.error,
  }
}

export async function materializeProject(
  cfg: Config,
  opts: MaterializeProjectOptions = {},
): Promise<MaterializeProjectResult> {
  const started = Date.now()
  const timings: Record<string, number> = {}
  const mark = opts.bootMark ?? (() => {})
  const mode: ProjectSnapshotMode = cfg.projectSnapshotMode ?? 'git'
  const expectedSha = trustedSha(cfg)
  const req: MaterializeRequest = {
    cfg,
    target: cfg.projectTarget,
    base: cfg.defaultBranch,
    expectedSha,
    signal: opts.signal,
    deadlineMs: opts.deadlineMs ?? DEFAULT_S3_DEADLINE_MS,
  }
  const s3State = { attempted: false, attempts: 0, error: null as ConfigProviderError | null }

  const finish = (result: MaterializedProject): MaterializeProjectResult => {
    const summary = summarize(cfg, mode, started, result, s3State, { ok: true })
    logger.info('[config-provider] complete', {
      event: 'config_provider_complete',
      provider: result.provider,
      mode: mode,
      expectedSha,
      actualSha: result.sha,
      shaMatches: summary.sha_matches,
      fallback: result.fallback ?? null,
      s3: result.s3 ?? null,
      timings: result.timings,
      totalMs: summary.total_ms,
    })
    if (summary.sha_matches === false) {
      // Loud, not fatal: the legacy clone can also land on a newer tip when the
      // branch moved between session create and boot. Never silent.
      logger.warn('[config-provider] checkout SHA differs from the session pin', {
        event: 'config_provider_sha_drift',
        provider: result.provider,
        expectedSha,
        actualSha: result.sha,
      })
    }
    mark(result.provider === 's3' ? 'config-provider:s3:ok' : result.fallback ? 'config-provider:git:fallback' : 'config-provider:git:ok')
    opts.onSummary?.(summary)
    return { ...result, summary }
  }

  try {
    // Warm adoption first, in every mode: a baked checkout that IS this
    // session's base is the cheapest acquisition there is.
    const t0 = Date.now()
    const adopted = await adoptOrClearBakedCheckout(cfg)
    timings.warm = Date.now() - t0
    if (adopted) {
      const info = await readRepoInfo(cfg.projectTarget)
      mark('config-provider:warm')
      return finish({
        provider: 'git',
        sha: info?.commit ?? null,
        expectedSha,
        workspacePath: cfg.projectTarget,
        timings: { ...timings },
      })
    }

    if (mode === 'git') {
      const git = await materializeViaGit(req)
      return finish({ ...git, timings: { ...timings, ...git.timings } })
    }

    // prefer-s3 / require-s3
    s3State.attempted = true
    const s3Started = Date.now()
    try {
      const acquired = await materializeFromS3(req, {
        fetchImpl: opts.fetchImpl,
        inactivityTimeoutMs: opts.inactivityTimeoutMs,
      })
      s3State.attempts = acquired.metrics.attempts
      timings.s3_acquire = Date.now() - s3Started
      const a0 = Date.now()
      try {
        await finalizeSnapshotStage(cfg, acquired.stage)
      } catch (err) {
        throw new ConfigProviderError('activate', 'malformed', `snapshot activation failed: ${(err as Error)?.message ?? String(err)}`, acquired.metrics.attempts, { cause: err })
      }
      timings.s3_activate = Date.now() - a0
      const info = await readRepoInfo(cfg.projectTarget)
      return finish({
        provider: 's3',
        sha: info?.commit ?? null,
        expectedSha,
        workspacePath: cfg.projectTarget,
        timings: { ...timings },
        s3: acquired.metrics,
      })
    } catch (err) {
      const failure =
        err instanceof ConfigProviderError
          ? err
          : new ConfigProviderError('download', 'unavailable', (err as Error)?.message ?? String(err))
      s3State.error = failure
      s3State.attempts = Math.max(s3State.attempts, failure.attempts)
      const s3DurationMs = Date.now() - s3Started
      timings.s3_failed = s3DurationMs
      logger.warn('[config-provider] s3 acquisition failed', {
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
      logger.warn('[config-provider] falling back to git', {
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
      return finish({
        ...git,
        timings: { ...timings, ...git.timings },
        fallback: {
          from: 's3',
          stage: failure.stage,
          reason: failure.reason,
          attempts: failure.attempts,
          durationMs: s3DurationMs,
        },
      })
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    const summary = summarize(cfg, mode, started, { timings }, s3State, { ok: false, error: message })
    logger.error('[config-provider] materialization failed', {
      event: 'config_provider_complete',
      outcome: 'error',
      mode: mode,
      expectedSha,
      s3Stage: s3State.error?.stage ?? null,
      s3Reason: s3State.error?.reason ?? null,
      error: message.slice(0, 300),
      timings,
    })
    opts.onSummary?.(summary)
    throw err
  }
}
