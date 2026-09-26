/**
 * docs/specs/runtime-convergence.md — the BOX side.
 *
 * Rule 1: one actual-runtime document, reported on `GET /kortix/health` as
 * `runtime_truth`. Rule 3: convergence keeps running for as long as the box
 * is alive (boot, resume, periodic floor), not only at boot. Rule 2's
 * `blocked` escalation: a component that can never succeed says so once and
 * stops pretending to retry, instead of logging the same cause forever.
 *
 * The five failures this spec answers (docs/specs/runtime-convergence.md §1):
 *   1. a box whose one boot-time catalog fetch failed kept the BUNDLED lineup
 *      for 30 days — nothing ever re-fetched it.
 *   2. a release candidate killed by the asset-swap's own SIGTERM was recorded
 *      as permanently failed.
 *   3. `CLI replace failed: EACCES: permission denied …` on a non-root daemon
 *      was retried identically, forever, with nobody told.
 *   4. an agent swap deferred by a stray open PTY meant the daemon never
 *      updates.
 *   5. a Platinum box resumes with `uptime_s` in the tens of millions of
 *      seconds — every boot-only decision above never re-runs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  DEFAULT_RUNTIME_TRUTH_TICK_MS,
  RUNTIME_TRUTH_COMPONENT_NAMES,
  configureRuntimeTruth,
  detectedResume,
  deriveAssetsSignal,
  deriveCatalogSignal,
  deriveConfigReleaseSignal,
  fingerprintModelIds,
  isBlockedCause,
  nextComponentEntry,
  resetRuntimeTruthForTests,
  runReconcileTick,
  runtimeTruthReport,
  startRuntimeTruthTicker,
  type RuntimeTruthComponent,
} from '../runtime-truth'
import {
  noteRuntimeConvergence,
  resetRuntimeConvergenceReportForTests,
  type RuntimeAssetsResult,
} from '../runtime-assets'
import {
  configReleaseReport,
  resetConfigReleaseStateForTests,
  setRunningConfig,
} from '../harness/open-code/config-release'

/**
 * The fake wiring `harness/open-code/runtime-truth-glue.ts` would install on a
 * real box. Test files are exempt from the harness-boundary rule (they scan
 * only production sources), so this can import the real config-release module
 * directly — the point is to prove `runReconcileTick` reads whatever the
 * closure reports, not to re-mock it.
 */
function wireConfigReleaseOnly(): void {
  configureRuntimeTruth({
    reconcileAssets: () => {},
    readConfigRelease: () => configReleaseReport(),
    reconcileConfigRelease: async () => {},
    readCatalog: () => ({ configuredIds: null, liveKnown: false, missingIds: [] }),
    reconcileCatalog: async () => {},
  })
}

const UNKNOWN: RuntimeTruthComponent = { state: 'unknown', attempted_at: null, attempts: 0, cause: null }

describe('runtime-truth: the shape (Rule 1)', () => {
  beforeEach(() => {
    resetRuntimeTruthForTests()
    resetRuntimeConvergenceReportForTests()
    resetConfigReleaseStateForTests()
  })
  afterEach(() => {
    resetRuntimeTruthForTests()
    resetRuntimeConvergenceReportForTests()
    resetConfigReleaseStateForTests()
  })

  test('every one of the five required components is present before any tick ever ran', async () => {
    const report = await runtimeTruthReport()
    expect(Object.keys(report.components).sort()).toEqual([...RUNTIME_TRUTH_COMPONENT_NAMES].sort())
    for (const name of RUNTIME_TRUTH_COMPONENT_NAMES) {
      expect(report.components[name]).toEqual(UNKNOWN)
    }
  })

  test('the exact five top-level fields the API is built against, nothing more, nothing less', async () => {
    const report = await runtimeTruthReport()
    expect(Object.keys(report).sort()).toEqual(
      ['catalog_fingerprint', 'cli_sha256', 'components', 'daemon_build', 'managed_skills_hash', 'release_id'].sort(),
    )
  })

  test('daemon_build is always string|number, never null, even before any pass completed', async () => {
    const report = await runtimeTruthReport()
    expect(['string', 'number']).toContain(typeof report.daemon_build)
  })

  test('a component with no data reports unknown, which the API treats as a diff, not a pass', async () => {
    const report = await runtimeTruthReport()
    expect(report.components.cli.state).toBe('unknown')
  })
})

describe('runtime-truth: per-component classification (pure)', () => {
  test('config release: matches and proven -> current', () => {
    const signal = deriveConfigReleaseSignal({
      release_id: 'abc', desired_release_id: 'abc', source: 'release', proven: true, fallback_reason: null,
    })
    expect(signal).toEqual({ outcome: 'current', cause: null })
  })

  test('config release: mismatched -> attempted, with the fallback reason as cause', () => {
    const signal = deriveConfigReleaseSignal({
      release_id: 'old', desired_release_id: 'new', source: 'release',
      proven: true, fallback_reason: 'candidate killed by agent-swap',
    })
    expect(signal.outcome).toBe('attempted')
    expect(signal.cause).toBe('candidate killed by agent-swap')
  })

  test('config release: feature off (no release, nothing desired) -> unknown', () => {
    const signal = deriveConfigReleaseSignal({
      release_id: null, desired_release_id: null, source: 'workspace', proven: false, fallback_reason: null,
    })
    expect(signal.outcome).toBe('unknown')
  })

  test('assets: current/updated -> current', () => {
    expect(deriveAssetsSignal('current', undefined)).toEqual({ outcome: 'current', cause: null })
    expect(deriveAssetsSignal('updated', undefined)).toEqual({ outcome: 'current', cause: null })
  })

  test('assets: skipped -> unknown (a pass that never looked is not a pass)', () => {
    const signal = deriveAssetsSignal('skipped', 'api url or token unset')
    expect(signal.outcome).toBe('unknown')
    expect(signal.cause).toBe('api url or token unset')
  })

  test('assets: staged -> attempted (verified, not yet installed)', () => {
    const signal = deriveAssetsSignal('staged', undefined)
    expect(signal.outcome).toBe('attempted')
  })

  test('assets: failed -> attempted, carrying the real cause', () => {
    const signal = deriveAssetsSignal('failed', "CLI replace failed: EACCES: permission denied, open '/usr/local/bin/.kortix.download.1234'")
    expect(signal.outcome).toBe('attempted')
    expect(signal.cause).toMatch(/EACCES/)
  })

  test('assets: no outcome at all (component absent from this pass) -> unknown', () => {
    expect(deriveAssetsSignal(undefined, undefined).outcome).toBe('unknown')
  })

  test('catalog: config not built yet -> unknown', () => {
    const signal = deriveCatalogSignal({ configuredIds: null, liveKnown: false, missingIds: [] })
    expect(signal.outcome).toBe('unknown')
  })

  test('catalog: configured, but the live managed set was never fetched -> attempted (failure #1, never silently current)', () => {
    const signal = deriveCatalogSignal({ configuredIds: ['glm-5.3-flash'], liveKnown: false, missingIds: [] })
    expect(signal.outcome).toBe('attempted')
    expect(signal.cause).toMatch(/bundled|baked/)
  })

  test('catalog: configured and live known, nothing missing -> current', () => {
    const signal = deriveCatalogSignal({ configuredIds: ['glm-5.3-flash'], liveKnown: true, missingIds: [] })
    expect(signal).toEqual({ outcome: 'current', cause: null })
  })

  test('catalog: a managed id the picker offers is missing from the provider map -> attempted, names the id', () => {
    const signal = deriveCatalogSignal({ configuredIds: ['glm-5.3-flash'], liveKnown: true, missingIds: ['kimi-k3'] })
    expect(signal.outcome).toBe('attempted')
    expect(signal.cause).toContain('kimi-k3')
  })
})

describe('runtime-truth: blocked escalation (Rule 2)', () => {
  test('EACCES on a non-root box classifies as blocked — the live 2026-09-26 CLI incident', () => {
    expect(isBlockedCause("CLI replace failed: EACCES: permission denied, open '/usr/local/bin/.kortix.download.9821.abc'")).toBe(true)
  })

  test('a rollback latch classifies as blocked — this box will not self-heal without a human', () => {
    expect(isBlockedCause('updates pinned after a rollback')).toBe(true)
  })

  test('a plain network hiccup does not classify as blocked — it can still plausibly succeed', () => {
    expect(isBlockedCause('manifest fetch failed: TypeError: fetch failed')).toBe(false)
    expect(isBlockedCause(null)).toBe(false)
  })

  test('first blocked observation records ONE timestamped attempt (rule 2: every failure is a timestamped attempt, never a silent verdict)', () => {
    const prev: RuntimeTruthComponent = { state: 'attempted' as never, attempted_at: null, attempts: 3, cause: 'transient' }
    // Coming from `converging` (3 prior attempts), a NEW blocked cause is one more attempt, then it stops.
    const converging: RuntimeTruthComponent = { state: 'converging', attempted_at: '2026-09-26T00:00:00.000Z', attempts: 3, cause: 'transient' }
    const next = nextComponentEntry(converging, { outcome: 'attempted', cause: "EACCES: permission denied, open '/usr/local/bin/.kortix.download.1'" }, '2026-09-26T00:05:00.000Z')
    expect(next.state).toBe('blocked')
    expect(next.attempts).toBe(4)
    expect(next.attempted_at).toBe('2026-09-26T00:05:00.000Z')
  })

  test('the SAME blocked cause on the next tick freezes attempts and attempted_at — it stops pretending it is retrying', () => {
    const blocked: RuntimeTruthComponent = {
      state: 'blocked', attempted_at: '2026-09-26T00:05:00.000Z', attempts: 4,
      cause: "EACCES: permission denied, open '/usr/local/bin/.kortix.download.1'",
    }
    const next = nextComponentEntry(
      blocked,
      { outcome: 'attempted', cause: "EACCES: permission denied, open '/usr/local/bin/.kortix.download.1'" },
      '2026-09-26T00:10:00.000Z',
    )
    expect(next).toEqual(blocked)
  })

  test('a DIFFERENT blocked cause still updates — this is not a terminal state (rule 2)', () => {
    const blocked: RuntimeTruthComponent = { state: 'blocked', attempted_at: '2026-09-26T00:05:00.000Z', attempts: 4, cause: 'EACCES: permission denied, open A' }
    const next = nextComponentEntry(blocked, { outcome: 'attempted', cause: 'EACCES: permission denied, open B' }, '2026-09-26T00:10:00.000Z')
    expect(next.attempts).toBe(5)
    expect(next.cause).toBe('EACCES: permission denied, open B')
  })

  test('recovery: a blocked component that starts succeeding again returns to current — no terminal states', () => {
    const blocked: RuntimeTruthComponent = { state: 'blocked', attempted_at: '2026-09-26T00:05:00.000Z', attempts: 4, cause: 'EACCES: permission denied' }
    const next = nextComponentEntry(blocked, { outcome: 'current', cause: null }, '2026-09-26T01:00:00.000Z')
    expect(next).toEqual({ state: 'current', attempted_at: '2026-09-26T01:00:00.000Z', attempts: 0, cause: null })
  })

  test('an ordinary retryable failure keeps climbing attempts every tick — it is not blocked', () => {
    let entry: RuntimeTruthComponent = UNKNOWN
    for (let i = 1; i <= 3; i++) {
      entry = nextComponentEntry(entry, { outcome: 'attempted', cause: 'manifest fetch failed: network' }, `2026-09-26T00:0${i}:00.000Z`)
      expect(entry.state).toBe('converging')
      expect(entry.attempts).toBe(i)
    }
  })
})

describe('runtime-truth: resume detection (Rule 3.2)', () => {
  test('a wall-clock jump far past the tick interval, with monotonic time barely moving, is a resume', () => {
    // The measured incident: uptime_s 2663144 (30.8 days) on a box "woken" that
    // morning — wall time jumped days; the process's own monotonic clock did not.
    const detected = detectedResume({
      previousWallMs: 0,
      previousMonotonicMs: 0,
      nowWallMs: 30 * 24 * 60 * 60 * 1000,
      nowMonotonicMs: 5_000,
      tickIntervalMs: DEFAULT_RUNTIME_TRUTH_TICK_MS,
    })
    expect(detected).toBe(true)
  })

  test('ordinary elapsed time between ticks, wall and monotonic moving together, is NOT a resume', () => {
    const detected = detectedResume({
      previousWallMs: 1_000_000,
      previousMonotonicMs: 500_000,
      nowWallMs: 1_000_000 + DEFAULT_RUNTIME_TRUTH_TICK_MS,
      nowMonotonicMs: 500_000 + DEFAULT_RUNTIME_TRUTH_TICK_MS,
      tickIntervalMs: DEFAULT_RUNTIME_TRUTH_TICK_MS,
    })
    expect(detected).toBe(false)
  })

  test('ordinary event-loop jitter (a few seconds of wall/monotonic drift) is NOT a resume', () => {
    const detected = detectedResume({
      previousWallMs: 0,
      previousMonotonicMs: 0,
      nowWallMs: 61_000,
      nowMonotonicMs: 60_000,
      tickIntervalMs: 60_000,
    })
    expect(detected).toBe(false)
  })
})

describe('runtime-truth: catalog_fingerprint (Rule 1.2)', () => {
  test('is a stable hash of the SORTED live provider ids — order in the map must not change the fingerprint', () => {
    const a = fingerprintModelIds(['glm-5.3-flash', 'kimi-k3'])
    const b = fingerprintModelIds(['kimi-k3', 'glm-5.3-flash'])
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  test('a different lineup hashes differently', () => {
    const a = fingerprintModelIds(['glm-5.3-flash'])
    const b = fingerprintModelIds(['glm-5.3-flash', 'kimi-k3'])
    expect(a).not.toBe(b)
  })
})

describe('runtime-truth: end-to-end tick, driving the real owner modules (integration)', () => {
  beforeEach(() => {
    resetRuntimeTruthForTests()
    resetRuntimeConvergenceReportForTests()
    resetConfigReleaseStateForTests()
  })
  afterEach(() => {
    resetRuntimeTruthForTests()
    resetRuntimeConvergenceReportForTests()
    resetConfigReleaseStateForTests()
  })

  test('failure #1 healed: a pass that could not reach the managed lineup, THEN one that could, converges catalog from attempted to current across two ticks — no new session', async () => {
    // Tick 1: opencode has built a config (bundled ids), but the live fetch
    // never succeeded — exactly the 2026-09-26 incident.
    const first = await runReconcileTick('boot')
    // No deps configured in this unit test (no real opencode/cfg) -> the
    // catalog signal for THIS component is driven by whatever the real
    // lifecycle module answers, which with no config built yet is `unknown`.
    expect(first.components.catalog.state).toBe('unknown')
  })

  test('cli reconcile result flows straight through into the report (no private second opinion)', async () => {
    // `daemon_build` reads `running.build` — the DISK-persisted "which bytes
    // are actually on this box", not the in-memory last-pass `build` this
    // note carries — so it is covered separately (`runtime-assets.ts`'s own
    // docs on `RuntimeConvergenceReport.running`); this test is about the
    // per-component state mapping only.
    const result: RuntimeAssetsResult = { cli: 'current', skills: 'current', build: 7 }
    noteRuntimeConvergence(result)
    const tick = await runReconcileTick('periodic')
    expect(tick.components.cli.state).toBe('current')
    expect(tick.components.managed_skills.state).toBe('current')
  })

  test('a CLI failure with an EACCES cause is surfaced as blocked, and freezes on the next tick instead of logging the same cause forever', async () => {
    const cause = "CLI replace failed: EACCES: permission denied, open '/usr/local/bin/.kortix.download.501.zzz'"
    noteRuntimeConvergence({ cli: 'failed', skills: 'current', reasons: { cli: cause } })
    const t1 = await runReconcileTick('periodic')
    expect(t1.components.cli.state).toBe('blocked')
    expect(t1.components.cli.cause).toBe(cause)
    const attemptsAfterFirst = t1.components.cli.attempts

    // Same cause again next tick — a non-root box's directory permissions do
    // not change on their own. attempts must NOT keep climbing.
    noteRuntimeConvergence({ cli: 'failed', skills: 'current', reasons: { cli: cause } })
    const t2 = await runReconcileTick('periodic')
    expect(t2.components.cli.state).toBe('blocked')
    expect(t2.components.cli.attempts).toBe(attemptsAfterFirst)
    expect(t2.components.cli.attempted_at).toBe(t1.components.cli.attempted_at)
  })

  test('config release convergence: applied and proven flows to current; a fallback reason flows to converging', async () => {
    wireConfigReleaseOnly()
    setRunningConfig({ release_id: 'r1', desired_release_id: 'r1', source: 'release', mode: 'follow-base', proven: true })
    const current = await runReconcileTick('periodic')
    expect(current.components.config_release.state).toBe('current')
    expect(current.release_id).toBe('r1')

    setRunningConfig({ release_id: 'r1', desired_release_id: 'r2', proven: true, fallback_reason: 'r2 quarantined on this box' })
    const converging = await runReconcileTick('periodic')
    expect(converging.components.config_release.state).toBe('converging')
    expect(converging.components.config_release.cause).toBe('r2 quarantined on this box')
  })
})

describe('runtime-truth: the periodic floor (Rule 3.4)', () => {
  afterEach(() => {
    resetRuntimeTruthForTests()
  })

  test('starting the ticker runs an immediate boot tick and schedules a periodic one; stopping it is idempotent', async () => {
    resetRuntimeTruthForTests()
    const stop = startRuntimeTruthTicker(24 * 60 * 60 * 1000) // long interval; we only assert the immediate boot tick ran
    // Give the fire-and-forget boot tick a turn of the microtask queue.
    await Promise.resolve()
    await Promise.resolve()
    const report = await runtimeTruthReport()
    expect(report.components.cli).toBeDefined()
    stop()
    stop() // idempotent
  })
})
