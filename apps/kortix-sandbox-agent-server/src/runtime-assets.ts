import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { resolveOpencodeConfigDir, type Config } from './config'
import { ensureInjectedManagedSkills } from './injected-skills'
import { logger } from './logger'
import {
  captureProcessOutput,
  OPENCODE_CURRENT_LINK,
  publishOpencodeNativeLink,
  resolveInstalledOpencodeNative,
  type CaptureCommand,
} from './opencode-binary'
import { OPENCODE_CONFIG_DEPS_DIR } from './opencode-config-deps'
import { opencodeTurnInFlight } from './opencode-turn-state'

const execFileAsync = promisify(execFile)

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
/** Image-baked managed-skill overlay root; created here when the image had none. */
const DEFAULT_MANAGED_SKILLS_DIR = '/opt/kortix/managed-skills'
/** Digest bookkeeping, so a converged box never re-hashes a 100 MB binary. */
const DEFAULT_STATE_PATH = '/opt/kortix/runtime-assets-state.json'

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
export const AGENT_SWAP_EXIT_CODE = 75

const MANIFEST_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 180_000
/** opencode is ~167 MB from npm and installs on a 1-2 vCPU box. */
const OPENCODE_INSTALL_TIMEOUT_MS = 600_000
const OPENCODE_HEALTH_TIMEOUT_MS = 5_000

/**
 * `staged` is agent-only: the bytes are verified and on disk, and the swap
 * happens in the supervisor at the next start — nothing has been replaced yet.
 */
export type ReconcileOutcome = 'skipped' | 'current' | 'updated' | 'failed' | 'staged'

/** The components a v2 manifest can describe. */
export type RuntimeComponent = 'cli' | 'skills' | 'agent' | 'opencode'

export interface RuntimeAssetsResult {
  cli: ReconcileOutcome
  skills: ReconcileOutcome
  /**
   * Agent and opencode are OMITTED for a v1 manifest rather than reported as
   * `skipped`. A manifest that predates `components` says nothing at all about
   * them, and "we did not converge it" and "we were never told what it should
   * be" are different facts. It also keeps every existing caller's shape.
   */
  agent?: ReconcileOutcome
  opencode?: ReconcileOutcome
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
 * The live runtime this pass is allowed to touch.
 *
 * opencode convergence restarts opencode, so it needs the daemon's own
 * lifecycle owner (`src/opencode.ts`) and the one authoritative answer to "is a
 * turn running" (`src/opencode-turn-state.ts`). Both are passed in rather than
 * reached for: this module must stay runnable from a test with no runtime at
 * all, and a second source of truth for turn state is exactly the bug class the
 * turn-state module exists to prevent.
 */
export interface RuntimeConvergenceSeam {
  /** Live opencode base URL — `opencode.getInternalUrl()`, re-read per pass
   *  because a verified reload moves the port. */
  opencodeBaseUrl: () => string
  /** The directory opencode serves — `cfg.workspace`. */
  workspace: string
  /** Restart through the supervisor that owns spawn/respawn/dispose. */
  restartOpencode: () => Promise<void>
}

export interface RuntimeAssetsOptions {
  apiUrl?: string
  token?: string
  cliPath?: string
  managedSkillsDir?: string
  statePath?: string
  /** Active opencode config dir; the overlay is re-applied into it after an update. */
  configDir?: string
  fetchImpl?: typeof fetch
  /** Injected for tests; production uses the daemon's own overlay routine. */
  injectSkills?: (configDir: string, bakedDir: string) => Promise<void>
  /** Where `agent.next` is staged. Defaults to `$KORTIX_AGENT_STATE_DIR`. */
  agentStateDir?: string
  /** The immutable baked daemon. Defaults to `$KORTIX_AGENT_BIN`. */
  agentBakedPath?: string
  /** Override "which binary is this process running from". Tests only. */
  runningAgentPath?: string
  /** Present only when the daemon has a live runtime to converge. */
  seam?: RuntimeConvergenceSeam
  /** Test seams. The production installer also publishes the stable native link. */
  installOpencode?: (version: string) => Promise<void>
  readOpencodeVersion?: (baseUrl: string) => Promise<string | null>
  turnProbe?: (baseUrl: string, workspace: string) => Promise<boolean | null>
  /** Baked dependency dir holding the `@opencode-ai/plugin` pin. */
  opencodeDepsDir?: string
  /** Test seam for the `bun install` that materializes a refreshed plugin pin. */
  installPluginDeps?: (dir: string) => Promise<void>
}

/** One entry of the v2 `components` map. Every field is optional by contract. */
interface ManifestComponent {
  version?: unknown
  sha256?: unknown
  size?: unknown
  path?: unknown
  hash?: unknown
  source?: unknown
}

interface RuntimeAssetsManifest {
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

interface OverlayFile {
  path: string
  content: string
}

interface RuntimeAssetsState {
  cli_sha256?: string
  cli_size?: number
  cli_mtime_ms?: number
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
  /** Last opencode version this box converged to. Diagnostic only. */
  opencode_version?: string
}

/**
 * Byte-for-byte the API's `managedSkillOverlayHash`. Recomputed here so a
 * truncated or tampered response is rejected instead of overwriting a working
 * overlay with a partial one — the payload arrives over HTTP and its length is
 * not otherwise checked.
 */
export function overlayHash(files: OverlayFile[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(`file\0${file.path}\0${Buffer.byteLength(file.content)}\0`)
    hash.update(file.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * Is this a path the overlay may write?
 *
 * The response comes from the API over TLS, so this is defense in depth rather
 * than the only guard — but a write loop that takes a server-supplied path and
 * has no such check is one compromised response away from writing anywhere the
 * daemon can reach, and the daemon is root.
 */
export function isSafeOverlayPath(path: string): boolean {
  if (!path || path.startsWith('/') || path.startsWith('-')) return false
  if (!path.startsWith('kortix-')) return false
  return path
    .split('/')
    .every((seg) => seg.length > 0 && seg !== '.' && seg !== '..' && /^[\w .-]+$/.test(seg))
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  hash.update(await readFile(path))
  return hash.digest('hex')
}

async function readState(path: string): Promise<RuntimeAssetsState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RuntimeAssetsState
  } catch {
    return {}
  }
}

async function writeState(path: string, state: RuntimeAssetsState): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(state)}\n`, 'utf8')
  } catch (err) {
    // The cache is an optimization. Losing it costs one re-hash, not correctness.
    logger.warn('[runtime-assets] could not persist digest state', { err: String(err) })
  }
}

interface LocalDigest {
  sha: string
  size: number
  mtimeMs: number
}

/**
 * A file's sha256, preferring a cached value when the file is provably
 * unchanged (same size AND same mtime).
 *
 * Hashing is not free at these sizes — the CLI is ~104 MB and the daemon ~96 MB
 * — and this runs on every session start, so a converged box must not pay for
 * two full reads to learn that nothing changed. The manifest is always trusted
 * over the cache: the cache only ever answers "what is on disk", never "what
 * should be".
 */
async function localDigest(path: string, cached: Partial<LocalDigest>): Promise<LocalDigest | null> {
  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(path)
  } catch {
    return null
  }
  if (!stats.isFile()) return null
  const mtimeMs = Math.trunc(stats.mtimeMs)
  if (cached.sha && cached.size === stats.size && cached.mtimeMs === mtimeMs) {
    return { sha: cached.sha, size: stats.size, mtimeMs }
  }
  return { sha: await fileSha256(path), size: stats.size, mtimeMs }
}

async function localCliSha(cliPath: string, state: RuntimeAssetsState): Promise<LocalDigest | null> {
  return localDigest(cliPath, {
    sha: state.cli_sha256,
    size: state.cli_size,
    mtimeMs: state.cli_mtime_ms,
  })
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
function verifyArtifact(bytes: Buffer, expectedSha: string): boolean {
  return createHash('sha256').update(bytes).digest('hex') === expectedSha
}

// ── Manifest reading ───────────────────────────────────────────────────────
// Every read below is total: a field that is missing, null, or the wrong type
// answers "not stated" instead of throwing. A daemon that crashes on a manifest
// shape it does not recognize is a daemon that cannot be rolled forward.

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function manifestComponent(
  manifest: RuntimeAssetsManifest,
  name: 'agent' | 'cli' | 'opencode' | 'managed-skills',
): ManifestComponent | null {
  const components = manifest.components
  if (!components || typeof components !== 'object' || Array.isArray(components)) return null
  const entry = (components as Record<string, unknown>)[name]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  return entry as ManifestComponent
}

/** True once the API speaks v2 at all — i.e. it stated a `components` map. */
function isV2Manifest(manifest: RuntimeAssetsManifest): boolean {
  const components = manifest.components
  return Boolean(components && typeof components === 'object' && !Array.isArray(components))
}

function manifestBuild(manifest: RuntimeAssetsManifest): number | undefined {
  const build = manifest.build
  return typeof build === 'number' && Number.isFinite(build) ? build : undefined
}

/**
 * The kill switch. `false` — and only an explicit `false` — stops agent
 * self-update fleet-wide.
 *
 * It has to be centrally flippable precisely because the thing it governs is
 * the component that might no longer boot: shipping a new daemon to stop a bad
 * daemon rollout assumes the daemon still works.
 */
function agentSelfUpdateAllowed(manifest: RuntimeAssetsManifest): boolean {
  const policy = manifest.policy
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return true
  return (policy as Record<string, unknown>).agent_self_update !== false
}

/**
 * Turn a manifest-supplied artifact path into a URL on the API we are already
 * talking to.
 *
 * The path is server-supplied and decides what this root process downloads and
 * stages, so it may name a PATH on this API and nothing else. An absolute URL,
 * a protocol-relative `//host/…`, or anything with whitespace is refused and
 * the built-in route is used instead — the manifest can never redirect a
 * sandbox to another host.
 */
function resolveArtifactUrl(apiRoot: string, path: unknown, fallback: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return fallback
  if (/\s/.test(path) || path.includes('://')) return fallback
  const origin = apiRoot.replace(/\/v1$/, '')
  return `${origin}${path}`
}

async function replaceCli(
  cliPath: string,
  expectedSha: string,
  body: ArrayBuffer,
): Promise<'updated' | 'failed'> {
  // Same directory as the target: `rename` is only atomic within one filesystem,
  // and a cross-device temp file would fail with EXDEV.
  const tmpPath = join(
    dirname(cliPath),
    `.kortix.download.${process.pid}.${Math.random().toString(36).slice(2, 10)}`,
  )
  try {
    // Buffered, not streamed. `Bun.write(path, response)` hangs on a streamed
    // Response in this runtime (a known incident in this repo), and a
    // hash-while-streaming pipeline is more machinery than the numbers justify:
    // the binary is ~100 MB on a sandbox with at least 4 GB, the buffer is
    // transient, and the reconcile runs at most once per session start.
    const bytes = Buffer.from(body)
    await writeFile(tmpPath, bytes)
    if (!verifyArtifact(bytes, expectedSha)) {
      logger.warn('[runtime-assets] CLI download digest mismatch — keeping the installed binary', {
        expected: expectedSha,
      })
      return 'failed'
    }
    await chmod(tmpPath, 0o755)
    // Atomic on Linux: a `kortix` already running keeps its open inode, and no
    // caller can ever observe a half-written binary at this path.
    await rename(tmpPath, cliPath)
    return 'updated'
  } catch (err) {
    logger.warn('[runtime-assets] CLI replace failed', { err: String(err) })
    return 'failed'
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {})
  }
}

// ── Agent staging ──────────────────────────────────────────────────────────

function agentStateDirOf(options: RuntimeAssetsOptions): string {
  return options.agentStateDir ?? process.env.KORTIX_AGENT_STATE_DIR ?? DEFAULT_AGENT_STATE_DIR
}

function agentBakedPathOf(options: RuntimeAssetsOptions): string {
  return options.agentBakedPath ?? process.env.KORTIX_AGENT_BIN ?? DEFAULT_AGENT_BAKED_PATH
}

/**
 * Is this process a `bun --compile` standalone binary, or `bun some/file.ts`?
 *
 * A standalone build runs its entry from Bun's embedded filesystem, so
 * `process.argv[1]` is a `/$bunfs/` path. In dev and under `bun test` it is a
 * real source path. The distinction matters because `process.execPath` is the
 * daemon binary in the first case and the BUN RUNTIME in the second — hashing
 * the latter would compare the wrong file entirely.
 */
function isCompiledStandalone(): boolean {
  return typeof process.argv[1] === 'string' && process.argv[1].startsWith('/$bunfs/')
}

/**
 * Which file is this daemon actually running from?
 *
 * `process.execPath` is the truthful answer for a compiled binary: it is the
 * real path of the executable and it follows a rename or a copy (verified
 * 2026-08-20 by renaming a `bun --compile` output and re-reading it inside the
 * process). Falling back, we use the supervisor's own rule from
 * `select_agent()` in apps/sandbox/entrypoint.sh: `agent.current` when it is
 * present, the baked floor otherwise.
 *
 * Getting this wrong has one specific, expensive consequence. An already-
 * updated box runs `agent.current`; hashing the baked floor there would compare
 * the wrong file, find a permanent mismatch, and re-download ~96 MB on every
 * single start — for ever.
 */
async function resolveRunningAgentPath(options: RuntimeAssetsOptions): Promise<string> {
  if (options.runningAgentPath) return options.runningAgentPath
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
  body: ArrayBuffer,
): Promise<'staged' | 'failed'> {
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
    const bytes = Buffer.from(body)
    await writeFile(tmpPath, bytes)
    if (!verifyArtifact(bytes, expectedSha)) {
      logger.warn('[runtime-assets] agent download digest mismatch — nothing staged', {
        expected: expectedSha,
      })
      return 'failed'
    }
    await chmod(tmpPath, 0o755)
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

async function stagedAgentSha(stateDir: string): Promise<string | null> {
  try {
    const raw = await readFile(join(stateDir, 'agent.next.sha256'), 'utf8')
    const sha = raw.trim()
    return /^[0-9a-f]{64}$/.test(sha) ? sha : null
  } catch {
    return null
  }
}

/** The supervisor's rollback latch: a previous update crash-looped this box. */
async function agentUpdatesPinned(stateDir: string): Promise<boolean> {
  return stat(join(stateDir, 'agent.pinned')).then(
    () => true,
    () => false,
  )
}

async function writeOverlay(dir: string, files: OverlayFile[]): Promise<void> {
  // Stage into a sibling temp dir, then swap. A partial write into the live dir
  // would leave the overlay half-old/half-new for whatever boots next.
  await mkdir(dirname(dir), { recursive: true })
  const staging = await mkdtemp(`${dir}.staging-`)
  try {
    for (const file of files) {
      if (!isSafeOverlayPath(file.path)) {
        logger.warn('[runtime-assets] rejected unsafe overlay path', { path: file.path })
        continue
      }
      const dest = join(staging, file.path)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, file.content, 'utf8')
    }
    const retired = `${dir}.retired-${process.pid}`
    await rename(dir, retired).catch(() => {})
    await rename(staging, dir)
    await rm(retired, { recursive: true, force: true }).catch(() => {})
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

// ── opencode ───────────────────────────────────────────────────────────────

/**
 * A version string that is safe to hand to a package manager.
 *
 * The value comes off the manifest and becomes an ARGUMENT of an install
 * command run as the sandbox user. `execFile` (no shell) is the primary
 * control; this allowlist is the second, so a malformed or hostile value is
 * refused loudly instead of being executed at all.
 */
const OPENCODE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/

const OPENCODE_PLUGIN_PACKAGE = '@opencode-ai/plugin'

/** The version opencode itself reports. `null` when it cannot be read — which
 *  is NOT the same as "mismatched", and never converges anything. */
async function readOpencodeVersion(baseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${baseUrl}/global/health`, {
      signal: AbortSignal.timeout(OPENCODE_HEALTH_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    return optionalString(body?.version) ?? null
  } catch {
    return null
  }
}

/**
 * Install one exact opencode version, exactly the way the image does.
 *
 * `pnpm add -g --allow-build=opencode-ai` is not a stylistic choice — it is the
 * command in `dockerfile-layer.ts`, and the point of convergence is that a box
 * that updates itself ends up byte-identical to a box built fresh. A different
 * installer here would produce a second, subtly different runtime that only
 * ever exists on updated boxes, which is the hardest kind of drift to debug.
 */
export interface InstallOpencodeVersionOptions {
  installPackage?: (version: string) => Promise<void>
  capture?: CaptureCommand
  currentLinkPath?: string
}

export async function installOpencodeVersion(
  version: string,
  options: InstallOpencodeVersionOptions = {},
): Promise<void> {
  const installPackage = options.installPackage ?? (async (targetVersion: string) => {
    await execFileAsync(
      'pnpm',
      ['add', '-g', '--allow-build=opencode-ai', `opencode-ai@${targetVersion}`],
      { timeout: OPENCODE_INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    )
  })
  const capture = options.capture ?? captureProcessOutput

  await installPackage(version)
  const nativePath = await resolveInstalledOpencodeNative(capture)
  const reportedVersion = (await capture(nativePath, ['--version'])).trim()
  if (reportedVersion !== version) {
    throw new Error(
      `installed OpenCode native version mismatch: expected ${version}, got ${reportedVersion || '<empty>'}`,
    )
  }
  await publishOpencodeNativeLink(
    nativePath,
    options.currentLinkPath ?? OPENCODE_CURRENT_LINK,
  )
}

async function installPluginDeps(dir: string): Promise<void> {
  await execFileAsync('bun', ['install'], {
    cwd: dir,
    timeout: OPENCODE_INSTALL_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  })
}

/**
 * The `@opencode-ai/plugin` pin that must track the opencode BINARY version.
 *
 * opencode loads the plugin SDK matching its own binary and fetches it over the
 * network when it is absent — on every boot. That is the multi-second
 * `opencode-session-created` stall documented in
 * `packages/shared/src/sandbox/dockerfile-layer.ts`, and it is why a version
 * bump that moves the binary without the pin is worse than not bumping at all.
 *
 * Only the BAKED dependency dir is rewritten. The project's own config-dir
 * `package.json` is a tracked file in the user's repository; convergence
 * writing into a working tree would dirty it and show up as an unexplained
 * local change in their next `git status`.
 */
async function readPluginPin(depsDir: string): Promise<string | null> {
  try {
    const pkg = JSON.parse(await readFile(join(depsDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>
    }
    return optionalString(pkg?.dependencies?.[OPENCODE_PLUGIN_PACKAGE]) ?? null
  } catch {
    return null
  }
}

export async function refreshOpencodePluginPin(
  depsDir: string,
  version: string,
): Promise<'updated' | 'current' | 'absent' | 'failed'> {
  const pkgPath = join(depsDir, 'package.json')
  let pkg: { dependencies?: Record<string, unknown> }
  try {
    pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { dependencies?: Record<string, unknown> }
  } catch {
    // No baked dependency dir on this image (self-host, an old snapshot). The
    // binary still converges; opencode just pays its own plugin fetch.
    return 'absent'
  }
  if (!pkg.dependencies || typeof pkg.dependencies[OPENCODE_PLUGIN_PACKAGE] !== 'string') {
    return 'absent'
  }
  if (pkg.dependencies[OPENCODE_PLUGIN_PACKAGE] === version) return 'current'
  pkg.dependencies[OPENCODE_PLUGIN_PACKAGE] = version
  const tmpPath = `${pkgPath}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`
  try {
    await writeFile(tmpPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')
    await rename(tmpPath, pkgPath)
    return 'updated'
  } catch (err) {
    logger.warn('[runtime-assets] could not rewrite the opencode plugin pin', {
      depsDir,
      err: String(err),
    })
    return 'failed'
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {})
  }
}

async function fetchJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  timeoutMs: number,
): Promise<T | null> {
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    logger.warn('[runtime-assets] non-ok response', { url, status: res.status })
    return null
  }
  return (await res.json()) as T
}

/**
 * One reconcile pass. Returns what happened for each half so callers (and tests)
 * can assert on it. NEVER throws.
 */
export async function reconcileRuntimeAssets(
  options: RuntimeAssetsOptions = {},
): Promise<RuntimeAssetsResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const cliPath = options.cliPath ?? DEFAULT_CLI_PATH
  const skillsDir = options.managedSkillsDir ?? DEFAULT_MANAGED_SKILLS_DIR
  const statePath = options.statePath ?? DEFAULT_STATE_PATH
  const inject =
    options.injectSkills ??
    ((configDir: string, bakedDir: string) => ensureInjectedManagedSkills(configDir, { bakedDir }))
  const token = (
    options.token ??
    process.env.KORTIX_CLI_TOKEN ??
    process.env.KORTIX_SANDBOX_TOKEN ??
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
      const local = await localCliSha(cliPath, state)
      if (local && local.sha === cliSha) {
        cli = 'current'
        nextState.cli_sha256 = local.sha
        nextState.cli_size = local.size
        nextState.cli_mtime_ms = local.mtimeMs
      } else {
        const res = await fetchImpl(resolveArtifactUrl(apiRoot, cliComponent?.path, `${base}/cli`), {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        })
        if (!res.ok) {
          logger.warn('[runtime-assets] CLI download non-ok', { status: res.status })
          cli = 'failed'
        } else {
          cli = await replaceCli(cliPath, cliSha, await res.arrayBuffer())
          if (cli === 'updated') {
            const stats = await stat(cliPath).catch(() => null)
            nextState.cli_sha256 = cliSha
            nextState.cli_size = stats?.size
            nextState.cli_mtime_ms = stats ? Math.trunc(stats.mtimeMs) : undefined
            logger.info('[runtime-assets] kortix CLI updated from the API', {
              version: cliVersion,
              sha256: cliSha.slice(0, 12),
            })
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
          await writeOverlay(skillsDir, payload.files)
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

  // Re-apply the overlay into the live config dir whenever the bodies changed —
  // the boot-time injection already ran, so nothing else would pick this up.
  if (skills === 'updated' && options.configDir) {
    await inject(options.configDir, skillsDir).catch((err) =>
      logger.warn('[runtime-assets] overlay re-injection failed', { err: String(err) }),
    )
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
          const res = await fetchImpl(
            resolveArtifactUrl(apiRoot, component?.path, `${base}/agent`),
            {
              headers: { Authorization: `Bearer ${token}` },
              signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            },
          )
          if (!res.ok) {
            logger.warn('[runtime-assets] agent download non-ok', { status: res.status })
            agent = 'failed'
            reasons.agent = `agent download returned ${res.status}`
          } else {
            agent = await stageAgentBinary(stateDir, expectedSha, await res.arrayBuffer())
            if (agent === 'staged') {
              agentSwapPending = true
              nextState.staged_agent_sha256 = expectedSha
              logger.info('[runtime-assets] agent staged for the supervisor to install', {
                version: optionalString(component?.version),
                sha256: expectedSha.slice(0, 12),
                runningSha256: running?.sha.slice(0, 12) ?? null,
              })
            } else {
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

  // ── opencode — IDLE ONLY ───────────────────────────────────────────────────
  // Installing opencode replaces the binary the live model call is running in,
  // and applying it needs a restart. Both sever a turn in flight, so this half
  // only ever acts when the daemon's own turn oracle says the box is idle.
  // "Cannot tell" is treated as busy; a skipped pass costs nothing, because the
  // next start reconciles again.
  let opencode: ReconcileOutcome | undefined
  if (v2) {
    opencode = 'skipped'
    try {
      const component = manifestComponent(manifest, 'opencode')
      const expected = optionalString(component?.version)
      const seam = options.seam
      const depsDir = options.opencodeDepsDir ?? OPENCODE_CONFIG_DEPS_DIR
      if (!expected) {
        reasons.opencode = 'manifest states no opencode version'
      } else if (!OPENCODE_VERSION.test(expected)) {
        // Refused, not sanitized: this value becomes an install argument.
        logger.warn('[runtime-assets] refusing a malformed opencode version', { expected })
        reasons.opencode = 'manifest opencode version is malformed'
      } else if (!seam) {
        // No live runtime in this process (monitor mode, a test, a pass fired
        // before opencode exists). Nothing to read a version from.
        reasons.opencode = 'no opencode runtime in this process'
      } else {
        const readVersion = options.readOpencodeVersion ?? readOpencodeVersion
        const installed = await readVersion(seam.opencodeBaseUrl())
        const pin = await readPluginPin(depsDir)
        const binaryStale = installed !== null && installed !== expected
        // The pin can drift from the binary on its own — a pass that installed
        // the binary and then failed the pin refresh leaves exactly that — and
        // a pin that does not match makes opencode refetch the plugin on every
        // boot. It is worth one idle-only repair even when the binary is fine.
        const pinStale = pin !== null && pin !== expected
        if (installed === null) {
          reasons.opencode = 'opencode did not report its version'
        } else if (!binaryStale && !pinStale) {
          opencode = 'current'
          nextState.opencode_version = installed
        } else {
          const probe = options.turnProbe ?? opencodeTurnInFlight
          const turnInFlight = await probe(seam.opencodeBaseUrl(), seam.workspace)
          if (turnInFlight !== false) {
            reasons.opencode =
              turnInFlight === null ? 'turn state unreadable' : 'a turn is in flight'
            logger.info('[runtime-assets] opencode convergence deferred — box is busy', {
              installed,
              expected,
              turnInFlight,
            })
          } else {
            const install = options.installOpencode ?? installOpencodeVersion
            if (binaryStale) await install(expected)
            // SAME STEP as the binary, always. A binary and a plugin that
            // disagree is the state this whole block exists to avoid.
            const pinResult = await refreshOpencodePluginPin(depsDir, expected)
            if (pinResult === 'updated') {
              await (options.installPluginDeps ?? installPluginDeps)(depsDir)
            }
            // Only a NEW BINARY needs the process replaced: the plugin is read
            // when opencode boots, so a refreshed pin takes effect on its own at
            // the next start and buys nothing by cutting this one short.
            if (binaryStale) await seam.restartOpencode()
            opencode = 'updated'
            nextState.opencode_version = expected
            logger.info('[runtime-assets] opencode converged', {
              from: installed,
              to: expected,
              pin: pinResult,
              restarted: binaryStale,
            })
          }
        }
      }
    } catch (err) {
      logger.warn('[runtime-assets] opencode reconcile failed', { err: String(err) })
      opencode = 'failed'
      reasons.opencode = String(err)
    }
  }

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
  if (opencode !== undefined) result.opencode = opencode
  if (build !== undefined) result.build = build
  if (agentSwapPending) result.agentSwapPending = true
  if (Object.keys(reasons).length > 0) result.reasons = reasons
  return result
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

/** Test seam: drop every registered blocker. */
export function resetAgentSwapBlockersForTests(): void {
  swapBlockers.clear()
}

interface RuntimeConvergenceConfig {
  seam: RuntimeConvergenceSeam
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
 * runtime to converge opencode against.
 */
let swapConfig: RuntimeConvergenceConfig | null = null

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
  /** Override the settle window. Tests only. */
  minUptimeMs?: number
}

/**
 * Ask the supervisor to install the staged daemon — but only if nothing is
 * mid-flight that the restart would destroy.
 *
 * THE SAFETY RULE, stated once: this process exiting takes opencode, the
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

    const uptimeMs = options.uptimeMs ?? process.uptime() * 1000
    if (uptimeMs < (options.minUptimeMs ?? AGENT_SWAP_MIN_UPTIME_MS)) return 'too-young'

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
 * Single-flight guard for the detached entry point below. Boot readiness and a
 * `POST /kortix/refresh` can land within milliseconds of each other; without
 * this they would both download a ~100 MB binary and race to rename over it.
 */
let inFlight: Promise<RuntimeAssetsResult> | null = null

/**
 * Fire-and-forget entry point for the boot/refresh/adopt call sites. Returns
 * immediately; the pass runs detached and swallows everything.
 */
export function ensureLatestKortixAssets(configDir?: string): void {
  if (inFlight) return
  inFlight = reconcileRuntimeAssets({ configDir, seam: swapConfig?.seam })
  void inFlight
    .finally(() => {
      inFlight = null
    })
    .then(async (result) => {
      // Record BEFORE the swap request below: `requestAgentSwapIfIdle` can exit
      // the process, and a pass that converged but never got reported would
      // make the box look like it had not run at all.
      noteRuntimeConvergence(result)
      if (result.cli === 'updated' || result.skills === 'updated' || result.opencode === 'updated') {
        logger.info('[runtime-assets] reconcile complete', result)
      } else {
        logger.info('[runtime-assets] reconcile no-op', result)
      }
      // Asked at most once per pass, and only when a verified binary is
      // actually waiting. A busy box simply keeps the staging: the supervisor
      // installs it at the next start.
      if (result.agentSwapPending) {
        const decision = await requestAgentSwapIfIdle()
        if (decision !== 'exited') {
          logger.info('[runtime-assets] agent update staged; swap deferred', { decision })
        }
      }
    })
    .catch((err) => logger.warn('[runtime-assets] reconcile threw', { err: String(err) }))
}

/**
 * The call-site form: resolve the session's live opencode config dir, then run a
 * detached pass. Returns synchronously — nothing here is ever on a readiness or
 * request-latency path.
 */
export function scheduleRuntimeAssetsReconcile(cfg: Config): void {
  void resolveOpencodeConfigDir(cfg)
    .then((configDir) => ensureLatestKortixAssets(configDir))
    // A config dir we cannot resolve costs the overlay re-injection, not the
    // CLI update — still worth running.
    .catch(() => ensureLatestKortixAssets())
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
}

let lastConvergence: RuntimeConvergenceReport = {
  build: null,
  at: null,
  components: {},
  agentSwapPending: false,
  pinned: false,
}

/** Record a completed pass. Never throws — this is reporting, not control. */
export function noteRuntimeConvergence(result: RuntimeAssetsResult): void {
  const components: Partial<Record<RuntimeComponent, ReconcileOutcome>> = {
    cli: result.cli,
    skills: result.skills,
  }
  if (result.agent) components.agent = result.agent
  if (result.opencode) components.opencode = result.opencode
  lastConvergence = {
    build: result.build ?? lastConvergence.build,
    at: new Date().toISOString(),
    components,
    ...(result.reasons ? { reasons: result.reasons } : {}),
    agentSwapPending: result.agentSwapPending === true,
    pinned: lastConvergence.pinned,
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
): Promise<RuntimeConvergenceReport> {
  return { ...lastConvergence, pinned: await agentUpdatesPinned(stateDir) }
}

export function resetRuntimeConvergenceReportForTests(): void {
  lastConvergence = { build: null, at: null, components: {}, agentSwapPending: false, pinned: false }
}
