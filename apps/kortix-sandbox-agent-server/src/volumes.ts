/**
 * kortix.yaml `volumes` — mount the storage an agent attaches at
 * `/volumes/<name>` before the harness starts, so every tool the agent
 * already has (ls, cat, grep, edit, bash) works on it unchanged.
 *
 * Input: `KORTIX_VOLUMES`, built by apps/api (projects/lib/session-volumes.ts).
 * It names the env vars that hold each credential; the values come from the
 * project env store, i.e. the agent's own granted secrets.
 *
 * One rclone FUSE process per volume, run as root through sudo: Platinum's
 * /dev/fuse is root-only, and a root mount with --allow-other and this
 * daemon's --uid/--gid makes the files the agent's own. Settings pinned by a
 * spike against real S3 (2026-09-24):
 *   - Write-back stays at rclone's default 5 s. `--vfs-write-back 0s` left the
 *     OLD object in S3 after `sed -i`, a temp-file + rename save, and `mv`.
 *   - The VFS cache lives on the persistent disk: a killed rclone's pending
 *     uploads go out on the next mount with the same --cache-dir.
 *   - --use-server-modtime: without it every `ls` sends a HEAD per object.
 *   - --s3-no-check-bucket: a key scoped to one bucket, without CreateBucket,
 *     can still write.
 *
 * Best effort by contract: a volume that cannot mount is reported to the agent
 * (VOLUMES_INSTRUCTION_PATH) and in its log. It never fails the boot.
 */
import { execFile, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logger } from './logger'
import type { ProjectEnvStore } from './project-env'
import { resolveKortixRuntimeStateDirectory } from './runtime-state-dir'

export const VOLUMES_ENV_NAME = 'KORTIX_VOLUMES'
export const VOLUMES_INSTRUCTION_PATH = '/tmp/kortix/volumes.md'
export const VOLUME_MOUNT_ROOT = '/volumes'
export const VOLUME_LOG_DIR = '/var/log/kortix-volumes'
/** How long the harness start waits for all mounts together. */
export const VOLUME_MOUNT_BUDGET_MS = 10_000
/** How long one mount may take before it is reported failed. */
const MOUNT_TIMEOUT_MS = 60_000
/** A first listing slower than this is a large directory, not a failure. */
const PROBE_MS = 5_000
// ponytail: fixed 2 GiB read/write cache per volume on the 20 GB default disk;
// make it a volume field when a real workload needs more.
const VFS_CACHE_MAX_SIZE = '2G'

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,63}$/

type Mode = 'read-only' | 'read-write'

export type MountableVolume = {
  name: string
  mode: Mode
  type: 's3'
  bucket: string
  prefix?: string
  region?: string
  endpoint?: string
  access_key_id_env?: string
  secret_access_key_env?: string
}

export type VolumeSpec = MountableVolume | { name: string; mode: Mode; error: string }

export type VolumeStatus =
  | { state: 'mounting' }
  | { state: 'mounted' }
  | { state: 'failed'; reason: string }

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Parse `KORTIX_VOLUMES`. Malformed entries are dropped; a malformed envelope is empty. */
export function parseVolumesEnv(raw: string | undefined): VolumeSpec[] {
  if (!raw?.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    logger.warn('[volumes] KORTIX_VOLUMES is not valid JSON; no volumes mounted')
    return []
  }
  const list = (parsed as { version?: unknown; volumes?: unknown })?.volumes
  if ((parsed as { version?: unknown })?.version !== 1 || !Array.isArray(list)) return []
  const seen = new Set<string>()
  return list.flatMap((entry): VolumeSpec[] => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as Record<string, unknown>
    const name = str(item.name)
    const mode: Mode | undefined = item.mode === 'read-write' ? 'read-write' : item.mode === 'read-only' ? 'read-only' : undefined
    if (!name || !NAME_RE.test(name) || !mode || seen.has(name)) return []
    seen.add(name)
    const error = str(item.error)
    if (error) return [{ name, mode, error }]
    const bucket = str(item.bucket)
    if (item.type !== 's3' || !bucket) return [{ name, mode, error: 'the volume spec from the API is incomplete' }]
    const spec: MountableVolume = { name, mode, type: 's3', bucket }
    for (const key of ['prefix', 'region', 'endpoint'] as const) {
      const value = str(item[key])
      if (value) spec[key] = value
    }
    for (const key of ['access_key_id_env', 'secret_access_key_env'] as const) {
      const value = str(item[key])
      if (value && ENV_NAME_RE.test(value)) spec[key] = value
    }
    return [spec]
  })
}

export function volumeMountPoint(name: string): string {
  return `${VOLUME_MOUNT_ROOT}/${name}`
}

/** rclone on-the-fly remote: the bucket, narrowed to the prefix. */
export function rcloneRemote(spec: MountableVolume): string {
  const prefix = spec.prefix?.replace(/^\/+|\/+$/g, '')
  return `:s3:${spec.bucket}${prefix ? `/${prefix}` : ''}`
}

/**
 * The rclone process env for one volume. Credentials go through env, never
 * argv: argv is world-readable in /proc, env is root-only.
 */
export function rcloneEnv(
  spec: MountableVolume,
  secrets: Record<string, string>,
): { env: Record<string, string> } | { error: string } {
  const env: Record<string, string> = {
    RCLONE_S3_PROVIDER: spec.endpoint ? 'Other' : 'AWS',
    RCLONE_S3_ENV_AUTH: 'false',
    RCLONE_S3_NO_CHECK_BUCKET: 'true',
  }
  if (spec.endpoint) {
    env.RCLONE_S3_ENDPOINT = spec.endpoint
    // A proxy in front of an S3-compatible service (Cloudflare, verified with a
    // MinIO behind a tunnel) rewrites Accept-Encoding, and a signature that
    // covers it fails with SignatureDoesNotMatch. Host and x-amz-* stay signed.
    env.RCLONE_S3_SIGN_ACCEPT_ENCODING = 'false'
  }
  if (spec.region) env.RCLONE_S3_REGION = spec.region
  const pairs = [
    [spec.access_key_id_env, 'RCLONE_S3_ACCESS_KEY_ID'],
    [spec.secret_access_key_env, 'RCLONE_S3_SECRET_ACCESS_KEY'],
  ] as const
  for (const [source, target] of pairs) {
    if (!source) continue
    const value = secrets[source]
    if (!value) return { error: `credential env var ${source} is empty in this session` }
    env[target] = value
  }
  return { env }
}

export function rcloneMountArgs(
  spec: MountableVolume,
  opts: { mountPoint: string; cacheDir: string; logFile: string; uid: number; gid: number },
): string[] {
  return [
    'mount',
    rcloneRemote(spec),
    opts.mountPoint,
    '--allow-other',
    '--uid', String(opts.uid),
    '--gid', String(opts.gid),
    '--use-server-modtime',
    '--vfs-cache-mode', 'full',
    '--vfs-cache-max-size', VFS_CACHE_MAX_SIZE,
    '--cache-dir', opts.cacheDir,
    '--dir-cache-time', '1m',
    '--contimeout', '10s',
    '--log-file', opts.logFile,
    '--log-level', 'INFO',
    ...(spec.mode === 'read-only' ? ['--read-only'] : []),
  ]
}

function describeSource(spec: VolumeSpec): string {
  if ('error' in spec) return ''
  const path = `s3://${spec.bucket}${spec.prefix ? `/${spec.prefix.replace(/^\/+/, '')}` : ''}`
  return spec.endpoint ? `${path} at ${spec.endpoint}` : path
}

/** The agent-facing note. Loaded as an OpenCode instruction and into pi's system prompt. */
export function renderVolumesInstruction(specs: VolumeSpec[], status: Map<string, VolumeStatus>): string {
  const lines = [
    '## Volumes',
    '',
    `External storage is mounted as ordinary directories under ${VOLUME_MOUNT_ROOT}. Use your normal file tools on them (ls, cat, grep, edit).`,
    '',
  ]
  for (const spec of specs) {
    const where = `\`${volumeMountPoint(spec.name)}\``
    const state = status.get(spec.name) ?? ('error' in spec ? { state: 'failed', reason: spec.error } : { state: 'mounting' })
    if (state.state === 'failed') {
      lines.push(`- ${where}: NOT MOUNTED. ${state.reason}`)
    } else if (state.state === 'mounting') {
      lines.push(`- ${where}: ${describeSource(spec)} (${spec.mode}), still mounting; retry in a few seconds.`)
    } else {
      lines.push(`- ${where}: ${describeSource(spec)} (${spec.mode}).`)
    }
  }
  lines.push(
    '',
    'These are object storage, not a local disk. A write reaches storage about 5 seconds after the file is closed. Appending re-uploads the whole file. Symlinks and empty directories are not kept. Changes made outside this session appear within 1 minute. When two sessions write the same file, the last write wins. Prefer narrow paths over recursive searches of large volumes.',
    `Mount logs: ${VOLUME_LOG_DIR}/<name>.log.`,
  )
  return `${lines.join('\n')}\n`
}

export type VolumeDeps = {
  /** Run a short command to completion; rejects on a non-zero exit. */
  run(cmd: string, args: string[]): Promise<void>
  /** mkdir -p as THIS process's user (never through sudo). */
  makeDir(path: string): void
  /** Create an empty file (or keep an existing one) as THIS process's user. */
  touchFile(path: string): void
  /** Start a long-lived process detached from this daemon. Resolves with its exit, if it exits. */
  spawnDetached(cmd: string, args: string[], env: Record<string, string>): { exited: Promise<number | null> }
  isMounted(mountPoint: string): boolean
  listDir(path: string): Promise<unknown>
  readLog(path: string): string
  writeInstruction(path: string, text: string): void
  uid: number
  gid: number
  sleep(ms: number): Promise<void>
  now(): number
}

function fileWriteAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, path)
}

export const systemVolumeDeps = (): VolumeDeps => ({
  run: (cmd, args) =>
    new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout: 10_000 }, (err, _stdout, stderr) =>
        err ? reject(new Error(stderr.trim() || err.message)) : resolve(),
      )
    }),
  makeDir: (path) => {
    mkdirSync(path, { recursive: true })
  },
  touchFile: (path) => {
    appendFileSync(path, '', { mode: 0o644 })
  },
  spawnDetached: (cmd, args, env) => {
    const child = spawn(cmd, args, { env, detached: true, stdio: 'ignore' })
    const exited = new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code))
      child.on('error', () => resolve(-1))
    })
    child.unref()
    return { exited }
  },
  isMounted: (mountPoint) => {
    try {
      return readFileSync('/proc/mounts', 'utf8')
        .split('\n')
        .some((line) => line.split(' ')[1] === mountPoint)
    } catch {
      return false
    }
  },
  listDir: (path) => readdir(path),
  readLog: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  },
  writeInstruction: fileWriteAtomic,
  uid: process.getuid?.() ?? 0,
  gid: process.getgid?.() ?? 0,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
})

/** The last error rclone logged, e.g. `AccessDenied: Access Denied`. */
function lastLoggedError(log: string): string | null {
  const line = log
    .split('\n')
    .filter((l) => /\b(ERROR|CRITICAL)\b/.test(l))
    .pop()
  return line ? line.replace(/^.*?\b(ERROR|CRITICAL)\s*:\s*/, '').slice(0, 300) : null
}

/**
 * rclone checks whether a `prefix` is an object with a HEAD request. When S3
 * REJECTS that HEAD (bad key, wrong endpoint, signature mismatch) rclone logs
 * "is a file not a directory" — true only if the prefix really is an object.
 * Say what it almost always means, and keep rclone's words.
 */
export function explainMountError(raw: string, spec: MountableVolume): string {
  if (spec.prefix && /is a file not a directory/.test(raw)) {
    return `S3 rejected the request for prefix "${spec.prefix}" in bucket "${spec.bucket}" (or that prefix is an object, not a folder). Check the key, the bucket, and the endpoint. rclone: ${raw}`
  }
  return raw
}

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([promise, new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), Math.max(0, ms)))])
}

async function mountOne(
  spec: MountableVolume,
  secrets: Record<string, string>,
  deps: VolumeDeps,
  deadline: number,
): Promise<VolumeStatus> {
  const result = await attemptMount(spec, secrets, deps, deadline)
  const mountPoint = volumeMountPoint(spec.name)
  if (result.state === 'failed' && !deps.isMounted(mountPoint)) {
    // Leave no directory behind. An empty /volumes/<name> reads as a working
    // volume; on a real session the agent wrote its output there (local disk,
    // never uploaded). Gone, a write fails loudly. rmdir refuses non-empty.
    await asRoot(deps, 'rmdir', [mountPoint]).catch(() => {})
  }
  return result
}

function asRoot(deps: VolumeDeps, cmd: string, args: string[]): Promise<void> {
  return deps.uid === 0 ? deps.run(cmd, args) : deps.run('sudo', ['-n', cmd, ...args])
}

async function attemptMount(
  spec: MountableVolume,
  secrets: Record<string, string>,
  deps: VolumeDeps,
  deadline: number,
): Promise<VolumeStatus> {
  const mountPoint = volumeMountPoint(spec.name)
  const logFile = `${VOLUME_LOG_DIR}/${spec.name}.log`
  // One listing surfaces a bad key or a missing bucket (rclone logs the S3
  // error and the listing fails). A listing still running after PROBE_MS is a
  // large directory: the mount works.
  const probe = async (): Promise<VolumeStatus> => {
    const listed = await withDeadline(
      deps.listDir(mountPoint).then(() => 'ok' as const, (err: Error) => err),
      Math.min(PROBE_MS, deadline - deps.now()),
    )
    if (listed === 'ok' || listed === 'timeout') return { state: 'mounted' }
    const logged = lastLoggedError(deps.readLog(logFile))
    return { state: 'failed', reason: logged ? explainMountError(logged, spec) : `listing ${mountPoint} failed: ${listed.message}` }
  }

  // A daemon restart inside a live box finds its earlier mount still up: reuse it.
  if (deps.isMounted(mountPoint)) return probe()

  const credentials = rcloneEnv(spec, secrets)
  if ('error' in credentials) return { state: 'failed', reason: credentials.error }
  const root = deps.uid === 0
  const cacheDir = join(resolveKortixRuntimeStateDirectory(), 'volumes', spec.name)
  // The cache sits under the daemon's own state dir, which may not exist yet
  // this early in boot. Create it as the daemon user: a `sudo mkdir -p` would
  // create the state dir itself root-owned, and every later daemon write there
  // (audit spool, pins) fails with EACCES — found on a real Daytona session.
  try {
    deps.makeDir(cacheDir)
  } catch (err) {
    return { state: 'failed', reason: `could not create the volume cache ${cacheDir}: ${(err as Error).message}` }
  }
  // /volumes and /var/log are root's. The log dir and file belong to the
  // daemon user so the agent (and the failure report below) can read them:
  // rclone, as root, appends to an existing file and keeps its owner and mode,
  // but creates a missing one root-only (0640) — seen on a real session.
  try {
    await asRoot(deps, 'mkdir', ['-p', mountPoint])
    await asRoot(deps, 'install', ['-d', '-o', String(deps.uid), '-g', String(deps.gid), VOLUME_LOG_DIR])
  } catch (err) {
    return { state: 'failed', reason: `could not create ${mountPoint}: ${(err as Error).message}` }
  }
  try {
    deps.touchFile(logFile)
  } catch (err) {
    logger.warn('[volumes] could not pre-create the mount log; it will be root-only', { logFile, err: (err as Error).message })
  }
  const args = rcloneMountArgs(spec, { mountPoint, cacheDir, logFile, uid: deps.uid, gid: deps.gid })
  const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', ...credentials.env }
  // sudo -E keeps the credentials in the root process env (NOPASSWD: ALL implies SETENV).
  const child = root ? deps.spawnDetached('rclone', args, env) : deps.spawnDetached('sudo', ['-n', '-E', 'rclone', ...args], env)
  let exitCode: number | null | undefined
  void child.exited.then((code) => {
    exitCode = code
  })
  while (!deps.isMounted(mountPoint)) {
    if (exitCode !== undefined) {
      const logged = lastLoggedError(deps.readLog(logFile))
      const missing = exitCode === 127 || exitCode === -1 ? 'rclone is not installed in this sandbox image; rebuild the sandbox template' : null
      return { state: 'failed', reason: (logged && explainMountError(logged, spec)) ?? missing ?? `rclone exited with code ${exitCode}; see ${logFile}` }
    }
    if (deps.now() >= deadline) {
      return { state: 'failed', reason: `rclone did not mount within ${MOUNT_TIMEOUT_MS / 1000} s; see ${logFile}` }
    }
    await deps.sleep(100)
  }
  return probe()
}

export type VolumesHandle = {
  /** True when this session attaches at least one volume. */
  declared: boolean
  /** Settles when every mount finished or the budget passed. Never rejects. */
  ready: Promise<void>
}

/**
 * Write the volumes note, then mount every attached volume. The note is
 * written SYNCHRONOUSLY before this returns, so a harness config composed
 * right after (OpenCode's `instructions`) finds the file. `ready` stops
 * waiting at the budget; a slower mount keeps going and rewrites the note.
 */
export function startVolumes(opts: {
  env?: NodeJS.ProcessEnv
  projectEnv: ProjectEnvStore
  deps?: VolumeDeps
  budgetMs?: number
}): VolumesHandle {
  const specs = parseVolumesEnv((opts.env ?? process.env)[VOLUMES_ENV_NAME])
  if (specs.length === 0) return { declared: false, ready: Promise.resolve() }
  const deps = opts.deps ?? systemVolumeDeps()
  const status = new Map<string, VolumeStatus>()
  const writeNote = () => {
    try {
      deps.writeInstruction(VOLUMES_INSTRUCTION_PATH, renderVolumesInstruction(specs, status))
    } catch (err) {
      logger.warn('[volumes] could not write the volumes instruction file', { err: (err as Error).message })
    }
  }
  writeNote()

  const secrets = opts.projectEnv.snapshot().env
  const deadline = deps.now() + MOUNT_TIMEOUT_MS
  const all = specs.map(async (spec) => {
    const result: VolumeStatus =
      'error' in spec
        ? { state: 'failed', reason: spec.error }
        : await mountOne(spec, secrets, deps, deadline).catch((err: Error) => ({ state: 'failed' as const, reason: err.message }))
    status.set(spec.name, result)
    logger.info('[volumes] mount result', { name: spec.name, mode: spec.mode, ...result })
    writeNote()
  })
  const ready = Promise.race([Promise.all(all), deps.sleep(opts.budgetMs ?? VOLUME_MOUNT_BUDGET_MS)]).then(() => undefined)
  return { declared: true, ready }
}
