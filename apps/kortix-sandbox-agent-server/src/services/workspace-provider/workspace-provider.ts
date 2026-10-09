/**
 * Workspace provider — the ONE entry point that provides `/workspace` on a
 * boot. It decides which workspace the session gets and owns the telemetry
 * and the health summary; `acquire` (acquire.ts) decides how a fresh
 * checkout arrives (Git or S3).
 *
 *   warm adoption → acquire: mode `git`         Git (compiled / scaffold+delta / clone)
 *                            mode `prefer-s3`   S3 (pinned archive) → on failure: Git
 *                            mode `require-s3`  S3, no fallback
 *
 * The expected revision is pinned ONCE from KORTIX_BASE_SHA and preserved into
 * the Git fallback request. A fallback is never silent: the S3 failure is
 * logged as `config_provider_s3_failed`, the transition as
 * `config_provider_fallback`, and both stay visible on `/kortix/health`
 * (`config_provider`) and in the boot timeline the daemon relays at readiness.
 * Those wire names (events, health key, `config-provider:*` boot marks) predate
 * this service's rename and stay unchanged; dashboards and stored timelines
 * read them.
 *
 * Never recurses between transports, never mixes a partial S3 stage with a Git
 * checkout (the stage is private and removed on failure; the target is
 * cleared before Git runs), and never falls back on cancellation or an
 * authorization denial.
 */
import type { Config, ProjectSnapshotMode } from '@/lib/config/config'
import { readRepoInfo } from '@/lib/git/git'
import { logger } from '@/lib/log/logger'
import type { SnapshotHydrationSummary } from '@/lib/project-snapshot/hydrate'
import { acquire, type S3Attempt } from './acquire'
import { adoptOrClearBakedCheckout } from './checkout'
import { scheduleHistoryBackfill } from './git'
import type { MaterializeRequest, MaterializedProject, WorkspaceProviderSummary } from './types'

/** Total S3 budget (descriptor + download + extract + verify, all retries). */
export const DEFAULT_S3_DEADLINE_MS = 45_000

export interface ProvideWorkspaceOptions {
  signal?: AbortSignal
  bootMark?: (label: string) => void
  deadlineMs?: number
  /** Receives the health-visible summary on success AND on failure. */
  onSummary?: (summary: WorkspaceProviderSummary) => void
  /** Test seam for the S3 transport's HTTP. */
  fetchImpl?: typeof fetch
  /** Stall detector for the archive transfer; see DEFAULT_INACTIVITY_TIMEOUT_MS. */
  inactivityTimeoutMs?: number
  /** Test seam: the extractor binary (a bogus path forces the in-process fallback). */
  tarBinary?: string
}

export type ProvideWorkspaceResult = MaterializedProject & { summary: WorkspaceProviderSummary }

function trustedSha(cfg: Config): string | null {
  const sha = (cfg.baseSha ?? '').trim().toLowerCase()
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null
}

function summarize(
  cfg: Config,
  mode: ProjectSnapshotMode,
  started: number,
  result: Partial<MaterializedProject> & { timings: Record<string, number> },
  s3: S3Attempt,
  outcome: { ok: true } | { ok: false; error: string },
): WorkspaceProviderSummary {
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
    s3_skipped: s3.skipped !== null,
    s3_stage: s3.error?.stage ?? s3.skipped?.stage ?? null,
    s3_reason: s3.error?.reason ?? s3.skipped?.reason ?? null,
    s3_extractor: result.s3?.extractor ?? null,
    s3_descriptor: result.s3?.descriptorSource ?? null,
    fallback: result.fallback !== undefined,
    total_ms: Date.now() - started,
    timings: result.timings,
    outcome: outcome.ok ? 'ok' : 'error',
    error: outcome.ok ? null : outcome.error,
    hydration: null,
  }
}

export async function provideWorkspace(
  cfg: Config,
  opts: ProvideWorkspaceOptions = {},
): Promise<ProvideWorkspaceResult> {
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
  const s3State: S3Attempt = { attempted: false, attempts: 0, error: null, skipped: null }

  const finish = (result: MaterializedProject): ProvideWorkspaceResult => {
    const summary = summarize(cfg, mode, started, result, s3State, { ok: true })
    logger.info('[workspace-provider] complete', {
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
      logger.warn('[workspace-provider] checkout SHA differs from the session pin', {
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

    const acquired = await acquire(req, { mode, mark, timings, s3: s3State }, {
      fetchImpl: opts.fetchImpl,
      inactivityTimeoutMs: opts.inactivityTimeoutMs,
      tarBinary: opts.tarBinary,
    })
    const finished = finish(acquired)
    const hydration = acquired.hydration
    if (hydration) {
      const pending: SnapshotHydrationSummary = { status: 'pending', attempts: 0, bytes: 0, ms: 0, reason: null, error: null }
      finished.summary.hydration = pending
      void hydration.then((h) => {
        finished.summary.hydration = h
        finished.summary.timings.s3_hydrate = h.ms
        ;(h.status === 'ok' ? logger.info : logger.warn).call(logger, '[workspace-provider] snapshot hydration settled', {
          event: 'config_provider_hydration',
          status: h.status,
          attempts: h.attempts,
          bytes: h.bytes,
          ms: h.ms,
          reason: h.reason,
          error: h.error,
          expectedSha,
        })
        mark(`config-provider:hydrate:${h.status}`)
        opts.onSummary?.(finished.summary)
      })
    }
    return finished
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    const summary = summarize(cfg, mode, started, { timings }, s3State, { ok: false, error: message })
    logger.error('[workspace-provider] materialization failed', {
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

/**
 * The history backfill of an S3 start, for the harness to run after readiness:
 * it waits for the blob-pack import to settle, so the two never write packs
 * into the same object store at once.
 */
export function backfillAfterHydration(cfg: Config, result: ProvideWorkspaceResult): () => void {
  const hydration = result.hydration ?? Promise.resolve()
  const backfill = () => scheduleHistoryBackfill(cfg, cfg.projectTarget)
  return () => {
    void hydration.then(backfill, backfill)
  }
}
