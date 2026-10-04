import { open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { Config } from '@/lib/config/config'
import type { HarnessAssetsService } from './port'
import { logger } from '@/lib/log/logger'
import type { RuntimeAssetsResult, RuntimeAssetsState, RuntimeComponent, ReconcileOutcome } from './runtime-assets'

const DEFAULT_AGENT_STATE_DIR = '/opt/kortix'
const DEFAULT_STATE_PATH = '/opt/kortix/runtime-assets-state.json'
const DEFAULT_CLI_PATH = '/usr/local/bin/kortix'
export const AGENT_SWAP_EXIT_CODE = 75

async function readState(path: string): Promise<RuntimeAssetsState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RuntimeAssetsState
  } catch {
    return {}
  }
}

export async function stagedAgentSha(stateDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(stateDir, 'agent.next.sha256'), 'utf8')
    const sha = raw.trim()
    return /^[0-9a-f]{64}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

/** The supervisor's rollback latch: a previous update crash-looped this box. */
export async function agentUpdatesPinned(stateDir: string): Promise<boolean> {
  return stat(join(stateDir, 'agent.pinned')).then(
    () => true,
    () => false,
  )
}


// ── Requesting the swap ────────────────────────────────────────────────────

/**
 * Why a swap request did or did not exit the process. Every value except
 * `exited` leaves the box exactly as it was: the staged binary is installed by
 * the supervisor at the next natural start, which for a sandbox is soon.
 */
export type AgentSwapDecision =
  | 'exited'
  | 'nothing-staged'
  | 'pinned'
  | 'too-young'
  | 'turn-in-flight'
  | 'turn-state-unknown'
  | 'attached'
  | 'not-configured'

/**
 * How long this process must have been up before it may ask to be replaced.
 *
 * The first reconcile fires moments after `opencode-ready` — which is exactly
 * when a user is about to send their first prompt, and when the frontend is
 * polling readiness. A restart there is not "free because the box is idle": it
 * is a readiness flap on the session-start hot path, in exchange for an update
 * that the supervisor installs at the next start anyway (it promotes before
 * every launch). So the early exit is reserved for LONG-LIVED boxes, the only
 * ones that would otherwise run a stale daemon for days.
 */
const AGENT_SWAP_MIN_UPTIME_MS = 5 * 60_000

/**
 * Anything the daemon owns that a restart would sever, beyond a turn.
 *
 * The daemon is also the reverse proxy and the PTY host, and those are not
 * visible from turn state. Components that hold such work register a predicate
 * here rather than this module inventing a second opinion about their state —
 * `routes/pty.ts`'s registry is the only thing that knows whether a shell is
 * open, so it is the thing that answers.
 */
const swapBlockers = new Map<string, () => boolean>()

export function registerAgentSwapBlocker(name: string, isBusy: () => boolean): void {
  swapBlockers.set(name, isBusy)
}

/**
 * Must a daemon swap wait until nobody is WATCHING the box, not merely until no
 * turn is running?
 *
 * THE TRADE, stated so the default is a decision and not an accident. A swap at
 * `session.idle` costs roughly 6-9 s of unreachable box and severs every open
 * SSE stream; the client reconnects and the event ring replays what it missed,
 * so nothing is lost, but somebody sitting on the session page sees it. Blocking
 * on subscribers removes that entirely — and re-creates the bug this whole lane
 * exists to fix, because a session with one browser tab open would then NEVER
 * swap its daemon, which is exactly how boxes ended up running months-old
 * binaries.
 *
 * DEFAULT OFF, because the failure it prevents is cosmetic and the failure it
 * causes is the original defect. `KORTIX_AGENT_SWAP_REQUIRE_UNATTENDED=1` turns
 * it on for an operator who would rather a watched box stay stale. Read per call
 * so flipping it needs no daemon release.
 */
export function agentSwapRequiresUnattendedBox(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env.KORTIX_AGENT_SWAP_REQUIRE_UNATTENDED?.trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/** Test seam: drop every registered blocker. */
export function resetAgentSwapBlockersForTests(): void {
  swapBlockers.clear()
}

/**
 * How this module finds the harness assets when no live runtime is configured
 * (`configureRuntimeConvergence`): a warm seed, a monitor box, a pass before
 * boot. app/ registers `resolveHarness(cfg).assets` before anything runs; a
 * service never imports the harness. Without a `cfg` the lookup answers for
 * the default harness, as `resolveHarness()` does.
 */
let harnessAssetsLookup: ((cfg?: Config) => HarnessAssetsService) | null = null

export function registerHarnessAssets(lookup: (cfg?: Config) => HarnessAssetsService): void {
  harnessAssetsLookup = lookup
}

/** Test seam: forget the registered lookup. */
export function resetHarnessAssetsForTests(): void {
  harnessAssetsLookup = null
}

export function harnessAssets(cfg?: Config): HarnessAssetsService {
  if (!harnessAssetsLookup) {
    throw new Error(
      'runtime-assets: registerHarnessAssets() was not called. main.ts registers it at boot; a test registers ' +
        '`(cfg) => resolveHarness(cfg).assets` in beforeAll and calls resetHarnessAssetsForTests() in afterAll.',
    )
  }
  return harnessAssetsLookup(cfg)
}

interface RuntimeConvergenceConfig {
  assets: HarnessAssetsService
  turnInFlight: () => Promise<boolean | null>
  agentStateDir?: string
  exit?: (code: number) => void
}

/**
 * Hand this module the live runtime, once, at boot.
 *
 * Both scheduling call sites (`startSessionRuntime` and `POST /kortix/refresh`)
 * pass only a `Config`, so the runtime is registered here instead of threaded
 * through every one of them. Nothing below requires it: an unconfigured daemon
 * still converges the CLI and the overlay, and simply reports that it had no
 * runtime to converge harness assets against.
 */
let swapConfig: RuntimeConvergenceConfig | null = null
export function swapAssets(): HarnessAssetsService | undefined { return swapConfig?.assets }

export function configureRuntimeConvergence(config: RuntimeConvergenceConfig): void {
  swapConfig = config
}

/** Test seam: forget the configured runtime. */
export function resetRuntimeConvergenceForTests(): void {
  swapConfig = null
}

export interface AgentSwapOptions {
  /** The one authority on "is a turn running". `null` means unreadable. */
  turnInFlight?: () => Promise<boolean | null>
  agentStateDir?: string
  /** Defaults to the daemon's own clean shutdown, exiting {@link AGENT_SWAP_EXIT_CODE}. */
  exit?: (code: number) => void
  /** Seconds this process has been up. Injected by tests. */
  uptimeMs?: number
  /**
   * This request comes from the box's own `session.idle` frame.
   *
   * It WAIVES {@link AGENT_SWAP_MIN_UPTIME_MS} and nothing else — see
   * {@link applyStagedAssetsIfIdle} for why that floor does not apply here.
   * Every other refusal (the rollback latch, a turn in flight, an unreadable
   * turn state, a registered blocker) is unchanged.
   */
  atIdleBoundary?: boolean
}

/**
 * Ask the supervisor to install the staged daemon — but only if nothing is
 * mid-flight that the restart would destroy.
 *
 * THE SAFETY RULE, stated once: this process exiting takes the harness, the
 * reverse proxy and every PTY down with it. So a swap is requested only when
 * the turn oracle says, definitely, that no turn is running, AND no registered
 * blocker claims live work. "Cannot tell" counts as busy — an update is never
 * worth guessing about, because the alternative to exiting now is simply
 * exiting later, at a start that was going to happen anyway.
 *
 * Never throws: a failure to ask leaves the staged binary staged.
 */
export async function requestAgentSwapIfIdle(
  options: AgentSwapOptions = {},
): Promise<AgentSwapDecision> {
  try {
    const stateDir = options.agentStateDir ?? swapConfig?.agentStateDir ?? DEFAULT_AGENT_STATE_DIR
    const staged = await stagedAgentSha(stateDir)
    const stagedPresent =
      staged !== null &&
      (await stat(join(stateDir, 'agent.next')).then(
        (s) => s.isFile(),
        () => false,
      ))
    if (!stagedPresent) return 'nothing-staged'
    if (await agentUpdatesPinned(stateDir)) return 'pinned'

    // The floor is a BOOT-FLAP guard, not a general delay: it exists because the
    // first reconcile fires moments after `opencode-ready`, which is exactly
    // when a user is about to send their first prompt. A `session.idle` frame is
    // the opposite situation — a turn has just FINISHED — so the floor is waived
    // there and nowhere else. Without that waiver the boot pass answered
    // `too-young` every time and no later pass existed, which is why a
    // long-lived box staged a daemon and never installed it.
    const uptimeMs = options.uptimeMs ?? process.uptime() * 1000
    if (!options.atIdleBoundary && uptimeMs < AGENT_SWAP_MIN_UPTIME_MS) return 'too-young'

    const probe = options.turnInFlight ?? swapConfig?.turnInFlight
    if (!probe) return 'not-configured'
    const turnInFlight = await probe()
    if (turnInFlight === true) return 'turn-in-flight'
    if (turnInFlight === null) return 'turn-state-unknown'

    for (const [name, isBusy] of swapBlockers) {
      let busy = false
      try {
        busy = isBusy()
      } catch (err) {
        // A blocker that cannot answer is a blocker that says busy.
        logger.warn('[runtime-assets] swap blocker threw; treating as busy', {
          name,
          err: String(err),
        })
        busy = true
      }
      if (busy) {
        logger.info('[runtime-assets] agent swap deferred — live work in progress', { name })
        return 'attached'
      }
    }

    const exit = options.exit ?? swapConfig?.exit ?? ((code: number) => process.exit(code))
    logger.info('[runtime-assets] requesting agent swap; exiting for the supervisor', {
      sha256: staged.slice(0, 12),
      code: AGENT_SWAP_EXIT_CODE,
    })
    exit(AGENT_SWAP_EXIT_CODE)
    return 'exited'
  } catch (err) {
    logger.warn('[runtime-assets] agent swap request failed', { err: String(err) })
    return 'not-configured'
  }
}


/**
 * Apply whatever this box has staged, at the one moment it is provably safe.
 *
 * THE SAFE BOUNDARY is the box's own `session.idle` frame, observed in the event
 * fan-out at `harness/open-code/boot.ts`. It is the only moment the box KNOWS no
 * turn is running — not a timer, deliberately: the config-releases lane forbids
 * a timer near a readiness decision and its AST tripwires enforce that. This
 * function is called FROM that frame; it does not schedule itself.
 *
 * WHAT A DAEMON SWAP COSTS, stated plainly because the caller is choosing to pay
 * it: this process exiting takes the reverse proxy, every PTY and OpenCode down
 * with it, and the box is unreachable for roughly 6-9 s while the supervisor
 * promotes the staged binary and the session runtime reboots. Open SSE streams
 * are severed and the client must reconnect; the event ring replays what it
 * missed. A prompt held by the API-side queue is unaffected — it is server-side,
 * and the turn-start gate runs before `claimPromptDelivery`, so no prompt of the
 * request in flight has been claimed or delivered at the moment of the swap.
 *
 * Every existing refusal still applies. Never throws.
 */
export async function applyStagedAssetsIfIdle(
  options: AgentSwapOptions = {},
): Promise<AgentSwapDecision> {
  return requestAgentSwapIfIdle({ ...options, atIdleBoundary: true })
}

// ---------------------------------------------------------------------------
// Observability — convergence you can query.
//
// Auto-update without reporting just moves the uncertainty: instead of "we hope
// boxes are current" you get "we hope boxes updated". The last pass is recorded
// here and surfaced on /kortix/health so a stale box is a FACT the control plane
// can read, per box, rather than an assumption.
//
// It is also the signal that tells us a fleet-drain gate has actually cleared —
// the thing we had no way to answer when the wire-id deletion was blocked on
// "have all the 1.17.11 boxes gone yet?".
// ---------------------------------------------------------------------------

export interface RuntimeConvergenceReport {
  /** The manifest epoch this box converged to; null before the first pass. */
  build: number | null
  /** Wall-clock of the last completed pass. */
  at: string | null
  /** Per-component outcome of that pass. */
  components: Partial<Record<RuntimeComponent, ReconcileOutcome>>
  /** Per-component explanation, when one was recorded. */
  reasons?: Partial<Record<RuntimeComponent, string>>
  /**
   * A verified agent binary is staged. The box is NOT yet running it — the
   * supervisor installs it at the next start. A box reporting `true` for a long
   * time is a box that never restarts, which is itself worth seeing.
   */
  agentSwapPending: boolean
  /**
   * Updates are latched off because a previous update crash-looped and the
   * supervisor rolled back. This box will not self-heal and needs a human.
   */
  pinned: boolean
  /**
   * WHICH BYTES ARE ON THIS BOX RIGHT NOW — not what the last pass DID.
   *
   * `build`, `components` and `agentSwapPending` above all describe a PASS.
   * `build` is written even when a half failed (see the epoch comment in
   * `reconcileRuntimeAssets`), `components` reports outcomes, and both are
   * in-memory, so every daemon restart reports `build: null` until its first
   * pass completes. None of that answers "is this box current", which is the
   * only question the control plane can act on — so it had to send a refresh on
   * every turn and hope.
   *
   * These come from `/opt/kortix/runtime-assets-state.json`, the digest
   * bookkeeping the reconcile already persists, with the in-memory pass
   * overlaid. Compare them sha-to-sha against the manifest, never version string
   * to version string: a version string cannot prove which bytes are on disk.
   *
   * `entrypoint` is deliberately absent. The manifest advertises that component
   * and NO box consumes it — the supervisor IS the entrypoint, so replacing it
   * needs an `exec` on the next loop iteration rather than a file swap under a
   * running shell. It is served for out-of-band repair only (see
   * apps/api/src/services/runtime-assets/manifest.ts), and reporting a digest for
   * something this box never converges would be a second false "current".
   */
  running: RunningRuntimeAssets
}

/** The persisted answer to "which runtime assets is this box running". */
export interface RunningRuntimeAssets {
  cli_sha256: string | null
  managed_skills_hash: string | null
  agent_sha256: string | null
  /** Which file `agent_sha256` was taken from — the baked floor or an update. */
  agent_path: string | null
  /** Verified and waiting for the supervisor; the box is NOT running it yet. */
  staged_agent_sha256: string | null
  /** The harness `harness_version` describes. Null before a pass or bake recorded one. */
  harness: string | null
  /** That harness's release on disk. `routes/kortix/health.ts` adds the pre-W3 alias. */
  harness_version: string | null
  /** Highest manifest epoch this box has converged to, from DISK. */
  build: number | null
  /**
   * Managed model ids this box currently believes are servable — the cheap
   * freshness signal for the third convergeable "asset": the gateway model
   * catalog. Unlike the fields above this is NOT read from the persisted
   * state file (nothing here writes it there); it comes live from the
   * opencode harness's in-process cache, via the optional `catalogSnapshot`
   * hook on `runtimeConvergenceReport`. Null on a harness with no such
   * concept (pi) or a box that has never confirmed a live fetch.
   */
  managed_model_ids: string[] | null
  /**
   * Why this box is not (or was not, last time it tried) confirmed against
   * the control plane's live managed lineup. Null when the last attempt
   * succeeded, or on a harness with no such concept. See
   * `lifecycle.ts`'s `managedCatalogFallbackReason` for the NO-SILENT-
   * STALENESS reasoning this exists for.
   */
  managed_catalog_fallback_reason: string | null
}

const NO_RUNNING_ASSETS: RunningRuntimeAssets = {
  cli_sha256: null,
  managed_skills_hash: null,
  agent_sha256: null,
  agent_path: null,
  staged_agent_sha256: null,
  harness: null,
  harness_version: null,
  build: null,
  managed_model_ids: null,
  managed_catalog_fallback_reason: null,
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Read the persisted digests. Never throws: a missing or corrupt state file
 * answers all-null, which reads as "cannot prove this box is current" — the safe
 * verdict, because it makes the control plane schedule a pass rather than skip
 * one.
 */
/**
 * Digests verified against the file on disk, memoised by (path, size, mtime) so
 * a health read hashes a ~100 MB binary at most once per distinct file version.
 */
const verifiedDigests = new Map<string, string>()

/** Test-only. */
export function __resetVerifiedDigestsForTests(): void {
  verifiedDigests.clear()
}

/**
 * The persisted digest is a CACHE keyed by the file's size and mtime, never
 * proof on its own. The image bake writes it once; anything that replaces the
 * file afterwards without rewriting the state file leaves it describing bytes
 * that are no longer there. The Platinum agent-swap fast path does exactly
 * that: it patches `/usr/local/bin/kortix-agent` into the predecessor's rootfs
 * and keeps the predecessor's state file, so a fresh box reported the OLD
 * agent's digest until its first reconcile (~20 s) finished. Session open read
 * that, saw a mismatch against the manifest, and relaunched a daemon that was
 * already running the right bytes (Dev, 2026-10-02: +17 s on every session
 * booted from a swapped template, both regions).
 *
 * So: when the file's size or mtime no longer match the cache, hash the file.
 * A missing file answers null ("cannot prove"), never the stale cached value.
 */
async function verifiedDigest(
  path: string | null,
  cachedSha: string | null,
  cachedSize: unknown,
  cachedMtimeMs: unknown,
): Promise<string | null> {
  // Only a stat-keyed cache (the bake and every reconcile write size + mtime)
  // claims to describe one specific file version. Without that key there is
  // nothing to check the file against — answer exactly what was persisted.
  if (!path || typeof cachedSize !== 'number' || typeof cachedMtimeMs !== 'number') return cachedSha
  // One open file: the stat and the read describe the same inode, so a swap
  // between "check" and "use" cannot make them disagree.
  let fh: FileHandle
  try {
    fh = await open(path, 'r')
  } catch {
    return null
  }
  try {
    const st = await fh.stat()
    if (!st.isFile()) return null
    const size = st.size
    const mtimeMs = Math.trunc(st.mtimeMs)
    if (cachedSha && cachedSize === size && cachedMtimeMs === mtimeMs) return cachedSha
    const key = `${path}\0${size}\0${mtimeMs}`
    const memo = verifiedDigests.get(key)
    if (memo) return memo
    const sha = createHash('sha256').update(await fh.readFile()).digest('hex')
    verifiedDigests.set(key, sha)
    return sha
  } catch {
    return null
  } finally {
    await fh.close().catch(() => {})
  }
}

export async function runningRuntimeAssets(
  statePath: string = DEFAULT_STATE_PATH,
): Promise<RunningRuntimeAssets> {
  const state = (await readState(statePath)) as RuntimeAssetsState & Record<string, unknown>
  const agentPath = str(state.agent_path)
  const cliPath = str(state.cli_path) ?? DEFAULT_CLI_PATH
  const [agentSha, cliSha] = await Promise.all([
    verifiedDigest(agentPath, str(state.agent_sha256), state.agent_size, state.agent_mtime_ms),
    verifiedDigest(cliPath, str(state.cli_sha256), state.cli_size, state.cli_mtime_ms),
  ])
  return {
    cli_sha256: cliSha,
    managed_skills_hash: str(state.managed_skills_hash),
    agent_sha256: agentSha,
    agent_path: agentPath,
    staged_agent_sha256: str(state.staged_agent_sha256),
    harness: str(state.harness),
    harness_version: str(state.harness_version),
    build: typeof state.build === 'number' && Number.isFinite(state.build) ? state.build : null,
    // Never on disk — overlaid live by `runtimeConvergenceReport`'s
    // `catalogSnapshot` hook. A direct caller of this function alone (there is
    // none in production; `boot.ts`'s health reads always go through
    // `runtimeConvergenceReport`) gets the safe "unconfirmed" default.
    managed_model_ids: null,
    managed_catalog_fallback_reason: null,
  }
}

let lastConvergence: RuntimeConvergenceReport = {
  build: null,
  at: null,
  components: {},
  agentSwapPending: false,
  pinned: false,
  running: NO_RUNNING_ASSETS,
}

/** Record a completed pass. Never throws — this is reporting, not control. */
export function noteRuntimeConvergence(result: RuntimeAssetsResult): void {
  const components: Partial<Record<RuntimeComponent, ReconcileOutcome>> = {
    cli: result.cli,
    skills: result.skills,
  }
  if (result.agent) components.agent = result.agent
  for (const [name, outcome] of Object.entries(result.harness ?? {})) {
    if (outcome) components[name] = outcome
  }
  lastConvergence = {
    build: result.build ?? lastConvergence.build,
    at: new Date().toISOString(),
    components,
    ...(result.reasons ? { reasons: result.reasons } : {}),
    agentSwapPending: result.agentSwapPending === true,
    pinned: lastConvergence.pinned,
    // Re-read from disk by `runtimeConvergenceReport`, not cached here: the
    // state file is the persisted truth and it survives this process.
    running: lastConvergence.running,
  }
}

/**
 * The last recorded pass, for `/kortix/health`.
 *
 * The rollback latch is re-read from disk on every call rather than cached: the
 * SUPERVISOR writes it between daemon runs, so a value captured at reconcile
 * time would be stale exactly when it matters most — on the first health check
 * after a rollback, which is the moment someone is looking.
 */
export async function runtimeConvergenceReport(
  stateDir: string = process.env.KORTIX_AGENT_STATE_DIR ?? DEFAULT_AGENT_STATE_DIR,
  statePath: string = DEFAULT_STATE_PATH,
  /**
   * The opencode harness's live catalog signal, injected rather than imported
   * here directly: this module serves every harness (pi included), and
   * `harness/open-code/lifecycle.ts` is opencode-specific — importing it here
   * would put a gateway-model concept into a module that has none. The
   * default answers "unconfirmed" for any caller that supplies nothing, which
   * is exactly what a harness with no such concept should report.
   */
  catalogSnapshot: () => { ids: string[] | null; fallbackReason: string | null } = () => ({
    ids: null,
    fallbackReason: null,
  }),
): Promise<RuntimeConvergenceReport> {
  // `running` is read from DISK on every call, for the same reason the rollback
  // latch is: it must survive this process. A daemon that restarted seconds ago
  // has an empty `lastConvergence` and would otherwise report `build: null` and
  // no digests at all — "cannot tell" — on exactly the health read the control
  // plane uses to decide whether to schedule a ~100 MB download.
  //
  // BOTH latches, not just the daemon's. `pinned` answers one question — will
  // this box heal itself — and the harness has a rollback latch of its own
  // (`/opt/kortix/opencode.pinned`). Reading only `agent.pinned` reported a box
  // that had latched OpenCode updates off as a box that was fine.
  //
  // Never throws, all the way down: this is reporting, not control, and a
  // health read that 500s is worse than one that says "not pinned".
  const harnessPinned = (async () => {
    try {
      const assets = swapConfig?.assets ?? harnessAssets()
      return (await assets.updatesPinned?.()) === true
    } catch {
      return false
    }
  })()
  const [agentPinned, harnessLatched, running] = await Promise.all([
    agentUpdatesPinned(stateDir),
    harnessPinned,
    runningRuntimeAssets(statePath),
  ])
  const snap = catalogSnapshot()
  return {
    ...lastConvergence,
    pinned: agentPinned || harnessLatched,
    running: {
      ...running,
      managed_model_ids: snap.ids,
      managed_catalog_fallback_reason: snap.fallbackReason,
    },
  }
}

/**
 * How long a fully-converged pass is trusted before the NEXT call-site trigger
 * (boot, `/kortix/refresh`, idle) is allowed to run another one.
 *
 * 2026-09-27: a respawn-heavy box (see `env-sync-skip-decision.ts` for why
 * respawns were happening far more than once per session) fired this reconcile
 * on every single respawn — every one of them re-fetching the manifest and
 * re-hashing the local CLI/skills, competing for the box's network and CPU
 * during the exact window a live turn was also trying to start. Manifest
 * digests are memoized for the life of THIS process and cannot change without
 * a new deploy (`manifest.ts`'s header), so re-checking within seconds of a
 * pass that already fully converged can never find anything new — it is pure
 * cost. This does not weaken the self-heal: a pass that left any component
 * `'failed'` is NOT "fully converged" and is retried on the very next trigger.
 */
const RECONCILE_COOLDOWN_MS = 60_000

/** True when the last completed pass converged every component (nothing
 *  `'failed'`) within `RECONCILE_COOLDOWN_MS`. Exported for the cooldown's own
 *  unit test — see `runtime-assets-reconcile-cooldown.test.ts`. */
export function recentlyFullyConverged(): boolean {
  if (!lastConvergence.at) return false
  const ageMs = Date.now() - Date.parse(lastConvergence.at)
  if (!(ageMs >= 0 && ageMs < RECONCILE_COOLDOWN_MS)) return false
  return !Object.values(lastConvergence.components).some((outcome) => outcome === 'failed')
}

/** Test seam: let a suite pretend the cooldown has elapsed without a real
 *  clock wait, and start each case from a clean slate. */
export function __resetReconcileCooldownForTests(): void {
  lastConvergence = { build: null, at: null, components: {}, agentSwapPending: false, pinned: false, running: NO_RUNNING_ASSETS }
}

/** Test seam: backdate the last-convergence timestamp without a real clock
 *  wait, so the cooldown's expiry can be exercised deterministically. */
export function __setConvergenceTimestampForTests(iso: string): void {
  lastConvergence = { ...lastConvergence, at: iso }
}


export function resetRuntimeConvergenceReportForTests(): void {
  lastConvergence = {
    build: null,
    at: null,
    components: {},
    agentSwapPending: false,
    pinned: false,
    running: NO_RUNNING_ASSETS,
  }
}
