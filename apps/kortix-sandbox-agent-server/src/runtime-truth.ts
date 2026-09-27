import { createHash } from 'node:crypto'
import type { HarnessAssetOutcome } from './harness/assets'
import { logger } from './logger'
import { runtimeConvergenceReport } from './runtime-assets'

/**
 * the runtime-convergence contract (PR #7785) — the BOX side.
 *
 * Rule 1: one actual-runtime document, reported on `GET /kortix/health` as
 * `runtime_truth`. The API computes a matching DESIRED document and diffs the
 * two; this module owns only the box's own answer, never a second opinion
 * about what the API wants.
 *
 * Rule 3: convergence keeps running for as long as the box is alive — boot,
 * resume, and a periodic floor — not only once at boot. `runReconcileTick`
 * is the ONE place that kicks every component's own convergence AND updates
 * this module's ledger; `runtimeTruthReport` is a pure read for `/kortix/health`,
 * which is polled every few seconds and must never itself trigger work.
 *
 * Rule 2's `blocked` escalation: a component whose cause matches a known
 * permanent-failure pattern (EACCES on a non-root box, a rollback latch)
 * stops climbing `attempts` — it recorded ONE timestamped attempt and now
 * says so plainly, instead of logging the same cause every reconcile forever
 * with nobody told (the live 2026-09-26 incident this file answers).
 *
 * HARNESS BOUNDARY (harness-boundary.test.ts): this file lives in host
 * production code, so it must never import a concrete adapter
 * (`harness/open-code/*`, `harness/pi/*`) directly. `cli`/`managed_skills`/
 * `daemon` read `./runtime-assets` directly because that module is already
 * harness-neutral. `config_release` and `catalog` are OpenCode-specific
 * concepts with no neutral contract of their own, so this file asks for them
 * through injected closures (`RuntimeTruthDeps`) instead. The adapter wires
 * those closures — `harness/open-code/runtime-truth-glue.ts` — and calls
 * `configureRuntimeTruth`/`startRuntimeTruthTicker` from its own boot path,
 * which is the ALLOWED import direction (an adapter may import host code).
 */

// ---------------------------------------------------------------------------
// The shape. Fixed on purpose — the API is built against this exact document
// in parallel. Do not add, rename or drop a field without updating that side.
// ---------------------------------------------------------------------------

export type RuntimeTruthComponentState = 'current' | 'converging' | 'blocked' | 'unknown'

export interface RuntimeTruthComponent {
  state: RuntimeTruthComponentState
  attempted_at: string | null
  attempts: number
  cause: string | null
}

export const RUNTIME_TRUTH_COMPONENT_NAMES = [
  'config_release',
  'catalog',
  'daemon',
  'cli',
  'managed_skills',
] as const

export type RuntimeTruthComponentName = (typeof RUNTIME_TRUTH_COMPONENT_NAMES)[number]

export interface RuntimeTruthReport {
  release_id: string | null
  catalog_fingerprint: string | null
  daemon_build: string | number
  cli_sha256: string | null
  managed_skills_hash: string | null
  components: Record<RuntimeTruthComponentName, RuntimeTruthComponent>
}

export type RuntimeTruthTrigger = 'boot' | 'resume' | 'periodic' | 'turn-start'

/** A component's freshly-observed status, before it is folded into the ledger. */
export interface RuntimeTruthSignal {
  /** Matches the desired value; nothing to do. */
  outcome: 'current' | 'unknown' | 'attempted'
  cause: string | null
}

const UNKNOWN_ENTRY: RuntimeTruthComponent = { state: 'unknown', attempted_at: null, attempts: 0, cause: null }

const NOT_WIRED_CAUSE = 'runtime-truth is not wired to a runtime on this box yet'

// ---------------------------------------------------------------------------
// Rule 2 — `blocked`: a cause that will not resolve by trying again.
// ---------------------------------------------------------------------------

/**
 * Permanent-failure patterns measured on real boxes, not a guess:
 *  - `EACCES` / `EPERM` / "permission denied": a non-root daemon writing to a
 *    root-owned path (`/usr/local/bin/…`) — the live 2026-09-26 incident.
 *    Directory ownership does not change between reconciles on its own.
 *  - "pinned": the supervisor's own rollback latch
 *    (`agent.pinned` / `opencode.pinned`, see runtime-assets.ts). A crash-loop
 *    already happened and updates are latched off — this box needs a human,
 *    per that file's own comment on `RuntimeConvergenceReport.pinned`.
 */
const BLOCKED_CAUSE_PATTERNS: readonly RegExp[] = [/EACCES/i, /EPERM/i, /permission denied/i, /\bpinned\b/i]

export function isBlockedCause(cause: string | null): boolean {
  if (!cause) return false
  return BLOCKED_CAUSE_PATTERNS.some((pattern) => pattern.test(cause))
}

/**
 * Fold one freshly-observed signal into a component's ledger entry.
 *
 * Pure — no module state, so every transition is a plain input/output fact,
 * independently testable. `runReconcileTick` is the only caller that mutates
 * the real ledger with it.
 *
 * The `blocked` freeze: once a component is `blocked` for the SAME cause, a
 * later tick with that identical cause does not advance `attempts` or
 * `attempted_at` — the whole point of `blocked` is to stop pretending a
 * doomed action is still being retried. A DIFFERENT cause (even one that
 * still classifies as `blocked`) is a new problem and counts as a new
 * attempt. Rule 2: "no terminal states" — a component that starts succeeding
 * again always returns to `current`, from any prior state.
 */
export function nextComponentEntry(
  prev: RuntimeTruthComponent,
  signal: RuntimeTruthSignal,
  nowIso: string,
): RuntimeTruthComponent {
  if (signal.outcome === 'unknown') {
    return { state: 'unknown', attempted_at: null, attempts: 0, cause: signal.cause }
  }
  if (signal.outcome === 'current') {
    return { state: 'current', attempted_at: nowIso, attempts: 0, cause: null }
  }
  if (isBlockedCause(signal.cause)) {
    const frozen = prev.state === 'blocked' && prev.cause === signal.cause
    return {
      state: 'blocked',
      cause: signal.cause,
      attempted_at: frozen ? prev.attempted_at : nowIso,
      attempts: frozen ? prev.attempts : prev.attempts + 1,
    }
  }
  return { state: 'converging', cause: signal.cause, attempted_at: nowIso, attempts: prev.attempts + 1 }
}

// ---------------------------------------------------------------------------
// Per-component signal derivation. Each is pure and takes exactly the facts
// it needs, so every classification decision is testable without booting a
// harness. `runReconcileTick` supplies the live values.
// ---------------------------------------------------------------------------

/**
 * The box's own config-release state — structurally the same fields as
 * `harness/open-code/config-release.ts`'s `ConfigReleaseReport`, but declared
 * locally so this host-level file never imports that concrete adapter (see
 * the harness-boundary note above). A real `ConfigReleaseReport` satisfies
 * this type as-is.
 */
export interface RuntimeTruthConfigReleaseState {
  release_id: string | null
  desired_release_id: string | null
  source: string
  proven: boolean
  fallback_reason: string | null
}

export function deriveConfigReleaseSignal(report: RuntimeTruthConfigReleaseState): RuntimeTruthSignal {
  if (report.source === 'workspace' && report.release_id === null && report.desired_release_id === null) {
    return { outcome: 'unknown', cause: 'config releases are off for this project' }
  }
  if (report.release_id !== null && report.release_id === report.desired_release_id && report.proven) {
    return { outcome: 'current', cause: null }
  }
  return {
    outcome: 'attempted',
    cause: report.fallback_reason ?? (report.desired_release_id ? 'candidate not yet proven' : 'awaiting the desired release'),
  }
}

/** Shared by `cli` and `managed_skills`; `daemon` wraps this with the pinned override below. */
export function deriveAssetsSignal(outcome: HarnessAssetOutcome | undefined, cause: string | undefined): RuntimeTruthSignal {
  if (outcome === undefined) return { outcome: 'unknown', cause: cause ?? 'no reconcile pass has looked at this component yet' }
  if (outcome === 'skipped') return { outcome: 'unknown', cause: cause ?? 'nothing to converge on the last pass' }
  if (outcome === 'current' || outcome === 'updated') return { outcome: 'current', cause: null }
  if (outcome === 'staged') return { outcome: 'attempted', cause: cause ?? 'verified update staged; waiting for an idle install point' }
  return { outcome: 'attempted', cause: cause ?? 'reconcile failed' }
}

export function deriveDaemonSignal(
  outcome: HarnessAssetOutcome | undefined,
  cause: string | undefined,
  pinned: boolean,
): RuntimeTruthSignal {
  if (pinned) {
    return { outcome: 'attempted', cause: cause ?? 'updates pinned after a rollback; this box needs a human' }
  }
  return deriveAssetsSignal(outcome, cause)
}

/** The box's own catalog state — see `RuntimeTruthDeps.readCatalog`. */
export interface RuntimeTruthCatalogState {
  /** The ids this box's provider map currently serves. Null before a config has been built. */
  configuredIds: readonly string[] | null
  /** Whether a live managed-lineup fetch has EVER succeeded on this box. */
  liveKnown: boolean
  /** Managed ids the live set carries that the configured map lacks. */
  missingIds: readonly string[]
}

export function deriveCatalogSignal(input: RuntimeTruthCatalogState): RuntimeTruthSignal {
  if (input.configuredIds === null) {
    return { outcome: 'unknown', cause: 'opencode has not built a provider config yet' }
  }
  if (!input.liveKnown) {
    // Failure #1, exactly: a box whose one fetch failed would otherwise read
    // as "fine" forever because it has SOME catalog (bundled/baked). It must
    // stay `attempted` — never `current` — until a real comparison succeeds,
    // or the periodic floor has nothing left to fix.
    return {
      outcome: 'attempted',
      cause: 'managed lineup fetch has not succeeded yet; serving the bundled/baked catalog',
    }
  }
  if (input.missingIds.length === 0) return { outcome: 'current', cause: null }
  return {
    outcome: 'attempted',
    cause: `managed model(s) missing from the provider map: ${input.missingIds.join(', ')}`,
  }
}

// ---------------------------------------------------------------------------
// catalog_fingerprint — Rule 1.2: a stable hash of the ids the box's OWN
// provider map serves, not of a file it hoped to load.
// ---------------------------------------------------------------------------

export function fingerprintModelIds(ids: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex')
}

// ---------------------------------------------------------------------------
// Rule 3.2 — resume detection.
//
// A Platinum box is suspended and resumed with its processes intact
// (measured: `uptime_s: 2663144`, 30.8 days, on a box "woken" that morning).
// Wall-clock time advances through a freeze; a process's own monotonic uptime
// does not. A jump far past what one tick interval could explain — ordinary
// event-loop jitter is milliseconds to low seconds — is a resume, not a slow
// tick. The floor is generous (10x the tick interval, minimum 60s) precisely
// so scheduling jitter never trips it.
// ---------------------------------------------------------------------------

export function detectedResume(input: {
  previousWallMs: number
  previousMonotonicMs: number
  nowWallMs: number
  nowMonotonicMs: number
  tickIntervalMs: number
}): boolean {
  const wallDelta = input.nowWallMs - input.previousWallMs
  const monotonicDelta = input.nowMonotonicMs - input.previousMonotonicMs
  const floor = Math.max(input.tickIntervalMs * 10, 60_000)
  return wallDelta - monotonicDelta > floor
}

// ---------------------------------------------------------------------------
// The ledger — module-level, updated only by `runReconcileTick`.
// ---------------------------------------------------------------------------

function initialLedger(): Record<RuntimeTruthComponentName, RuntimeTruthComponent> {
  return Object.fromEntries(
    RUNTIME_TRUTH_COMPONENT_NAMES.map((name) => [name, { ...UNKNOWN_ENTRY }]),
  ) as Record<RuntimeTruthComponentName, RuntimeTruthComponent>
}

let ledger = initialLedger()
let lastTickWallMs: number | null = null
let lastTickMonotonicMs: number | null = null

export interface RuntimeTruthDeps {
  /** Kick cli/skills/daemon(agent) convergence. Fire-and-forget; already single-flighted upstream (`./runtime-assets`). */
  reconcileAssets: () => void
  /** The box's current config-release state. Read-only, no I/O beyond memory. */
  readConfigRelease: () => RuntimeTruthConfigReleaseState
  /** Kick a config-release convergence attempt. Must swallow its own busy/error outcomes. */
  reconcileConfigRelease: () => Promise<void>
  /** The box's current catalog state. Read-only, no I/O beyond memory. */
  readCatalog: () => RuntimeTruthCatalogState
  /** Kick a managed-catalog convergence attempt (fetch, and restart only if needed). Must swallow its own errors. */
  reconcileCatalog: () => Promise<void>
}

let deps: RuntimeTruthDeps | null = null

/** Hand this module the live runtime, once, when it becomes ready (boot or warm-fork adoption). */
export function configureRuntimeTruth(next: RuntimeTruthDeps): void {
  deps = next
}

export function resetRuntimeTruthForTests(): void {
  ledger = initialLedger()
  lastTickWallMs = null
  lastTickMonotonicMs = null
  deps = null
}

// ---------------------------------------------------------------------------
// Assembling the report — the read side (Rule 1), safe to call as often as
// health is polled: no network call of its own, only in-memory/local reads.
// ---------------------------------------------------------------------------

async function actualValues(): Promise<Omit<RuntimeTruthReport, 'components'>> {
  const assets = await runtimeConvergenceReport()
  const configuredIds = deps?.readCatalog().configuredIds ?? null
  return {
    release_id: deps?.readConfigRelease().release_id ?? null,
    catalog_fingerprint: configuredIds ? fingerprintModelIds(configuredIds) : null,
    // `running.build` is null until this box's first asset-reconcile pass
    // completes (or forever, on a token/API-url-less local daemon). The type
    // this document reports is `string|number`, never null, so an
    // unconverged box reports the sentinel `0` — distinguishable from any
    // real epoch (manifests start at 1) and still a number.
    daemon_build: assets.running.build ?? 0,
    cli_sha256: assets.running.cli_sha256,
    managed_skills_hash: assets.running.managed_skills_hash,
  }
}

async function snapshotReport(): Promise<RuntimeTruthReport> {
  const values = await actualValues()
  return { ...values, components: { ...ledger } }
}

/** Pure read for `/kortix/health`. Never triggers a reconcile attempt. */
export async function runtimeTruthReport(): Promise<RuntimeTruthReport> {
  return snapshotReport()
}

// ---------------------------------------------------------------------------
// Rule 3 — the reconcile tick. The ONE place that both does the work (kicks
// every component's own convergence) and records what happened.
// ---------------------------------------------------------------------------

export async function runReconcileTick(trigger: RuntimeTruthTrigger): Promise<RuntimeTruthReport> {
  const nowWall = Date.now()
  const nowMonotonic = process.uptime() * 1000
  let effectiveTrigger: RuntimeTruthTrigger = trigger
  if (lastTickWallMs !== null && lastTickMonotonicMs !== null) {
    if (
      detectedResume({
        previousWallMs: lastTickWallMs,
        previousMonotonicMs: lastTickMonotonicMs,
        nowWallMs: nowWall,
        nowMonotonicMs: nowMonotonic,
        tickIntervalMs: tickIntervalMs(),
      })
    ) {
      effectiveTrigger = 'resume'
      logger.warn('[runtime-truth] resume detected (wall clock jumped far past monotonic uptime); running a full reconcile', {
        wallDeltaMs: nowWall - lastTickWallMs,
        monotonicDeltaMs: nowMonotonic - lastTickMonotonicMs,
      })
    }
  }
  lastTickWallMs = nowWall
  lastTickMonotonicMs = nowMonotonic

  // Kick every component's own convergence. Each swallows its own errors
  // (the injected closures are required to; `./runtime-assets` already does)
  // — a tick must never throw, or the ticker that calls it stops forever.
  deps?.reconcileAssets()
  await Promise.allSettled([
    deps?.reconcileConfigRelease().catch((err) => logger.warn('[runtime-truth] config-release tick failed', { err: String(err) })),
    deps?.reconcileCatalog().catch((err) => logger.warn('[runtime-truth] catalog tick failed', { err: String(err) })),
  ])

  const nowIso = new Date().toISOString()
  const assets = await runtimeConvergenceReport()
  const configRelease = deps?.readConfigRelease()
  const catalog = deps?.readCatalog()

  ledger = {
    ...ledger,
    cli: nextComponentEntry(ledger.cli, deriveAssetsSignal(assets.components.cli, assets.reasons?.cli), nowIso),
    managed_skills: nextComponentEntry(
      ledger.managed_skills,
      deriveAssetsSignal(assets.components.skills, assets.reasons?.skills),
      nowIso,
    ),
    daemon: nextComponentEntry(
      ledger.daemon,
      deriveDaemonSignal(assets.components.agent, assets.reasons?.agent, assets.pinned),
      nowIso,
    ),
    config_release: nextComponentEntry(
      ledger.config_release,
      configRelease ? deriveConfigReleaseSignal(configRelease) : { outcome: 'unknown', cause: NOT_WIRED_CAUSE },
      nowIso,
    ),
    catalog: nextComponentEntry(
      ledger.catalog,
      catalog ? deriveCatalogSignal(catalog) : { outcome: 'unknown', cause: NOT_WIRED_CAUSE },
      nowIso,
    ),
  }

  logger.info('[runtime-truth] reconcile tick complete', {
    trigger: effectiveTrigger,
    components: Object.fromEntries(RUNTIME_TRUTH_COMPONENT_NAMES.map((name) => [name, ledger[name].state])),
  })
  return snapshotReport()
}

// ---------------------------------------------------------------------------
// Rule 3.4 — the periodic reconcile floor.
//
// 60s: the cost per tick is a handful of small HTTP calls, not a download —
// `scheduleRuntimeAssetsReconcile` is a manifest fetch plus a local digest
// compare (it only downloads when something actually changed);
// `convergeConfigRelease` short-circuits to `unchanged` when the box already
// runs the desired release (its own doc: "the only place a convergence ends
// with nothing to do"); the catalog fetch is bounded to 5s
// (`MANAGED_MODELS_TOTAL_BUDGET_MS` in lifecycle.ts) and skips the restart
// entirely once nothing is missing. 60s bounds this spec's
// "no failure is ever permanent" contract to a one-minute wait — short enough
// that a support session never has to wait on it, long enough that an idle
// box's steady-state cost is negligible next to its own prompt traffic.
// Overridable for ops tuning / local verification.
// ---------------------------------------------------------------------------

export const DEFAULT_RUNTIME_TRUTH_TICK_MS = 60_000

/** The EFFECTIVE floor (env override or the default above) — reported on `/kortix/health` so "why hasn't this healed yet" has an answer bound to a number. */
export function tickIntervalMs(): number {
  const raw = Number(process.env.KORTIX_RUNTIME_TRUTH_TICK_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RUNTIME_TRUTH_TICK_MS
}

let ticker: ReturnType<typeof setInterval> | null = null

/**
 * Runs one tick immediately (`'boot'`) and schedules the periodic floor.
 * Idempotent: a warm-fork adoption or a second harness-ready call must not
 * stack a second interval. Returns a stop function (tests only; production
 * never stops it — the daemon owns the process for its whole life).
 */
export function startRuntimeTruthTicker(intervalMs: number = tickIntervalMs()): () => void {
  if (ticker === null) {
    void runReconcileTick('boot').catch((err) => logger.warn('[runtime-truth] boot tick failed', { err: String(err) }))
    ticker = setInterval(() => {
      void runReconcileTick('periodic').catch((err) => logger.warn('[runtime-truth] periodic tick failed', { err: String(err) }))
    }, intervalMs)
    ticker.unref?.()
  }
  return () => {
    if (ticker !== null) {
      clearInterval(ticker)
      ticker = null
    }
  }
}
