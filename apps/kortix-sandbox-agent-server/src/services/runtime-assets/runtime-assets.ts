import { MANAGED_SKILLS_DIR, RUNTIME_ASSETS_STATE_PATH } from '@kortix/api-contract/sandbox-layout'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import type { Config } from '@/lib/config/config'
import { noteControlPlaneResponse, sessionTokenPresumedDead } from '@/lib/kortix-api/session-token-health'
import { harnessAssets, swapAssets, stagedAgentSha, agentUpdatesPinned, recentlyFullyConverged, noteRuntimeConvergence, requestAgentSwapIfIdle, applyStagedAssetsIfIdle } from './runtime-assets-swap-report'
export { AGENT_SWAP_EXIT_CODE, runtimeConvergenceReport, runningRuntimeAssets, __resetVerifiedDigestsForTests, resetRuntimeConvergenceReportForTests, noteRuntimeConvergence, requestAgentSwapIfIdle, applyStagedAssetsIfIdle, recentlyFullyConverged, __resetReconcileCooldownForTests, __setConvergenceTimestampForTests, registerAgentSwapBlocker, resetAgentSwapBlockersForTests, agentSwapRequiresUnattendedBox, registerHarnessAssets, resetHarnessAssetsForTests, configureRuntimeConvergence, resetRuntimeConvergenceForTests } from './runtime-assets-swap-report'
export type { AgentSwapDecision, AgentSwapOptions, RuntimeConvergenceReport, RunningRuntimeAssets } from './runtime-assets-swap-report'
import type {
  HarnessAssetOutcome,
  HarnessAssetsService,
} from './port'
import { logger } from '@/lib/log/logger'
import { fetchArtifactByChunks } from './runtime-asset-chunks'
import { localDigest, localCliSha } from './runtime-assets-bake'
export { bakeRuntimeAssetsState } from './runtime-assets-bake'
export type { BakeRuntimeAssetsStateOptions } from './runtime-assets-bake'
import { overlayHash, isSafeOverlayPath, fileSha256, readState, writeState, readOverlayFromDisk } from './runtime-assets-state'
export { overlayHash } from './runtime-assets-state'
import { replaceCli } from './runtime-assets-cli'
export { replaceCli } from './runtime-assets-cli'
export type { ReplaceCliDeps } from './runtime-assets-cli'
import { optionalString, manifestComponent, isV2Manifest, manifestBuild, agentSelfUpdateAllowed, resolveArtifactUrl, agentStateDirOf, agentBakedPathOf, isCompiledStandalone } from './runtime-assets-manifest'
import { writeOverlay, fetchJson, fetchArtifact, chunkStoreSources } from './runtime-assets-download'
import { withReleaseStoreLock } from '@/lib/release-store-lock'

/**
 * What the convergence pass is doing RIGHT NOW, for the proxy's not-ready
 * answers (X-Kortix-Boot-Phase). A pass that installs a new OpenCode pin can
 * hold a box in "not ready" for a minute or more (a production box:
 * 1.18.19 → 1.18.23 on resume, 53 s first init on top); the API's boot budget
 * must be able to tell "still working" from "stuck", and this is the signal.
 */
let runtimeAssetsActivityLabel: string | null = null
export function runtimeAssetsActivity(): string | null {
  return runtimeAssetsActivityLabel
}
function setRuntimeAssetsActivity(label: string | null): void {
  runtimeAssetsActivityLabel = label
}

/**
 * DEF-C: "the CLI cannot be updated on this box" is logged at `error` once per
 * process instead of on every reconcile — the whole point is to stop an
 * unwatchable failure from hiding behind its own repetition.
 */
let cliUpdateBlockedLogged = false

/** Test seam: one bun process runs every daemon test file. */
export function resetCliUpdateBlockedNoticeForTests(): void {
  cliUpdateBlockedLogged = false
}

/**
 * Converge this sandbox's runtime assets on the API it talks to.
 *
 * THE BUG THIS FIXES. `/usr/local/bin/kortix` and `/opt/kortix/managed-skills`
 * are baked into a snapshot once and then frozen for the life of the box.
 * Restart and resume suspend/resume the SAME VM, and a warm fork adopts a
 * captured disk — none of them re-run the image build, so a sandbox created
 * months ago keeps a months-old CLI forever. That is how production sandboxes
 * ended up calling `/executor/*` routes that had been renamed to `/connectors/*`
 * and 404ing with no way to notice.
 *
 * THE CONTRACT. Compare digests with `GET /v1/runtime-assets/manifest`, download
 * only on a mismatch, verify the download before it replaces anything, and never
 * throw. Every failure mode leaves the box exactly as it was and logs one line —
 * an unreachable API, a corrupted download, or a read-only filesystem must not
 * cost a session its boot.
 *
 * WHERE IT RUNS. Off the readiness path, always: cold boot fires it after the
 * proxy is up and readiness has been marked, `POST /kortix/refresh` schedules it
 * without awaiting, and warm-fork adoption fires it after the session runtime is
 * already live. Nothing waits on this function.
 */

/** The binary every in-sandbox agent invokes as `kortix`. */
const DEFAULT_CLI_PATH = '/usr/local/bin/kortix'

/**
 * DEF-C 2026-09-26 — the writable PATH fallback for a box whose
 * `/usr/local/bin` is not, and never will be, writable by `kortix`.
 *
 * The shipped image now bakes `/usr/local/bin` kortix-owned
 * (`SANDBOX_CLI_OWNERSHIP_COMMAND`, packages/shared/src/sandbox/
 * platform-binaries.ts) and `replaceCli`'s own `sudo -n chown` escalation
 * heals an older snapshot in place — but a box already running an image from
 * before either of those existed, and that a Platinum suspend/resume never
 * reboots from a fresh image, gets neither: measured on a real box created
 * 2026-08-25, `CLI replace failed {"err":"...EACCES..."}` on every single
 * reconcile, forever, escalation included.
 *
 * `$HOME/.local/bin` needs no escalation at all: it is the daemon's OWN home
 * directory (`useradd --create-home`, every image, always), and
 * `apps/sandbox/entrypoint.sh`'s `KORTIX_PATH` already puts it FIRST on PATH,
 * ahead of `/usr/local/bin` — so a binary installed here immediately shadows
 * the baked one for every later `kortix` invocation, on old boxes and new
 * ones alike. `apps/cli`'s own self-update already relies on this exact path
 * for a non-sandbox install (apps/cli/src/commands/update.ts).
 */
function cliPathFallback(): string {
  return join(process.env.HOME || homedir() || '/home/kortix', '.local', 'bin', 'kortix')
}

/** Image-baked managed-skill overlay root; created here when the image had none. */
const DEFAULT_MANAGED_SKILLS_DIR = MANAGED_SKILLS_DIR
/** Digest bookkeeping, so a converged box never re-hashes a 100 MB binary. */
const DEFAULT_STATE_PATH = RUNTIME_ASSETS_STATE_PATH

/**
 * The image-baked daemon — an IMMUTABLE FLOOR, not an update target.
 *
 * It is root-owned and the daemon runs as `kortix` after the entrypoint's
 * privilege drop, so there is no write path to it from runtime code at all.
 * That is deliberate: it is what makes a bricked box impossible rather than
 * merely unlikely. Updates install BESIDE it, in the kortix-owned state dir
 * below, and the supervisor prefers `agent.current` when one is present.
 */
const DEFAULT_AGENT_BAKED_PATH = '/usr/local/bin/kortix-agent'
/**
 * kortix-owned state dir. Holds this module's digest cache plus the four files
 * the supervisor owns: `agent.current` (the installed update), `agent.next`
 * (what THIS module stages), `agent.prev` (rollback target) and `agent.pinned`
 * (the rollback latch). Only `agent.next` + `agent.next.sha256` are ever
 * written here by the daemon. See apps/sandbox/entrypoint.sh.
 */
const DEFAULT_AGENT_STATE_DIR = '/opt/kortix'

/**
 * `EX_TEMPFAIL` — the daemon's way of saying "replace me and start me again".
 *
 * The supervisor must be able to tell a requested swap from a crash: exit 75 is
 * intentional, every other non-zero exit counts against the failure budget that
 * triggers rollback. Keep this in lockstep with `SWAP_CODE` in
 * apps/sandbox/entrypoint.sh.
 */

const MANIFEST_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 180_000

/**
 * `staged` is agent-only: the bytes are verified and on disk, and the swap
 * happens in the supervisor at the next start — nothing has been replaced yet.
 */
export type ReconcileOutcome = HarnessAssetOutcome

/** The components a v2 manifest can describe. */
export type RuntimeComponent = 'cli' | 'skills' | 'agent' | (string & {})

export interface RuntimeAssetsResult {
  cli: ReconcileOutcome
  skills: ReconcileOutcome
  /**
   * Agent and harness components are OMITTED for a v1 manifest, not reported
   * as `skipped`. A manifest that predates `components` says nothing at all about
   * them, and "we did not converge it" and "we were never told what it should
   * be" are different facts. It also keeps every existing caller's shape.
   */
  agent?: ReconcileOutcome
  /** The selected harness's own components (`HarnessAssetsService.componentNames`). */
  harness?: Partial<Record<string, ReconcileOutcome>>
  /** The manifest epoch this pass converged to; absent for a v1 manifest. */
  build?: number
  /** Why, when a half is `skipped` or `failed`. Logged, never thrown. */
  reason?: string
  /** Per-component `reason`, for the components that carry one. */
  reasons?: Partial<Record<RuntimeComponent, string>>
  /**
   * A verified agent binary is staged and the supervisor will install it at the
   * next start. Callers may ask for that start early via
   * {@link requestAgentSwapIfIdle} — never unconditionally.
   */
  agentSwapPending?: boolean
}

/**
 * Run a downloaded artifact and report its exit code.
 *
 * THE PROOF A DIGEST CANNOT GIVE. A sha256 says the bytes arrived intact. It
 * says nothing about whether they RUN on this kernel and this architecture — a
 * wrong-arch or truncated-at-the-right-length artifact passes every digest check
 * and then cannot exec. Before this, the first thing to execute a new daemon was
 * the SUPERVISOR, after it had already replaced the running one, with
 * `HEALTHY_AFTER_S=60` as the only safety net; and nothing ever executed a new
 * CLI at all.
 *
 * EXIT CODE, NOT VERSION STRING, on purpose. `kortix --version` prints a
 * decorated header (`header('Kortix CLI', VERSION)` in apps/cli/src/index.ts),
 * so comparing its stdout to the manifest's `cli_version` would assert a
 * formatting detail rather than a fact — and a false negative would freeze CLI
 * updates fleet-wide while looking like a safety feature. `opencode --version`
 * prints a bare version, which is why `installOpencodeVersion` can and does
 * compare it. What is asserted here is the thing that actually differs between a
 * good artifact and a bad one: it executes.
 *
 * It cannot prove the box BOOTS on the new daemon — that needs a second daemon,
 * and a second daemon cannot bind the same ports. The supervisor's
 * `HEALTHY_AFTER_S` / `MAX_EARLY_EXITS` budget remains the behavioural proof.
 */
export type ExecProbe = (path: string, args: string[]) => Promise<number>

const EXEC_PROBE_TIMEOUT_MS = 30_000

export const defaultExecProbe: ExecProbe = async (path, args) => {
  try {
    const proc = Bun.spawn([path, ...args], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    const timer = setTimeout(() => proc.kill(), EXEC_PROBE_TIMEOUT_MS)
    try {
      return await proc.exited
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    logger.warn('[runtime-assets] candidate binary could not be spawned', {
      path,
      err: String(err),
    })
    return -1
  }
}

export interface RuntimeAssetsOptions {
  apiUrl?: string
  token?: string
  cliPath?: string
  managedSkillsDir?: string
  statePath?: string
  /** Active harness config dir; the overlay is re-applied into it after an update. */
  configDir?: string
  fetchImpl?: typeof fetch
  /** Where `agent.next` is staged. Defaults to `$KORTIX_AGENT_STATE_DIR`. */
  agentStateDir?: string
  /** The immutable baked daemon. Defaults to `$KORTIX_AGENT_BIN`. */
  agentBakedPath?: string
  /** Harness-owned installation and injection; live when registered at boot. */
  assets?: HarnessAssetsService
  /** Runs a candidate binary before it replaces a working one. See {@link ExecProbe}. */
  execProbe?: ExecProbe
  /**
   * DEF-C: the writable PATH fallback tried when `cliPath`'s directory is not
   * writable (and the daemon's own escalation cannot fix that). Defaults to
   * {@link cliPathFallback}; injectable for tests.
   */
  cliFallbackPath?: string
  /** Test seam for `replaceCli`'s directory-unlock escalation. See `ReplaceCliDeps.unlockDir`. */
  unlockCliDir?: (dir: string) => Promise<boolean>
  /** The chunk store this pass may reuse bytes from. Defaults to the box's own
   *  binaries (see {@link chunkStoreSources}); injectable for tests, whose box
   *  can carry real multi-megabyte binaries the indexer would hash for minutes. */
  localChunkSources?: string[]
}

/** One entry of the v2 `components` map. Every field is optional by contract. */
export interface ManifestComponent {
  version?: unknown
  sha256?: unknown
  size?: unknown
  path?: unknown
  hash?: unknown
  source?: unknown
}

export interface RuntimeAssetsManifest {
  // v1 — load-bearing for daemons already in the field. Never removed.
  cli_version: string | null
  cli_sha256: string | null
  cli_size: number | null
  managed_skills_hash: string
  // v2 — additive. Absent when this box talks to an older API.
  build?: unknown
  components?: unknown
  policy?: unknown
}

export interface OverlayFile {
  path: string
  content: string
}

export interface RuntimeAssetsState {
  cli_sha256?: string
  cli_size?: number
  cli_mtime_ms?: number
  /**
   * DEF-C: which path the digest cache above describes. Absent means the
   * primary `cliPath` (`/usr/local/bin/kortix`), as it always did before this
   * field existed. Once a box has ever installed to the PATH fallback, PATH
   * resolves there first — the RUNNING CLI is the fallback file — so the next
   * reconcile must hash and replace that one, not a stale or absent primary.
   */
  cli_path?: string
  managed_skills_hash?: string
  /** Highest manifest epoch this box has converged to. See the epoch guard. */
  build?: number
  /**
   * Digest cache for the RUNNING daemon, keyed by the path it was taken from.
   * The path moves (baked floor → `agent.current`) the first time an update is
   * installed, and a cache that ignored that would answer for the wrong file.
   */
  agent_path?: string
  agent_sha256?: string
  agent_size?: number
  agent_mtime_ms?: number
  /** Digest of the artifact currently staged at `agent.next`, if any. */
  staged_agent_sha256?: string
  /** The harness the last pass or the image bake reported for (`HarnessAssetsService.harness`). */
  harness?: string
  /** That harness's release on disk (`HarnessAssetsResult.version`, `bakedVersion`). */
  harness_version?: string
}

/**
 * The single choke point every downloaded artifact passes through before it is
 * allowed anywhere near a path something else will execute.
 *
 * Today this is a digest-from-the-manifest check: integrity against truncation
 * and corruption, NOT against a compromised API. Artifact signing against a key
 * baked into the image is the next increment and lands here, in one place, on
 * purpose.
 */
export function verifyArtifact(bytes: Uint8Array, expectedSha: string): boolean {
  return createHash('sha256').update(bytes).digest('hex') === expectedSha
}

export async function resolveRunningAgentPath(options: RuntimeAssetsOptions): Promise<string> {
  if (isCompiledStandalone() && process.execPath) return process.execPath
  const current = join(agentStateDirOf(options), 'agent.current')
  const usable = await stat(current).then(
    (s) => s.isFile(),
    () => false,
  )
  return usable ? current : agentBakedPathOf(options)
}

/**
 * Stage a verified daemon binary for the supervisor to install at the next
 * start. NOTHING is replaced here and nothing restarts.
 *
 * Write order is deliberate: the bytes are verified in a temp file, the digest
 * side-car is renamed into place, and only then does `agent.next` itself
 * appear. Every interruption therefore leaves a state the supervisor already
 * refuses — `agent.next` absent (nothing to promote), or present with a digest
 * that does not describe it (discarded). It can never leave one it would
 * install blind.
 */
async function stageAgentBinary(
  stateDir: string,
  expectedSha: string,
  body: Uint8Array,
  execProbe: ExecProbe,
): Promise<'staged' | 'failed' | 'unrunnable'> {
  const nextPath = join(stateDir, 'agent.next')
  // Same directory as the destination: `rename` is atomic only within one
  // filesystem, and a cross-device temp file fails with EXDEV.
  const tmpPath = join(
    stateDir,
    `.agent.download.${process.pid}.${Math.random().toString(36).slice(2, 10)}`,
  )
  const tmpShaPath = `${tmpPath}.sha256`
  try {
    await mkdir(stateDir, { recursive: true })
    const bytes = body
    await writeFile(tmpPath, bytes)
    if (!verifyArtifact(bytes, expectedSha)) {
      logger.warn('[runtime-assets] agent download digest mismatch — nothing staged', {
        expected: expectedSha,
      })
      return 'failed'
    }
    await chmod(tmpPath, 0o755)
    // RUN IT FIRST, from the temp path, before anything the supervisor reads
    // exists. `version` is the daemon's own subcommand (cli.ts) and exits 0 on a
    // binary that can start; a wrong-arch artifact cannot get that far. The
    // supervisor re-verifies the digest independently and keeps its own
    // `HEALTHY_AFTER_S` budget — this only removes the class of failure that
    // budget pays for with a restart.
    const code = await execProbe(tmpPath, ['version'])
    if (code !== 0) {
      logger.warn('[runtime-assets] agent candidate did not run — nothing staged', {
        exitCode: code,
        expected: expectedSha.slice(0, 12),
      })
      return 'unrunnable'
    }
    await writeFile(tmpShaPath, `${expectedSha}\n`, 'utf8')
    await rename(tmpShaPath, `${nextPath}.sha256`)
    await rename(tmpPath, nextPath)
    return 'staged'
  } catch (err) {
    logger.warn('[runtime-assets] agent staging failed', { err: String(err) })
    return 'failed'
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {})
    await rm(tmpShaPath, { force: true }).catch(() => {})
  }
}

/** Drop a staged artifact the API no longer advertises, so the supervisor never
 *  promotes a build this box has already moved past. */
async function discardStagedAgent(stateDir: string): Promise<void> {
  const nextPath = join(stateDir, 'agent.next')
  await rm(nextPath, { force: true }).catch(() => {})
  await rm(`${nextPath}.sha256`, { force: true }).catch(() => {})
}

export async function reconcileRuntimeAssets(
  options: RuntimeAssetsOptions = {},
): Promise<RuntimeAssetsResult> {
  // A credential the control plane has refused, repeatedly and without
  // contradiction, cannot be fixed by asking again: every request below carries
  // that same dead token. The runtime-truth ticker runs this every 60 s, so a
  // box that stays up after its session row is parked fetches the manifest
  // forever and the API logs one `warn` 401 per fetch — the `infra:log` spike
  // this guards. The breaker lets one call through as a probe every 5 min and
  // clears on the next answer that is not the dead-token 401, so the pass
  // resumes on its own, and nothing stops the process (see
  // `session-token-health.ts`'s header).
  if (sessionTokenPresumedDead()) {
    return { cli: 'skipped', skills: 'skipped', reason: 'session credential refused by the control plane' }
  }
  const fetchImpl = options.fetchImpl ?? fetch
  const cliPath = options.cliPath ?? DEFAULT_CLI_PATH
  const skillsDir = options.managedSkillsDir ?? DEFAULT_MANAGED_SKILLS_DIR
  const statePath = options.statePath ?? DEFAULT_STATE_PATH
  const assets = options.assets ?? harnessAssets()
  const execProbe = options.execProbe ?? defaultExecProbe
  const token = (
    options.token ??
    process.env.KORTIX_TOKEN ??
    ''
  ).trim()
  const rawApiUrl = (options.apiUrl ?? process.env.KORTIX_API_URL ?? '').trim().replace(/\/+$/, '')
  if (!token || !rawApiUrl) {
    // Local/self-host daemons legitimately run with neither. Not an error.
    return { cli: 'skipped', skills: 'skipped', reason: 'api url or token unset' }
  }
  const apiRoot = rawApiUrl.endsWith('/v1') ? rawApiUrl : `${rawApiUrl}/v1`
  const base = `${apiRoot}/runtime-assets`

  let manifest: RuntimeAssetsManifest | null
  try {
    manifest = await fetchJson<RuntimeAssetsManifest>(
      fetchImpl,
      `${base}/manifest`,
      token,
      MANIFEST_TIMEOUT_MS,
    )
  } catch (err) {
    return { cli: 'skipped', skills: 'skipped', reason: `manifest fetch failed: ${String(err)}` }
  }
  if (!manifest) {
    return { cli: 'skipped', skills: 'skipped', reason: 'manifest unavailable' }
  }

  const state = await readState(statePath)
  const nextState: RuntimeAssetsState = { ...state }
  const build = manifestBuild(manifest)
  const reasons: Partial<Record<RuntimeComponent, string>> = {}

  // ── Epoch guard ────────────────────────────────────────────────────────────
  // A box only ever moves FORWARD. During a rolling deploy two API versions are
  // live at once and serve two different manifests; a box that talked to both
  // would converge to A, then back to B, then back to A — re-downloading
  // hundreds of megabytes on every flip, for as long as the rollout takes. That
  // is not hypothetical: it is the shape of the 2026-07-22 warm-image infinite
  // mutual-rebuild loop, and the Daytona 429s that came with it.
  //
  // EQUAL is accepted, not just greater: re-converging to the same build is
  // idempotent and is what every ordinary restart does.
  if (build !== undefined && state.build !== undefined && build < state.build) {
    return {
      cli: 'skipped',
      skills: 'skipped',
      build: state.build,
      reason: `manifest build ${build} is older than converged build ${state.build}`,
    }
  }

  // The v2 `components` map is preferred whenever the API states it, and the v1
  // fields remain the fallback. That is the whole compatibility contract: a new
  // daemon against an old API keeps converging the CLI exactly as it does
  // today, and an old daemon against a new API never notices the new keys.
  const cliComponent = manifestComponent(manifest, 'cli')
  const cliSha = optionalString(cliComponent?.sha256) ?? manifest.cli_sha256 ?? null
  const cliVersion = optionalString(cliComponent?.version) ?? manifest.cli_version
  const skillsComponent = manifestComponent(manifest, 'managed-skills')
  const skillsHash = optionalString(skillsComponent?.hash) ?? manifest.managed_skills_hash

  // 'skipped' holds when a branch below never reassigns — e.g. a checkout that
  // never built the CLI (no cli digest stated): nothing to converge on.
  let cli: ReconcileOutcome = 'skipped'
  let skills: ReconcileOutcome

  // ── CLI ────────────────────────────────────────────────────────────────────
  if (cliSha) {
    try {
      // DEF-C: once this box has ever fallen back, PATH already resolves
      // `kortix` to the fallback file (it precedes the primary path on PATH)
      // — so that is the running CLI, and the one this pass must hash and
      // replace. A box that has never fallen back reads the primary, exactly
      // as before this field existed.
      const effectiveCliPath =
        state.cli_path && state.cli_path !== cliPath ? state.cli_path : cliPath
      const local = await localCliSha(effectiveCliPath, state)
      if (local && local.sha === cliSha) {
        cli = 'current'
        nextState.cli_sha256 = local.sha
        nextState.cli_size = local.size
        nextState.cli_mtime_ms = local.mtimeMs
        nextState.cli_path = effectiveCliPath
      } else {
        const fetched = await fetchArtifact(
          fetchImpl,
          base,
          token,
          'cli',
          cliSha,
          resolveArtifactUrl(apiRoot, cliComponent?.path, `${base}/cli`),
          await chunkStoreSources(effectiveCliPath, options),
        )
        if (!('bytes' in fetched)) {
          logger.warn('[runtime-assets] CLI download non-ok', { status: fetched.status })
          cli = 'failed'
        } else {
          const body = fetched.bytes
          // Verify ONCE, before any location is even chosen: a digest that
          // does not match the manifest is wrong everywhere, and retrying the
          // identical bytes at a second path would not just waste a hash of a
          // ~100 MB buffer — DEF-C's own tests found it reaching this box's
          // REAL `$HOME/.local/bin` in a case that has nothing to do with a
          // permission problem at all.
          if (!verifyArtifact(body, cliSha)) {
            logger.warn('[runtime-assets] CLI download digest mismatch — keeping the installed binary', {
              expected: cliSha,
            })
            cli = 'failed'
          } else {
            let replaced = await replaceCli(cliPath, cliSha, body, {
              execProbe,
              unlockDir: options.unlockCliDir,
            })
            let installedPath = cliPath
            // The artifact is verified-good, so a `failed` here is
            // specifically "nowhere on the primary path is writable" — the
            // daemon's own escalation (sudoOwnDir) already tried and lost. A
            // box already on the fallback (`effectiveCliPath !== cliPath`)
            // has no reason to retry the primary at all.
            if (replaced === 'failed' && effectiveCliPath === cliPath) {
              // The $HOME fallback exists for the Linux sandbox (home = /home/kortix).
              // Never on a developer machine, where it is the user's real CLI.
              const fallbackPath = options.cliFallbackPath ?? (process.platform === 'linux' ? cliPathFallback() : null)
              let fallbackReplaced: Awaited<ReturnType<typeof replaceCli>> = 'failed'
              if (fallbackPath) {
                await mkdir(dirname(fallbackPath), { recursive: true }).catch(() => {})
                fallbackReplaced = await replaceCli(fallbackPath, cliSha, body, { execProbe })
              }
              if (fallbackReplaced === 'updated' && fallbackPath) {
                logger.warn(
                  '[runtime-assets] /usr/local/bin is not writable on this box; installed the CLI to its PATH fallback instead',
                  { path: fallbackPath },
                )
                replaced = fallbackReplaced
                installedPath = fallbackPath
              } else if (fallbackReplaced === 'unrunnable') {
                replaced = fallbackReplaced
              } else {
                // Neither location works. This box can never update its CLI
                // by itself — say so LOUDLY, once per process, instead of the
                // defect this fixes: the identical warn line, forever, that
                // nobody is watching for.
                if (!cliUpdateBlockedLogged) {
                  cliUpdateBlockedLogged = true
                  logger.error(
                    '[runtime-assets] kortix CLI cannot be updated on this box: neither /usr/local/bin nor its PATH fallback is writable',
                    { primary: cliPath, fallback: fallbackPath },
                  )
                }
                reasons.cli = 'cannot be updated: neither /usr/local/bin nor its PATH fallback is writable'
              }
            }
            if (replaced === 'unrunnable') {
              cli = 'failed'
              reasons.cli = 'the downloaded CLI did not run on this box'
            } else {
              cli = replaced
            }
            if (cli === 'updated') {
              const stats = await stat(installedPath).catch(() => null)
              nextState.cli_sha256 = cliSha
              nextState.cli_size = stats?.size
              nextState.cli_mtime_ms = stats ? Math.trunc(stats.mtimeMs) : undefined
              nextState.cli_path = installedPath
              logger.info('[runtime-assets] kortix CLI updated from the API', {
                version: cliVersion,
                sha256: cliSha.slice(0, 12),
                path: installedPath,
              })
            }
          }
        }
      }
    } catch (err) {
      logger.warn('[runtime-assets] CLI reconcile failed', { err: String(err) })
      cli = 'failed'
    }
  }

  // ── Managed skills ─────────────────────────────────────────────────────────
  try {
    if (!skillsHash) {
      // A manifest that states no overlay hash is one we cannot verify a
      // payload against. Skipping keeps the baked overlay, which works.
      skills = 'skipped'
      reasons.skills = 'manifest states no managed-skills hash'
    } else {
      const overlayPresent = await stat(skillsDir).then(
        (s) => s.isDirectory(),
        () => false,
      )
      if (overlayPresent && state.managed_skills_hash === skillsHash) {
        skills = 'current'
      } else {
        const payload = await fetchJson<{ hash: string; files: OverlayFile[] }>(
          fetchImpl,
          `${base}/managed-skills`,
          token,
          DOWNLOAD_TIMEOUT_MS,
        )
        if (!payload || !Array.isArray(payload.files)) {
          skills = 'failed'
        } else if (overlayHash(payload.files) !== skillsHash) {
          logger.warn(
            '[runtime-assets] managed-skill payload digest mismatch — keeping the overlay',
            { expected: skillsHash },
          )
          skills = 'failed'
        } else {
          // Rewrite the overlay and re-apply it to the live config dir in ONE
          // section of the release-store lock: a release verification that
          // saw the new overlay names without the injected files, or the
          // injected files without the names, reported an added file and
          // rebuilt the running release (DEF-5). The boot-time injection
          // already ran, so nothing else would pick the new bodies up.
          await withReleaseStoreLock(async () => {
            await writeOverlay(skillsDir, payload.files)
            if (options.configDir) {
              await assets.injectSkills(options.configDir, skillsDir).catch((err) =>
                logger.warn('[runtime-assets] overlay re-injection failed', { err: String(err) }),
              )
            }
          })
          nextState.managed_skills_hash = skillsHash
          skills = 'updated'
          logger.info('[runtime-assets] managed-skill overlay updated from the API', {
            files: payload.files.length,
            hash: skillsHash.slice(0, 12),
          })
        }
      }
    }
  } catch (err) {
    logger.warn('[runtime-assets] managed-skill reconcile failed', { err: String(err) })
    skills = 'failed'
  }

  // ── Agent — STAGE ONLY ─────────────────────────────────────────────────────
  // A process cannot safely overwrite its own running binary, and the baked one
  // is root-owned while we run as `kortix`, so this half never swaps anything.
  // It writes `agent.next` + `agent.next.sha256` and stops. The supervisor in
  // apps/sandbox/entrypoint.sh re-verifies and installs at the next start —
  // which `requestAgentSwapIfIdle` can bring forward when the box is idle.
  const v2 = isV2Manifest(manifest)
  const stateDir = agentStateDirOf(options)
  let agent: ReconcileOutcome | undefined
  let agentSwapPending: boolean | undefined
  if (v2) {
    agent = 'skipped'
    try {
      const component = manifestComponent(manifest, 'agent')
      const expectedSha = optionalString(component?.sha256)
      if (!expectedSha) {
        reasons.agent = 'manifest states no agent component'
      } else if (!agentSelfUpdateAllowed(manifest)) {
        // The kill switch. Deliberately checked BEFORE any digest work: the
        // whole point is to stop a rollout centrally, without shipping code to
        // boxes that may no longer boot.
        //
        // It also RETRACTS work already done. A box that staged the bad build
        // minutes before the switch was flipped would otherwise still install
        // it at its next start — and the supervisor cannot help, because it
        // knows nothing about policy. Flipping the switch has to stop the
        // rollout on boxes that have already fetched it, or it does not stop
        // the rollout.
        await discardStagedAgent(stateDir)
        nextState.staged_agent_sha256 = undefined
        reasons.agent = 'policy.agent_self_update is false'
      } else if (await agentUpdatesPinned(stateDir)) {
        // The supervisor rolled an update back and latched. Re-staging the same
        // build would download ~96 MB the supervisor is guaranteed to discard,
        // on every start, for ever.
        reasons.agent = 'updates pinned after a rollback'
      } else {
        const runningPath = await resolveRunningAgentPath(options)
        const running = await localDigest(
          runningPath,
          state.agent_path === runningPath
            ? { sha: state.agent_sha256, size: state.agent_size, mtimeMs: state.agent_mtime_ms }
            : {},
        )
        if (running) {
          nextState.agent_path = runningPath
          nextState.agent_sha256 = running.sha
          nextState.agent_size = running.size
          nextState.agent_mtime_ms = running.mtimeMs
        }
        const staged = await stagedAgentSha(stateDir)
        if (running && running.sha === expectedSha) {
          agent = 'current'
          // Anything still staged describes a build this box has moved past;
          // leaving it would have the supervisor install it at the next start.
          if (staged && staged !== expectedSha) await discardStagedAgent(stateDir)
          nextState.staged_agent_sha256 = undefined
        } else if (staged === expectedSha) {
          // Already staged by an earlier pass and not yet promoted. Do not
          // re-download it just because the process restarted.
          agent = 'staged'
          agentSwapPending = true
          nextState.staged_agent_sha256 = staged
        } else {
          // Either the running binary differs, or there is no readable binary
          // at the resolved path to compare against. Both mean "cannot prove
          // this box is current", and staging is the safe answer to that: the
          // supervisor verifies the artifact again before it installs it.
          const fetched = await fetchArtifact(
            fetchImpl,
            base,
            token,
            'agent',
            expectedSha,
            resolveArtifactUrl(apiRoot, component?.path, `${base}/agent`),
            await chunkStoreSources(cliPath, options),
          )
          if (!('bytes' in fetched)) {
            logger.warn('[runtime-assets] agent download non-ok', { status: fetched.status })
            agent = 'failed'
            reasons.agent = `agent download returned ${fetched.status}`
          } else {
            const stagedOutcome = await stageAgentBinary(
              stateDir,
              expectedSha,
              fetched.bytes,
              execProbe,
            )
            if (stagedOutcome === 'unrunnable') {
              agent = 'failed'
              reasons.agent = 'the downloaded agent did not run on this box'
            } else {
              agent = stagedOutcome
            }
            if (agent === 'staged') {
              agentSwapPending = true
              nextState.staged_agent_sha256 = expectedSha
              logger.info('[runtime-assets] agent staged for the supervisor to install', {
                version: optionalString(component?.version),
                sha256: expectedSha.slice(0, 12),
                runningSha256: running?.sha.slice(0, 12) ?? null,
              })
            } else if (stagedOutcome === 'failed') {
              reasons.agent = 'staged artifact failed verification'
            }
          }
        }
      }
    } catch (err) {
      logger.warn('[runtime-assets] agent reconcile failed', { err: String(err) })
      agent = 'failed'
      reasons.agent = String(err)
    }
  }

  // Native component semantics belong to the selected harness. Keep the
  // shared pass responsible for ordering and persisting the combined result.
  const harnessResult = await assets.reconcile({ manifest, setActivity: setRuntimeAssetsActivity })
  Object.assign(nextState, harnessResult.state)
  Object.assign(reasons, harnessResult.reasons)
  nextState.harness = assets.harness
  if (harnessResult.version) nextState.harness_version = harnessResult.version

  // The epoch advances only after a pass that actually looked at this manifest.
  // It is recorded even when a half failed: `build` answers "which manifest did
  // this box last read", and the per-component outcomes answer what it managed
  // to do with it. Conflating the two would make a single failed download
  // re-open the flapping window the guard exists to close.
  if (build !== undefined && (state.build === undefined || build >= state.build)) {
    nextState.build = build
  }

  await writeState(statePath, nextState)
  const result: RuntimeAssetsResult = { cli, skills }
  if (agent !== undefined) result.agent = agent
  if (Object.keys(harnessResult.components).length > 0) result.harness = harnessResult.components
  if (build !== undefined) result.build = build
  if (agentSwapPending) result.agentSwapPending = true
  if (Object.keys(reasons).length > 0) result.reasons = reasons
  return result
}

/**
 * Single-flight guard for the detached entry point below. Boot readiness and a
 * `POST /kortix/refresh` can land within milliseconds of each other; without
 * this they would both download a ~100 MB binary and race to rename over it.
 */
let inFlight: Promise<RuntimeAssetsResult> | null = null

/**
 * Fire-and-forget entry point for the boot/refresh/adopt call sites. Returns
 * immediately; the pass runs detached and swallows everything.
 */
export function ensureLatestKortixAssets(
  configDir?: string,
  opts: { atIdleBoundary?: boolean } = {},
): void {
  if (inFlight) return
  if (recentlyFullyConverged()) return
  inFlight = reconcileRuntimeAssets({ configDir, assets: swapAssets() })
  void inFlight
    .finally(() => {
      inFlight = null
    })
    .then(async (result) => {
      // Record BEFORE the swap request below: `requestAgentSwapIfIdle` can exit
      // the process, and a pass that converged but never got reported would
      // make the box look like it had not run at all.
      noteRuntimeConvergence(result)
      if (Object.values(result).some((outcome) => outcome === 'updated')) {
        logger.info('[runtime-assets] reconcile complete', result)
      } else {
        logger.info('[runtime-assets] reconcile no-op', result)
      }
      // Asked at most once per pass, and only when a verified binary is
      // actually waiting. A busy box simply keeps the staging: the supervisor
      // installs it at the next start.
      if (result.agentSwapPending) {
        const decision = await requestAgentSwapIfIdle({ atIdleBoundary: opts.atIdleBoundary })
        if (decision !== 'exited') {
          logger.info('[runtime-assets] agent update staged; swap deferred', { decision })
        }
      }
    })
    .catch((err) => logger.warn('[runtime-assets] reconcile threw', { err: String(err) }))
}

/**
 * The call-site form: resolve the session's live harness config dir, then run a
 * detached pass. Returns synchronously — nothing here is ever on a readiness or
 * request-latency path.
 */
export function scheduleRuntimeAssetsReconcile(
  cfg: Config,
  opts: { atIdleBoundary?: boolean } = {},
): void {
  void harnessAssets(cfg).resolveConfigDir(cfg)
    .then((configDir) => ensureLatestKortixAssets(configDir, opts))
    // A config dir we cannot resolve costs the overlay re-injection, not the
    // CLI update — still worth running.
    .catch(() => ensureLatestKortixAssets(undefined, opts))
}

/**
 * THE TRIGGER THAT WAS MISSING — a turn just ended, so converge and apply.
 *
 * Before this, `scheduleRuntimeAssetsReconcile` had exactly two non-test call
 * sites: `runtimeReadyTail` (boot) and `POST /kortix/refresh`. The swap request
 * lives in the tail of that same pass, and the boot pass fires seconds after
 * `opencode-ready`, so it always answered `too-young` against the five-minute
 * boot-flap floor. No later pass existed. The result: a long-lived box staged a
 * daemon update and never installed it, for as long as the box lived.
 *
 * TWO INDEPENDENT STEPS, and the independence is the point:
 *
 *  1. a fresh reconcile pass — single-flighted, a no-op when one is running;
 *  2. apply whatever is ALREADY staged, regardless of (1). The binary that needs
 *     installing was staged by an EARLIER pass, so a box whose pass happens to be
 *     in flight must still swap.
 *
 * NOT A TIMER. It is called from the box's own `session.idle` frame, which is
 * the only moment the box knows for certain that no turn is running. A timer
 * near a readiness decision is exactly what the config-releases AST tripwires
 * forbid, and this must stay on the right side of that line.
 *
 * Returns synchronously and swallows everything: a turn end is never delayed or
 * failed by this.
 */
export function convergeRuntimeAssetsAtTurnEnd(cfg: Config): void {
  scheduleRuntimeAssetsReconcile(cfg, { atIdleBoundary: true })
  void applyStagedAssetsIfIdle()
    .then((decision) => {
      if (decision === 'exited' || decision === 'nothing-staged') return
      logger.info('[runtime-assets] staged update not applied at this turn boundary', { decision })
    })
    .catch((err) => logger.warn('[runtime-assets] turn-end apply threw', { err: String(err) }))
}
