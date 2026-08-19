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
import { resolveOpencodeConfigDir, type Config } from './config'
import { ensureInjectedManagedSkills } from './injected-skills'
import { logger } from './logger'

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

const MANIFEST_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 180_000

export type ReconcileOutcome = 'skipped' | 'current' | 'updated' | 'failed'

export interface RuntimeAssetsResult {
  cli: ReconcileOutcome
  skills: ReconcileOutcome
  /** Why, when either half is `skipped` or `failed`. Logged, never thrown. */
  reason?: string
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
}

interface RuntimeAssetsManifest {
  cli_version: string | null
  cli_sha256: string | null
  cli_size: number | null
  managed_skills_hash: string
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

/**
 * The CLI's sha256, preferring the cached value when the file is provably
 * unchanged (same size AND same mtime). The manifest is always trusted over the
 * cache: the cache only answers "what is on disk", never "what should be".
 */
async function localCliSha(cliPath: string, state: RuntimeAssetsState): Promise<{
  sha: string
  size: number
  mtimeMs: number
} | null> {
  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(cliPath)
  } catch {
    return null
  }
  if (!stats.isFile()) return null
  if (
    state.cli_sha256 &&
    state.cli_size === stats.size &&
    state.cli_mtime_ms === Math.trunc(stats.mtimeMs)
  ) {
    return { sha: state.cli_sha256, size: stats.size, mtimeMs: Math.trunc(stats.mtimeMs) }
  }
  return {
    sha: await fileSha256(cliPath),
    size: stats.size,
    mtimeMs: Math.trunc(stats.mtimeMs),
  }
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
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== expectedSha) {
      logger.warn('[runtime-assets] CLI download digest mismatch — keeping the installed binary', {
        expected: expectedSha,
        actual,
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
  // 'skipped' holds when a branch below never reassigns — e.g. a checkout that
  // never built the CLI (manifest.cli_sha256 null): nothing to converge on.
  let cli: ReconcileOutcome = 'skipped'
  let skills: ReconcileOutcome

  // ── CLI ────────────────────────────────────────────────────────────────────
  if (manifest.cli_sha256) {
    try {
      const local = await localCliSha(cliPath, state)
      if (local && local.sha === manifest.cli_sha256) {
        cli = 'current'
        nextState.cli_sha256 = local.sha
        nextState.cli_size = local.size
        nextState.cli_mtime_ms = local.mtimeMs
      } else {
        const res = await fetchImpl(`${base}/cli`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        })
        if (!res.ok) {
          logger.warn('[runtime-assets] CLI download non-ok', { status: res.status })
          cli = 'failed'
        } else {
          cli = await replaceCli(cliPath, manifest.cli_sha256, await res.arrayBuffer())
          if (cli === 'updated') {
            const stats = await stat(cliPath).catch(() => null)
            nextState.cli_sha256 = manifest.cli_sha256
            nextState.cli_size = stats?.size
            nextState.cli_mtime_ms = stats ? Math.trunc(stats.mtimeMs) : undefined
            logger.info('[runtime-assets] kortix CLI updated from the API', {
              version: manifest.cli_version,
              sha256: manifest.cli_sha256.slice(0, 12),
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
    const overlayPresent = await stat(skillsDir).then(
      (s) => s.isDirectory(),
      () => false,
    )
    if (overlayPresent && state.managed_skills_hash === manifest.managed_skills_hash) {
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
      } else if (overlayHash(payload.files) !== manifest.managed_skills_hash) {
        logger.warn('[runtime-assets] managed-skill payload digest mismatch — keeping the overlay', {
          expected: manifest.managed_skills_hash,
        })
        skills = 'failed'
      } else {
        await writeOverlay(skillsDir, payload.files)
        nextState.managed_skills_hash = manifest.managed_skills_hash
        skills = 'updated'
        logger.info('[runtime-assets] managed-skill overlay updated from the API', {
          files: payload.files.length,
          hash: manifest.managed_skills_hash.slice(0, 12),
        })
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

  await writeState(statePath, nextState)
  return { cli, skills }
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
  inFlight = reconcileRuntimeAssets({ configDir })
  void inFlight
    .finally(() => {
      inFlight = null
    })
    .then((result) => {
      if (result.cli === 'updated' || result.skills === 'updated') {
        logger.info('[runtime-assets] reconcile complete', result)
      } else {
        logger.info('[runtime-assets] reconcile no-op', result)
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
