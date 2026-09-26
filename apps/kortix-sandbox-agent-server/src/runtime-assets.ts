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
import type { Config } from './config'
import { resolveHarness, type HarnessAssetsCompatibilityResult } from './harness/harness'
import type {
  HarnessAssetOutcome,
  HarnessAssetsService,
} from './harness/assets'
import { logger } from './logger'
import { withReleaseStoreLock } from './boot-config'

/**
 * What the convergence pass is doing RIGHT NOW, for the proxy's not-ready
 * answers (X-Kortix-Boot-Phase). A pass that installs a new OpenCode pin can
 * hold a box in "not ready" for a minute or more (SampleCo 2026-08-25:
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

/**
 * `staged` is agent-only: the bytes are verified and on disk, and the swap
 * happens in the supervisor at the next start — nothing has been replaced yet.
 */
export type ReconcileOutcome = HarnessAssetOutcome

/** The components a v2 manifest can describe. */
export type RuntimeComponent = 'cli' | 'skills' | 'agent' | (string & {})

export interface RuntimeAssetsResult extends HarnessAssetsCompatibilityResult {
  cli: ReconcileOutcome
  skills: ReconcileOutcome
  /**
   * Agent and harness components are OMITTED for a v1 manifest, not reported
   * as `skipped`. A manifest that predates `components` says nothing at all about
   * them, and "we did not converge it" and "we were never told what it should
   * be" are different facts. It also keeps every existing caller's shape.
   */
  agent?: ReconcileOutcome
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

const defaultExecProbe: ExecProbe = async (path, args) => {
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
  /**
   * Written by the harness half through `Object.assign(nextState,
   * harnessResult.state)` — declared here because `runningRuntimeAssets` reads
   * it back, and an undeclared key that something reads is a key that gets
   * renamed by accident.
   */
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
function isSafeOverlayPath(path: string): boolean {
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
  name: 'agent' | 'cli' | 'managed-skills',
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

/**
 * Give the daemon write access to the directory that holds the CLI.
 *
 * The shipped image now bakes this (platform-binaries.ts
 * SANDBOX_CLI_OWNERSHIP_COMMAND), but a box already running an older snapshot
 * cannot wait for a rebuild, and it is exactly the box whose CLI has drifted
 * from the manifest. The image grants `kortix` NOPASSWD:ALL sudo, so one
 * non-interactive `chown` converges the live box to the state the new image
 * bakes. `-n` means a box WITHOUT that sudo rule fails immediately instead of
 * hanging on a password prompt.
 */
async function sudoOwnDir(dir: string): Promise<boolean> {
  try {
    const uid = process.getuid?.() ?? 0
    const gid = process.getgid?.() ?? 0
    const proc = Bun.spawn(['sudo', '-n', 'chown', `${uid}:${gid}`, dir], {
      stdout: 'ignore',
      stderr: 'ignore',
      stdin: 'ignore',
    })
    return (await proc.exited) === 0
  } catch {
    return false
  }
}

export interface ReplaceCliDeps {
  /** Seam for the escalation. Returns true when it believes it changed something. */
  unlockDir?: (dir: string) => Promise<boolean>
  /** Seam for observing the first failure's reason. */
  onUnlockAttempt?: (reason: string) => void
  /**
   * Runs the candidate before it replaces a working binary. See {@link ExecProbe}.
   *
   * Optional and defaulted to the REAL spawn on purpose: a caller that forgets
   * it still gets the proof, and a test that wants a different answer has to say
   * so out loud.
   */
  execProbe?: ExecProbe
}

/**
 * Install a verified CLI binary at `cliPath`.
 *
 * Three properties, in this order, and each one is load-bearing:
 *
 *  1. VERIFY BEFORE TOUCHING THE FILESYSTEM. A digest mismatch must not even
 *     create a temp file, and it must never be reported through the same path
 *     as a permission failure.
 *  2. RUN THE CANDIDATE BEFORE THE RENAME. The binary is executed from the temp
 *     path, so a wrong-arch or truncated artifact never reaches
 *     `/usr/local/bin/kortix` and the box keeps the CLI it had.
 *  3. UNLOCK THE DIRECTORY ONCE AND RETRY. The temp-file create and the rename
 *     both draw their permission from the DIRECTORY, which is root-owned on an
 *     older snapshot while the daemon runs as `kortix`.
 *
 * A failed probe is NOT escalated. The temp file was already created and
 * chmod'd by then, so the directory was writable; unlocking it again cannot
 * make a binary that does not execute execute.
 *
 * Exported for `runtime-assets-cli-replace.test.ts`, which drives it against a
 * REAL unwritable directory — the permission failure this function has to
 * survive is a property of the filesystem, not of a mock.
 */
export async function replaceCli(
  cliPath: string,
  expectedSha: string,
  body: ArrayBuffer,
  deps: ReplaceCliDeps = {},
): Promise<'updated' | 'failed' | 'unrunnable'> {
  // Buffered, not streamed. `Bun.write(path, response)` hangs on a streamed
  // Response in this runtime (a known incident in this repo), and a
  // hash-while-streaming pipeline is more machinery than the numbers justify:
  // the binary is ~100 MB on a sandbox with at least 4 GB, the buffer is
  // transient, and the reconcile runs at most once per session start.
  const bytes = Buffer.from(body)
  // Verify BEFORE touching the filesystem: a digest mismatch must not even
  // create a temp file, and it must not be mistaken for a permission problem.
  if (!verifyArtifact(bytes, expectedSha)) {
    logger.warn('[runtime-assets] CLI download digest mismatch — keeping the installed binary', {
      expected: expectedSha,
    })
    return 'failed'
  }

  const probe = deps.execProbe ?? defaultExecProbe
  const dir = dirname(cliPath)
  const attempt = async (): Promise<'updated' | 'unrunnable' | string> => {
    // Same directory as the target: `rename` is only atomic within one
    // filesystem, and a cross-device temp file would fail with EXDEV.
    const tmpPath = join(
      dir,
      `.kortix.download.${process.pid}.${Math.random().toString(36).slice(2, 10)}`,
    )
    try {
      await writeFile(tmpPath, bytes)
      await chmod(tmpPath, 0o755)
      // RUN IT FIRST. See {@link ExecProbe} for why this is an exit code and
      // not a version-string comparison.
      const code = await probe(tmpPath, ['--version'])
      if (code !== 0) {
        logger.warn('[runtime-assets] CLI candidate did not run — keeping the installed binary', {
          exitCode: code,
          expected: expectedSha.slice(0, 12),
        })
        return 'unrunnable'
      }
      // Atomic on Linux: a `kortix` already running keeps its open inode, and no
      // caller can ever observe a half-written binary at this path.
      await rename(tmpPath, cliPath)
      return 'updated'
    } catch (err) {
      return String(err)
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {})
    }
  }

  const first = await attempt()
  if (first === 'updated') return 'updated'
  // The candidate reached the probe, so the directory was writable. Escalating
  // would unlock a directory that is not the problem and then run the same
  // unrunnable binary a second time.
  if (first === 'unrunnable') return 'unrunnable'
  deps.onUnlockAttempt?.(first)

  // Both the temp-file create and the rename draw their permission from the
  // DIRECTORY, so this is the only failure worth escalating for. Exactly one
  // retry: if unlocking did not actually help, retrying again never will.
  const unlock = deps.unlockDir ?? sudoOwnDir
  if (!(await unlock(dir))) {
    logger.warn('[runtime-assets] CLI replace failed and the directory could not be unlocked', {
      dir,
      err: first,
    })
    return 'failed'
  }
  const second = await attempt()
  if (second === 'updated') {
    logger.info('[runtime-assets] CLI replaced after unlocking its directory', { dir })
    return 'updated'
  }
  if (second === 'unrunnable') return 'unrunnable'
  logger.warn('[runtime-assets] CLI replace failed', { dir, err: second })
  return 'failed'
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
    const bytes = Buffer.from(body)
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
  const assets = options.assets ?? resolveHarness().assets
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
          const replaced = await replaceCli(cliPath, cliSha, await res.arrayBuffer(), {
            execProbe,
          })
          if (replaced === 'unrunnable') {
            cli = 'failed'
            reasons.cli = 'the downloaded CLI did not run on this box'
          } else {
            cli = replaced
          }
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
            const stagedOutcome = await stageAgentBinary(
              stateDir,
              expectedSha,
              await res.arrayBuffer(),
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
  Object.assign(result, harnessResult.components)
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
  inFlight = reconcileRuntimeAssets({ configDir, assets: swapConfig?.assets })
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
  void resolveHarness(cfg).assets.resolveConfigDir(cfg)
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
   * apps/api/src/runtime-assets/manifest.ts), and reporting a digest for
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
  opencode_version: string | null
  /** Highest manifest epoch this box has converged to, from DISK. */
  build: number | null
}

const NO_RUNNING_ASSETS: RunningRuntimeAssets = {
  cli_sha256: null,
  managed_skills_hash: null,
  agent_sha256: null,
  agent_path: null,
  staged_agent_sha256: null,
  opencode_version: null,
  build: null,
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
export async function runningRuntimeAssets(
  statePath: string = DEFAULT_STATE_PATH,
): Promise<RunningRuntimeAssets> {
  const state = (await readState(statePath)) as RuntimeAssetsState & Record<string, unknown>
  return {
    cli_sha256: str(state.cli_sha256),
    managed_skills_hash: str(state.managed_skills_hash),
    agent_sha256: str(state.agent_sha256),
    agent_path: str(state.agent_path),
    staged_agent_sha256: str(state.staged_agent_sha256),
    opencode_version: str(state.opencode_version),
    build: typeof state.build === 'number' && Number.isFinite(state.build) ? state.build : null,
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
  const assets = swapConfig?.assets ?? resolveHarness().assets
  for (const name of assets.componentNames) {
    const outcome = (result as unknown as Record<string, ReconcileOutcome | undefined>)[name]
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
      const assets = swapConfig?.assets ?? resolveHarness().assets
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
  return { ...lastConvergence, pinned: agentPinned || harnessLatched, running }
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
