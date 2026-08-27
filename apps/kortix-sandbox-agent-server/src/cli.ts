/**
 * kortixd — the management CLI baked into the daemon binary.
 *
 * The compiled binary is a single, normal, installable app. Its DEFAULT job is
 * to run the sandbox agent server (`kortixd` / `kortixd serve`), but it also
 * manages its own lifecycle on any machine: print its version, install itself
 * onto PATH, self-update to the current published build, and roll back the last
 * update. All of that lives here so `main.ts` keeps serving the daemon.
 *
 * THE RELIABILITY PROPERTY. A self-update never bricks the app. The flow is
 * download → verify content digest → smoke-test the new binary → atomic swap
 * (keeping the replaced binary as `<name>.prev`) → post-swap health-check →
 * auto-rollback to `.prev` on any failure. A half-written binary is never left
 * on disk: bytes are written to a temp file in the destination directory and
 * only `rename(2)`d into place after they pass every gate.
 *
 * THE BOOT CONTRACT. The primary caller is the sandbox boot path, which runs,
 * every start, idempotently: `kortixd install` → `kortixd update --boot` →
 * `kortixd serve`. So:
 *   - `install` is a fast no-op when the target already holds this exact binary.
 *   - `update` does the ~700 B manifest/digest check FIRST and exits 0 with no
 *     download when the local binary already matches the target.
 *   - `update --boot` is best-effort: any download/verify/health failure keeps
 *     the last-good binary and exits 0 so boot proceeds to `serve`. A manual
 *     `kortixd update` (no `--boot`) hard-fails non-zero instead.
 *
 * This module is intentionally decoupled from the server module graph so it
 * loads fast and is unit-testable without booting the daemon.
 */
import { createHash } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import pkg from '../package.json'

/** What the caller of {@link dispatchCli} must do next. */
export type CliOutcome =
  | { action: 'exit'; code: number }
  /** Not a management verb — boot the daemon server via `main()`. */
  | { action: 'serve' }

/** Management verbs this CLI owns. Everything else falls through to `serve`. */
const MANAGEMENT_VERBS = new Set([
  'version',
  '--version',
  '-v',
  'update',
  'rollback',
  'install',
  'help',
  '--help',
  '-h',
  '--health-check',
])

export function isManagementSubcommand(sub: string | undefined): boolean {
  return sub !== undefined && MANAGEMENT_VERBS.has(sub)
}

// ── small utilities ──────────────────────────────────────────────────────────

function out(line: string): void {
  process.stdout.write(`${line}\n`)
}
function err(line: string): void {
  process.stderr.write(`${line}\n`)
}

/** sha256 of a file's bytes, hex. Throws if the file is unreadable. */
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function sha256Bytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Parse `--flag value` / `--flag=value` / boolean `--flag` into a map. */
export function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]
    if (!tok || !tok.startsWith('--')) continue
    const eq = tok.indexOf('=')
    if (eq !== -1) {
      flags[tok.slice(2, eq)] = tok.slice(eq + 1)
      continue
    }
    const key = tok.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next
      i++
    } else {
      flags[key] = true
    }
  }
  return flags
}

// ── digest cache ─────────────────────────────────────────────────────────────
//
// Hashing a ~100 MB binary on every boot would add real latency, and the boot
// path calls `update` every start. Cache the running binary's digest keyed by
// {path,size,mtime} so a converged box answers "already current" without
// re-hashing. The key changes the instant the file changes, so a stale hit is
// impossible.

interface DigestCacheEntry {
  path: string
  size: number
  mtimeMs: number
  sha256: string
}

function defaultStatePath(binPath: string): string {
  const envPath = (process.env.KORTIXD_STATE_PATH ?? '').trim()
  if (envPath) return envPath
  return join(dirname(binPath), '.kortixd-state.json')
}

function cachedFileSha(binPath: string, statePath: string): string {
  let st: ReturnType<typeof statSync>
  try {
    st = statSync(binPath)
  } catch {
    throw new Error(`cannot stat binary at ${binPath}`)
  }
  const size = st.size
  const mtimeMs = Math.trunc(st.mtimeMs)
  try {
    const cache = JSON.parse(readFileSync(statePath, 'utf8')) as { current?: DigestCacheEntry }
    const e = cache.current
    if (
      e &&
      e.path === binPath &&
      e.size === size &&
      e.mtimeMs === mtimeMs &&
      /^[0-9a-f]{64}$/.test(e.sha256)
    ) {
      return e.sha256
    }
  } catch {
    /* no cache yet */
  }
  const sha = sha256File(binPath)
  writeDigestCache(statePath, { path: binPath, size, mtimeMs, sha256: sha })
  return sha
}

function writeDigestCache(statePath: string, entry: DigestCacheEntry): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true })
    writeFileSync(statePath, `${JSON.stringify({ current: entry })}\n`, 'utf8')
  } catch {
    /* the cache is an optimisation; a read-only fs just re-hashes next time */
  }
}

function invalidateDigestCache(statePath: string): void {
  try {
    rmSync(statePath, { force: true })
  } catch {
    /* best-effort */
  }
}

// ── version ──────────────────────────────────────────────────────────────────

/** The build digest is the running binary's own sha256 — the exact value the
 *  update path compares against a published manifest. Truthful and self-
 *  consistent: `version` and `update`'s no-op check read the same number. */
export function buildDigest(binPath: string): string {
  try {
    return sha256File(binPath)
  } catch {
    return 'unknown'
  }
}

function cmdVersion(binPath: string): number {
  const digest = buildDigest(binPath)
  const short = digest === 'unknown' ? 'unknown' : digest.slice(0, 12)
  out(`kortixd ${pkg.version} (${short})`)
  out(`  bun:      ${typeof Bun !== 'undefined' ? Bun.version : 'n/a'}`)
  out(`  platform: ${process.platform}/${process.arch}`)
  out(`  binary:   ${binPath}`)
  if (digest !== 'unknown') out(`  digest:   ${digest}`)
  return 0
}

// ── health-check ─────────────────────────────────────────────────────────────
//
// The smoke test the updater runs on a candidate binary, and a standalone
// liveness probe. It boots a self-contained HTTP server on an ephemeral port,
// answers /kortix/health, self-connects, and exits. It deliberately does NOT
// touch opencode, a workspace, or the network: the point is to prove the
// binary is a valid, runnable executable of the right architecture that can
// bind a socket and serve HTTP — not to boot a full session.

const HEALTH_PATH = '/kortix/health'

async function cmdHealthCheck(argv: string[]): Promise<number> {
  // Deliberate failure hook for tests: lets a REAL kortixd binary fail its own
  // smoke test so the auto-rollback path can be exercised end to end. Unset in
  // production.
  if ((process.env.KORTIXD_FORCE_HEALTHCHECK_FAIL ?? '') === '1') {
    err('health-check: forced failure (KORTIXD_FORCE_HEALTHCHECK_FAIL=1)')
    return 1
  }
  const flags = parseFlags(argv)
  const timeoutMs = Number(flags.timeout ?? 5000) || 5000
  let server: ReturnType<typeof Bun.serve> | null = null
  try {
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === HEALTH_PATH) {
          return new Response(
            JSON.stringify({ ok: true, service: 'kortixd', version: pkg.version }),
            { headers: { 'content-type': 'application/json' } },
          )
        }
        return new Response('not found', { status: 404 })
      },
    })
    const res = await fetch(`http://127.0.0.1:${server.port}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      err(`health-check: unexpected status ${res.status}`)
      return 1
    }
    const body = (await res.json()) as { ok?: boolean }
    if (body?.ok !== true) {
      err('health-check: body did not report ok')
      return 1
    }
    out('health-check ok')
    return 0
  } catch (e) {
    err(`health-check failed: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    server?.stop(true)
  }
}

// ── spawn helper (smoke-tests) ───────────────────────────────────────────────

export interface SpawnDeps {
  /** Run `bin args…`, resolve its exit code. Injected in tests. */
  run: (bin: string, args: string[], timeoutMs: number) => Promise<number>
}

function realRun(bin: string, args: string[], timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    let settled = false
    const child = nodeSpawn(bin, args, { stdio: 'ignore', env: process.env })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      resolve(124) // timeout
    }, timeoutMs)
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(126) // not executable / spawn error
    })
    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(signal ? 128 : code ?? 1)
    })
  })
}

const defaultSpawn: SpawnDeps = { run: realRun }

/** Smoke-test a candidate binary: `version` and `--health-check` must both
 *  exit 0 within their timeouts. Returns the failing gate, or null on pass. */
async function smokeTest(candidate: string, spawn: SpawnDeps): Promise<string | null> {
  const v = await spawn.run(candidate, ['version'], 15_000)
  if (v !== 0) return `\`version\` exited ${v}`
  const h = await spawn.run(candidate, ['--health-check'], 20_000)
  if (h !== 0) return `\`--health-check\` exited ${h}`
  return null
}

// ── install ──────────────────────────────────────────────────────────────────

/** Pick a writable standard install directory. Prefer /usr/local/bin (system),
 *  fall back to ~/.local/bin (user). */
function resolveInstallDir(explicit: string | undefined): string {
  if (explicit) return explicit
  const system = '/usr/local/bin'
  if (canWriteDir(system)) return system
  const user = join(homedir(), '.local', 'bin')
  return user
}

function canWriteDir(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.kortixd-write-probe-${process.pid}`)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

function atomicInstall(source: string, target: string): void {
  const dir = dirname(target)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `.kortixd.install.${process.pid}.${Math.random().toString(36).slice(2, 10)}`)
  try {
    copyFileSync(source, tmp)
    chmodSync(tmp, 0o755)
    renameSync(tmp, target)
  } finally {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* already renamed away */
    }
  }
}

function cmdInstall(binPath: string, argv: string[]): number {
  const flags = parseFlags(argv)
  const dir = resolveInstallDir(typeof flags.dir === 'string' ? flags.dir : undefined)
  const name = typeof flags.name === 'string' ? flags.name : 'kortixd'
  const force = flags.force === true
  const target = join(dir, name)
  const source = binPath

  if (source === target) {
    out(`kortixd already running from the install path: ${target}`)
    return 0
  }
  // Idempotency is PRESENCE-based, not digest-based, on purpose. The boot path
  // runs `install` every start with the image-baked binary as the source, then
  // `update` swaps a newer published binary into the SAME target. A digest-
  // equality check would see "target != source" on every post-update boot and
  // re-copy the OLDER baked binary over the newer one — undoing every update.
  // So a target that already exists is left untouched; `update` owns currency,
  // `install` only guarantees presence. `--force` overwrites deliberately.
  if (existsSync(target) && !force) {
    let note = ''
    try {
      note = sha256File(target) === sha256File(source) ? ' (matches this build)' : ' (a different build is present — likely from an update; --force to overwrite)'
    } catch {
      /* stat/hash failure is not fatal for a presence no-op */
    }
    out(`kortixd already installed at ${target}${note}`)
    return 0
  }
  try {
    atomicInstall(source, target)
  } catch (e) {
    err(`install failed: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
  out(`installed kortixd → ${target}`)
  if (dir !== '/usr/local/bin' && !process.env.PATH?.split(':').includes(dir)) {
    out(`note: add ${dir} to PATH to run \`kortixd\` directly`)
  }
  return 0
}

// ── update / rollback ────────────────────────────────────────────────────────

export interface ResolvedTarget {
  /** Expected content digest (sha256 hex) of the target build. */
  sha256: string
  /** Bytes of the target build, or null if not fetched yet (manifest-only). */
  bytes: Buffer | null
  /** URL to download the bytes from, when `bytes` is null. */
  downloadUrl?: string
  /** For logging. */
  version?: string
  source: 'manifest' | 'url' | 'file'
}

export interface UpdateOptions {
  /** The binary to update. Defaults to the running executable. */
  targetPath: string
  /** `--from <path|url>`: a local file or an explicit download URL. */
  from?: string
  channel?: string
  version?: string
  apiUrl?: string
  token?: string
  /** Boot / best-effort mode: never hard-fail, keep the last-good binary. */
  bestEffort: boolean
  statePath: string
  fetchImpl?: typeof fetch
  spawn?: SpawnDeps
  /** Test seam: resolve the target directly instead of hitting the network. */
  resolveTarget?: (opts: UpdateOptions) => Promise<ResolvedTarget>
}

export interface UpdateResult {
  /** 'current' = already up to date (no swap). 'updated' = swapped in a new
   *  binary. 'failed' = kept the last-good binary. */
  outcome: 'current' | 'updated' | 'failed'
  code: number
  message: string
}

const MANIFEST_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 180_000

function resolveApi(opts: UpdateOptions): { apiRoot: string; token: string } | null {
  const token = (
    opts.token ??
    process.env.KORTIX_CLI_TOKEN ??
    process.env.KORTIX_SANDBOX_TOKEN ??
    process.env.KORTIX_TOKEN ??
    ''
  ).trim()
  const rawApiUrl = (opts.apiUrl ?? process.env.KORTIX_API_URL ?? '').trim().replace(/\/+$/, '')
  if (!token || !rawApiUrl) return null
  const apiRoot = rawApiUrl.endsWith('/v1') ? rawApiUrl : `${rawApiUrl}/v1`
  return { apiRoot, token }
}

/** Only accept a manifest-supplied path that names a route on the SAME API
 *  origin — never an absolute URL to another host. Mirrors runtime-assets. */
function resolveArtifactUrl(apiRoot: string, path: unknown, fallback: string): string {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) return fallback
  if (/\s/.test(path) || path.includes('://')) return fallback
  const origin = apiRoot.replace(/\/v1$/, '')
  return `${origin}${path}`
}

async function defaultResolveTarget(opts: UpdateOptions): Promise<ResolvedTarget> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const from = opts.from?.trim()

  // 1) Explicit local file — the operator points us at a built binary.
  if (from && !/^https?:\/\//.test(from) && existsSync(from)) {
    const bytes = readFileSync(from)
    return { sha256: sha256Bytes(bytes), bytes, source: 'file', version: `file:${from}` }
  }
  // 2) Explicit URL — download; the bytes' own digest is the expectation.
  if (from && /^https?:\/\//.test(from)) {
    const res = await fetchImpl(from, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`download from ${from} returned ${res.status}`)
    const bytes = Buffer.from(await res.arrayBuffer())
    return { sha256: sha256Bytes(bytes), bytes, source: 'url', version: from }
  }
  // 3) Runtime-assets manifest — the boot path. Cheap: the manifest is ~700 B.
  const api = resolveApi(opts)
  if (!api) {
    throw new Error('no update source: pass --from <path|url>, or set KORTIX_API_URL + a token')
  }
  const base = `${api.apiRoot}/runtime-assets`
  const manRes = await fetchImpl(`${base}/manifest`, {
    headers: { Authorization: `Bearer ${api.token}` },
    signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
  })
  if (!manRes.ok) throw new Error(`manifest fetch returned ${manRes.status}`)
  const manifest = (await manRes.json()) as {
    components?: Record<string, { sha256?: unknown; version?: unknown; path?: unknown }>
    agent_sha256?: string
    policy?: { agent_self_update?: unknown }
  }
  if (manifest.policy && manifest.policy.agent_self_update === false) {
    throw new Error('agent self-update disabled by manifest policy')
  }
  const component = manifest.components?.agent
  const sha =
    (typeof component?.sha256 === 'string' ? component.sha256 : undefined) ??
    (typeof manifest.agent_sha256 === 'string' ? manifest.agent_sha256 : undefined)
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) {
    throw new Error('manifest states no agent digest to converge on')
  }
  const downloadUrl = resolveArtifactUrl(api.apiRoot, component?.path, `${base}/agent`)
  return {
    sha256: sha,
    bytes: null,
    downloadUrl,
    version: typeof component?.version === 'string' ? component.version : undefined,
    source: 'manifest',
  }
}

/**
 * The keystone: download → verify → smoke-test → atomic swap → post-swap
 * health → auto-rollback. Pure enough to unit-test with injected seams; the
 * real filesystem operations are synchronous and atomic.
 */
export async function performUpdate(opts: UpdateOptions): Promise<UpdateResult> {
  const spawn = opts.spawn ?? defaultSpawn
  const fetchImpl = opts.fetchImpl ?? fetch
  const target = opts.targetPath
  const prev = `${target}.prev`
  const dir = dirname(target)

  const fail = (message: string): UpdateResult => {
    err(`[update] ${message}`)
    if (opts.bestEffort) {
      err('[update] best-effort mode: keeping the last-good binary, boot may proceed')
      return { outcome: 'failed', code: 0, message }
    }
    return { outcome: 'failed', code: 1, message }
  }

  // Resolve what we should be running (cheap: manifest is tiny).
  let resolved: ResolvedTarget
  try {
    resolved = await (opts.resolveTarget ?? defaultResolveTarget)(opts)
  } catch (e) {
    return fail(`could not resolve update target: ${e instanceof Error ? e.message : String(e)}`)
  }

  // No-op check BEFORE downloading the big artifact.
  let currentSha: string
  try {
    currentSha = cachedFileSha(target, opts.statePath)
  } catch (e) {
    return fail(`cannot read current binary: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (currentSha === resolved.sha256) {
    out(`kortixd already current (${currentSha.slice(0, 12)})`)
    return { outcome: 'current', code: 0, message: 'already current' }
  }

  // Fetch the bytes if the resolver only gave us a URL + digest.
  let bytes = resolved.bytes
  if (!bytes) {
    if (!resolved.downloadUrl) return fail('resolver returned neither bytes nor a download URL')
    try {
      const api = resolveApi(opts)
      const headers = api ? { Authorization: `Bearer ${api.token}` } : undefined
      const res = await fetchImpl(resolved.downloadUrl, {
        headers,
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      })
      if (!res.ok) return fail(`download returned ${res.status}`)
      bytes = Buffer.from(await res.arrayBuffer())
    } catch (e) {
      return fail(`download failed: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // Verify content digest.
  const gotSha = sha256Bytes(bytes)
  if (gotSha !== resolved.sha256) {
    return fail(
      `digest mismatch: expected ${resolved.sha256.slice(0, 12)}, got ${gotSha.slice(0, 12)}`,
    )
  }

  // Write to a temp file in the destination dir (same fs → atomic rename).
  const tmp = join(dir, `.kortixd.download.${process.pid}.${Math.random().toString(36).slice(2, 10)}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tmp, bytes)
    chmodSync(tmp, 0o755)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
      /* nothing to clean */
    }
    return fail(`could not stage temp binary: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Smoke-test the candidate BEFORE it goes anywhere near the live path.
  const smokeFail = await smokeTest(tmp, spawn)
  if (smokeFail) {
    rmSync(tmp, { force: true })
    return fail(`candidate failed smoke test: ${smokeFail} — kept current binary`)
  }

  // Atomic swap. Keep exactly one previous version for fast rollback.
  try {
    copyFileSync(target, prev)
  } catch (e) {
    rmSync(tmp, { force: true })
    return fail(`could not preserve current binary as .prev: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    renameSync(tmp, target) // atomic within the same filesystem
  } catch (e) {
    rmSync(tmp, { force: true })
    return fail(`atomic swap failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Post-swap health-check. If the freshly-installed binary will not serve,
  // roll back to the binary we just preserved.
  const postFail = await smokeTest(target, spawn)
  if (postFail) {
    try {
      renameSync(prev, target) // restore the last-good binary
      invalidateDigestCache(opts.statePath)
      const msg = `post-swap health failed (${postFail}); rolled back to previous binary`
      err(`[update] ${msg}`)
      // A failed update that self-healed is still a failure the operator must
      // see — but the box is on its last-good binary, so boot may proceed.
      return { outcome: 'failed', code: opts.bestEffort ? 0 : 1, message: msg }
    } catch (e) {
      // Could not restore — surface loudly. The swapped-in binary already
      // passed the pre-swap smoke test, so it is the same class of "runnable".
      const msg = `post-swap health failed and rollback failed: ${e instanceof Error ? e.message : String(e)}`
      err(`[update] ${msg}`)
      return { outcome: 'failed', code: opts.bestEffort ? 0 : 1, message: msg }
    }
  }

  writeDigestCache(opts.statePath, {
    path: target,
    size: statSync(target).size,
    mtimeMs: Math.trunc(statSync(target).mtimeMs),
    sha256: resolved.sha256,
  })
  const label = resolved.version ? ` (${resolved.version})` : ''
  out(`kortixd updated → ${resolved.sha256.slice(0, 12)}${label}; previous kept at ${prev}`)
  return { outcome: 'updated', code: 0, message: 'updated' }
}

async function cmdUpdate(binPath: string, argv: string[]): Promise<number> {
  const flags = parseFlags(argv)
  const bestEffort =
    flags.boot === true ||
    flags['best-effort'] === true ||
    (process.env.KORTIXD_UPDATE_BEST_EFFORT ?? '') === '1'
  const targetPath = typeof flags.target === 'string' ? flags.target : binPath
  const result = await performUpdate({
    targetPath,
    from:
      typeof flags.from === 'string'
        ? flags.from
        : typeof flags.url === 'string'
          ? flags.url
          : undefined,
    channel: typeof flags.channel === 'string' ? flags.channel : undefined,
    version: typeof flags.version === 'string' ? flags.version : undefined,
    bestEffort,
    statePath: defaultStatePath(targetPath),
  })
  return result.code
}

/** Roll back to `<name>.prev` on demand. Consumes the `.prev` (one previous
 *  version kept), mirroring the supervisor's rollback policy. */
export function performRollback(
  targetPath: string,
  statePath: string,
): { code: number; message: string } {
  const prev = `${targetPath}.prev`
  if (!existsSync(prev)) {
    return { code: 1, message: 'no previous version to roll back to (.prev absent)' }
  }
  try {
    renameSync(prev, targetPath) // atomic
    chmodSync(targetPath, 0o755)
    invalidateDigestCache(statePath)
    return { code: 0, message: `rolled back to previous binary (${targetPath})` }
  } catch (e) {
    return { code: 1, message: `rollback failed: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function cmdRollback(binPath: string, argv: string[]): number {
  const flags = parseFlags(argv)
  const targetPath = typeof flags.target === 'string' ? flags.target : binPath
  const r = performRollback(targetPath, defaultStatePath(targetPath))
  if (r.code === 0) out(r.message)
  else err(`rollback: ${r.message}`)
  return r.code
}

// ── help ─────────────────────────────────────────────────────────────────────

function printHelp(): number {
  out(`kortixd ${pkg.version} — the Kortix sandbox agent daemon and its manager.

USAGE
  kortixd [serve]                 Run the sandbox agent server (default).
  kortixd version                 Print version and build digest.
  kortixd install [--dir <path>]  Install this binary onto PATH (idempotent;
                                  no-op if present, --force to overwrite).
  kortixd update [flags]          Self-update to the current published build.
  kortixd rollback                Revert to the previous binary (<name>.prev).
  kortixd --health-check          Smoke-test: boot a health server and exit 0.
  kortixd --help                  Show this help.

UPDATE FLAGS
  --from <path|url>   Update from a local file or an explicit URL instead of
                      the runtime-assets manifest.
  --channel <c>       Reserved for channel selection.
  --version <v>       Reserved for pinning a specific version.
  --boot              Best-effort: never hard-fail; keep the last-good binary
                      and exit 0 so a boot sequence can proceed to \`serve\`.
                      (Also enabled by KORTIXD_UPDATE_BEST_EFFORT=1.)
  --target <path>     Update a binary other than the running one (testing).

BOOT SEQUENCE (idempotent, run every start)
  kortixd install && kortixd update --boot && kortixd serve

RELIABILITY
  update = download → verify digest → smoke-test → atomic swap (keep .prev) →
  post-swap health → auto-rollback on any failure. A half-written binary is
  never left on disk. A bad publish never bricks the box.

ENV
  KORTIX_API_URL, KORTIX_CLI_TOKEN   Runtime-assets manifest source.
  KORTIXD_STATE_PATH                 Digest-cache location.
  KORTIXD_UPDATE_BEST_EFFORT=1       Force best-effort update.`)
  return 0
}

// ── dispatch ─────────────────────────────────────────────────────────────────

/**
 * Handle a management verb, or say `serve`. `main.ts` calls this for the verbs
 * in {@link MANAGEMENT_VERBS}; everything else boots the daemon.
 */
export async function dispatchCli(argv: string[]): Promise<CliOutcome> {
  const sub = argv[0]
  const rest = argv.slice(1)
  const binPath = process.execPath

  switch (sub) {
    case 'version':
    case '--version':
    case '-v':
      return { action: 'exit', code: cmdVersion(binPath) }
    case '--health-check':
      return { action: 'exit', code: await cmdHealthCheck(rest) }
    case 'install':
      return { action: 'exit', code: cmdInstall(binPath, rest) }
    case 'update':
      return { action: 'exit', code: await cmdUpdate(binPath, rest) }
    case 'rollback':
      return { action: 'exit', code: cmdRollback(binPath, rest) }
    case 'help':
    case '--help':
    case '-h':
      return { action: 'exit', code: printHelp() }
    case 'serve':
    case undefined:
    default:
      return { action: 'serve' }
  }
}
