/**
 * S3 transport: verified acquisition of a PREPARED project snapshot into a
 * private stage directory under the project target, then — off the boot
 * path — the import of its blob pack.
 *
 *   descriptor (Git proxy, KORTIX_TOKEN)  →  two presigned GETs (no credential)
 *   boot object  →  stage FILE (sha256 + byte cap + inactivity watchdog on the
 *                   stream, tar headers guarded on a tee of the same stream)
 *                →  digest verified  →  native `tar` extraction (in-process
 *                   fallback)  →  marker / .git/config / HEAD verified
 *                →  (coordinator) activate
 *   hydration    →  `git index-pack --stdin` fed from the stream, sha256 on
 *                   the way, pack marked promisor
 *
 * The boot object is the working tree plus a `.git` whose ONE pack holds the
 * commit and trees, no blobs, marked promisor. The box is a valid partial
 * clone the moment the tar is extracted, so nothing runs git on the boot path;
 * `git status` and the harness's project scan need no blob. Blobs arrive
 * through the hydration object after activation. Until then a missing blob is
 * fetched lazily through the proxy (slower, never broken).
 *
 * Nothing is written outside the stage before the whole object has been
 * hashed and every tar header has passed the guard; a failed attempt removes
 * its own stage file/dir and nothing else. The sandbox env carries only the
 * boot object's IDENTITY (KORTIX_PROJECT_SNAPSHOT_PIN = sha:sha256:bytes); the
 * URLs are minted per boot by the API and expire in minutes.
 *
 * Every failure is classified (see types.ts); the coordinator decides whether
 * it falls back. This module never falls back and never touches the live
 * workspace.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'
import { Readable, Transform, type Writable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import * as tar from 'tar'

import type { Config } from '../../config'
import { createStagePath, runGit } from '../../git'
import { logger } from '../../logger'
import {
  ConfigProviderError,
  type MaterializeRequest,
  type S3AcquisitionMetrics,
  type S3FailureReason,
  type S3Stage,
  type SnapshotHydrationSummary,
} from '../types'

export const PROJECT_SNAPSHOT_FORMAT = 'project-snapshot-v2'
export const PROJECT_SNAPSHOT_MARKER_PATH = '.git/kortix-project-snapshot.json'

/** Per-attempt wall clock for the descriptor call. */
const DESCRIPTOR_TIMEOUT_MS = 10_000
/**
 * A transfer that delivers no byte for this long is dead, whatever the socket
 * says: a reset mid-body does not always surface as a stream error under Bun,
 * and the Git path aborts a stalled pack the same way (http.lowSpeedTime=12).
 * Classified `unavailable` (transient, retried), never `timeout`.
 */
export const DEFAULT_INACTIVITY_TIMEOUT_MS = 12_000
/** Attempts within the total deadline; only transient failures are retried. */
export const S3_MAX_ATTEMPTS = 3
/** Hydration runs after readiness: its own attempts and budget. */
export const HYDRATION_MAX_ATTEMPTS = 3
export const DEFAULT_HYDRATION_TIMEOUT_MS = 120_000
/** Extraction guard: the sum of entry sizes may not exceed this (tar bomb). */
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024
/** Extraction guard: entries beyond the descriptor's count (+ slack) are refused. */
const ENTRY_SLACK = 1_024
const SHA_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/

export interface ProjectSnapshotPin {
  sha: string
  sha256: string
  bytes: number
}

/** `<sha>:<sha256>:<bytes>` → pin, or null when malformed. */
export function parseProjectSnapshotPin(raw: string | undefined): ProjectSnapshotPin | null {
  if (!raw) return null
  const [sha, sha256, bytesRaw] = raw.trim().split(':')
  const bytes = Number(bytesRaw)
  if (!sha || !sha256 || !SHA_RE.test(sha.toLowerCase()) || !SHA256_RE.test(sha256.toLowerCase())) return null
  if (!Number.isInteger(bytes) || bytes <= 0) return null
  return { sha: sha.toLowerCase(), sha256: sha256.toLowerCase(), bytes }
}

export interface SnapshotObjectRef {
  url: string
  sha256: string
  bytes: number
  expires_at: string
}

export interface ProjectSnapshotDescriptor {
  format: typeof PROJECT_SNAPSHOT_FORMAT
  commit_sha: string
  ref: string
  repository: { owner: string; name: string; external_id: string }
  /** Boot object: working tree + blobless .git, tar.gz. Its identity is the session pin. */
  tree: SnapshotObjectRef & { entries: number }
  /** Hydration object: the tip's blob pack. */
  blobs: SnapshotObjectRef
}

/** `…/v1/git/<project>.git` → `…/v1/git/<project>.git/project-snapshot?sha=<sha>` */
export function buildProjectSnapshotDescriptorUrl(repoUrl: string, sha: string): string {
  const url = new URL(repoUrl)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigProviderError('precondition', 'not-configured', `project snapshot requires an HTTP(S) Git proxy URL, got ${url.protocol}`)
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  url.pathname = `${url.pathname.replace(/\/$/, '')}/project-snapshot`
  url.search = ''
  url.searchParams.set('sha', sha)
  return url.toString()
}

/** Query strings carry the signature; only scheme://host/path may be logged. */
export function sanitizeUrlForLog(raw: string): string {
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.host}${u.pathname}`
  } catch {
    return raw.split('?')[0] ?? raw
  }
}

function linkedSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new Error(`timed out after ${timeoutMs}ms`))
  }, timeoutMs)
  const onParentAbort = () => controller.abort(parent?.reason)
  if (parent) {
    if (parent.aborted) onParentAbort()
    else parent.addEventListener('abort', onParentAbort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onParentAbort)
    },
    timedOut: () => timedOut,
  }
}

function abortReason(req: { signal?: AbortSignal }, timedOut: boolean): S3FailureReason {
  if (req.signal?.aborted) return 'cancelled'
  return timedOut ? 'timeout' : 'unavailable'
}

function isAbortError(err: unknown): boolean {
  const name = (err as { name?: string })?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

function errorMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err)
}

// ── Descriptor ──────────────────────────────────────────────────────────────

function objectRefOk(ref: SnapshotObjectRef | undefined): boolean {
  return (
    typeof ref?.url === 'string' &&
    SHA256_RE.test(ref?.sha256 ?? '') &&
    Number.isInteger(ref?.bytes) &&
    (ref?.bytes ?? 0) > 0
  )
}

export async function fetchProjectSnapshotDescriptor(
  cfg: Config,
  sha: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ProjectSnapshotDescriptor> {
  if (!cfg.repoUrl || !cfg.sandboxToken) {
    throw new ConfigProviderError('precondition', 'not-configured', 'KORTIX_REPO_URL and KORTIX_TOKEN are required')
  }
  const url = buildProjectSnapshotDescriptorUrl(cfg.repoUrl, sha)
  const link = linkedSignal(options.signal, DESCRIPTOR_TIMEOUT_MS)
  let res: Response
  try {
    res = await (options.fetchImpl ?? fetch)(url, {
      headers: { accept: 'application/json', authorization: `Bearer ${cfg.sandboxToken}` },
      signal: link.signal,
    })
  } catch (err) {
    const reason = isAbortError(err) ? abortReason(options, link.timedOut()) : 'unavailable'
    throw new ConfigProviderError('descriptor', reason, `descriptor request failed: ${errorMessage(err)}`, 0, { cause: err })
  } finally {
    link.dispose()
  }
  if (res.status === 404) {
    throw new ConfigProviderError('descriptor', 'missing', `no prepared archive for ${sha}`)
  }
  if (res.status === 401 || res.status === 403) {
    throw new ConfigProviderError('descriptor', 'denied', `descriptor authorization denied (HTTP ${res.status})`)
  }
  if (!res.ok) {
    throw new ConfigProviderError('descriptor', 'unavailable', `descriptor HTTP ${res.status}`)
  }
  let body: ProjectSnapshotDescriptor
  try {
    body = (await res.json()) as ProjectSnapshotDescriptor
  } catch (err) {
    throw new ConfigProviderError('descriptor', 'malformed', 'descriptor is not valid JSON', 0, { cause: err })
  }
  if (
    body?.format !== PROJECT_SNAPSHOT_FORMAT ||
    body.commit_sha !== sha ||
    !objectRefOk(body.tree) ||
    !Number.isInteger(body.tree?.entries) ||
    !objectRefOk(body.blobs) ||
    typeof body.repository?.external_id !== 'string'
  ) {
    throw new ConfigProviderError('descriptor', 'malformed', 'descriptor does not describe the expected snapshot objects')
  }
  return body
}

// ── Entry guard ─────────────────────────────────────────────────────────────

type TarEntryLike = { type: string; linkpath?: string; size?: number }

/** Normalize a tar member path: strip `./` prefixes; '' means the archive root. */
function normalizeEntryPath(raw: string): string {
  let p = raw.replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  if (p === '.') p = ''
  return p.replace(/\/+$/, '')
}

/**
 * The archive contract, enforced header by header on the stream BEFORE
 * anything is written to the stage: relative paths only, no `..`, files /
 * directories / in-tree symlinks only, no hooks, no duplicates, bounded count
 * and size. The native extractor's own protections (leading `/` stripped,
 * `..` members refused) run on top.
 */
export function makeEntryGuard(limits: { maxEntries: number; maxBytes: number }) {
  const seen = new Set<string>()
  let entries = 0
  let bytes = 0
  return {
    counts: () => ({ entries, bytes }),
    check(rawPath: string, entry: TarEntryLike): string | null {
      const path = normalizeEntryPath(rawPath)
      if (rawPath.startsWith('/') || /^[A-Za-z]:/.test(rawPath)) return `absolute path: ${rawPath}`
      if (rawPath.includes('\0')) return 'NUL in path'
      const segments = path.split('/')
      if (segments.some((s) => s === '..')) return `path traversal: ${rawPath}`
      if (segments[0] === '.git' && segments[1] === 'hooks' && segments.length > 2) return `hook shipped in archive: ${rawPath}`
      switch (entry.type) {
        case 'Directory':
          break
        case 'File':
        case 'OldFile':
        case 'ContiguousFile':
          break
        case 'SymbolicLink': {
          const link = (entry.linkpath ?? '').replace(/\\/g, '/')
          if (!link || link.startsWith('/')) return `absolute symlink target: ${rawPath} -> ${link}`
          const resolved = posix.normalize(posix.join(dirname(path || '.'), link))
          if (resolved === '..' || resolved.startsWith('../')) return `symlink escapes archive: ${rawPath} -> ${link}`
          break
        }
        default:
          return `unsupported entry type ${entry.type}: ${rawPath}`
      }
      if (path !== '' && seen.has(path)) return `duplicate entry: ${rawPath}`
      seen.add(path)
      entries += 1
      if (entries > limits.maxEntries) return `entry count exceeds ${limits.maxEntries}`
      bytes += Math.max(0, Number(entry.size ?? 0))
      if (bytes > limits.maxBytes) return `uncompressed size exceeds ${limits.maxBytes} bytes`
      return null
    },
  }
}

function guardViolationError(problem: string): ConfigProviderError {
  const reason: S3FailureReason =
    problem.startsWith('entry count') || problem.startsWith('uncompressed size') ? 'limit-exceeded' : 'malformed'
  return new ConfigProviderError('extract', reason, `unsafe archive entry: ${problem}`)
}

// ── Streaming download (shared by boot object and hydration) ────────────────

interface StreamedObject {
  received: number
  digest: string
  /** ms from request start to first byte / last byte. */
  firstByteMs: number
  totalMs: number
}

/**
 * Stream one presigned object through the SHA-256 hasher into `sink`, and
 * (optionally) into `tap` — a second consumer whose errors are RECORDED, never
 * fatal: the transfer's own outcome is decided by byte count and digest.
 * Resolves only when the sink has finished and the bytes are exactly the
 * expected object; rejects with a classified ConfigProviderError otherwise.
 */
async function streamObject(
  url: string,
  expected: { bytes: number; sha256: string },
  io: { sink: Writable; tap?: Writable; onTapError?: (err: unknown) => void },
  options: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    timeoutMs: number
    inactivityTimeoutMs?: number
    accept: string
    /** Stage reported for transport failures. */
    stage: S3Stage
    /** Stage reported when the bytes are complete but not the object. */
    digestStage: S3Stage
  },
): Promise<StreamedObject> {
  const expectedBytes = expected.bytes
  const inactivityMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS
  const link = linkedSignal(options.signal, options.timeoutMs)
  const started = Date.now()
  const stage = options.stage
  let res: Response
  try {
    // No Authorization header: the URL IS the authorization, and the object
    // store would reject a foreign credential anyway.
    res = await (options.fetchImpl ?? fetch)(url, {
      headers: { accept: options.accept },
      signal: link.signal,
      redirect: 'error',
    })
  } catch (err) {
    link.dispose()
    const reason = isAbortError(err) ? abortReason(options, link.timedOut()) : 'unavailable'
    throw new ConfigProviderError(stage, reason, `object request failed: ${errorMessage(err)}`, 0, { cause: err })
  }
  try {
    if (res.status === 403) {
      throw new ConfigProviderError(stage, 'expired-authorization', 'object download authorization was refused (HTTP 403)')
    }
    if (res.status === 404) throw new ConfigProviderError(stage, 'missing', 'archive object not found (HTTP 404)')
    if (!res.ok) throw new ConfigProviderError(stage, 'unavailable', `object HTTP ${res.status}`)
    if (!res.body) throw new ConfigProviderError(stage, 'unavailable', 'object response has no body')
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > 0 && declared !== expectedBytes) {
      throw new ConfigProviderError(stage, declared > expectedBytes ? 'limit-exceeded' : 'digest-mismatch', `object content-length ${declared} != expected ${expectedBytes}`)
    }

    const hash = createHash('sha256')
    let received = 0
    let firstByteAt = 0
    const source = Readable.fromWeb(res.body as never)
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let onInactivity: (() => void) | null = null
    const armWatchdog = () => {
      if (watchdog) clearTimeout(watchdog)
      watchdog = setTimeout(() => onInactivity?.(), inactivityMs)
    }
    const hasher = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        if (!firstByteAt) firstByteAt = Date.now()
        armWatchdog()
        received += chunk.length
        if (received > expectedBytes) {
          // The response declared exactly `expectedBytes` (checked above), so
          // an overrun is transport garbage, not a large object: Bun 1.3 (the
          // sandbox agent's build runtime) re-issues the GET after a mid-body
          // socket reset and appends the second response to this same stream.
          // Transient → `unavailable`, retried.
          callback(new ConfigProviderError(stage, 'unavailable', `transfer overran the declared ${expectedBytes} bytes`))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (err: unknown) => {
        if (settled) return
        settled = true
        if (watchdog) clearTimeout(watchdog)
        source.destroy()
        io.sink.destroy?.()
        if (err instanceof ConfigProviderError) return reject(err)
        if (isAbortError(err) || link.signal.aborted) {
          return reject(new ConfigProviderError(stage, abortReason(options, link.timedOut()), `transfer aborted: ${errorMessage(err)}`, 0, { cause: err }))
        }
        reject(new ConfigProviderError(stage, 'unavailable', `transfer failed: ${errorMessage(err)}`, 0, { cause: err }))
      }
      const done = () => {
        if (settled) return
        settled = true
        if (watchdog) clearTimeout(watchdog)
        resolve()
      }
      onInactivity = () => fail(new ConfigProviderError(stage, 'unavailable', `transfer stalled: no bytes for ${inactivityMs}ms`))
      armWatchdog()
      source.on('error', fail)
      hasher.on('error', fail)
      io.sink.on('error', fail)
      io.sink.on('finish', done)
      // Bun can close a reset source without `end` or `error`: a short close
      // is a truncated transfer, not something to wait the watchdog out for.
      source.on('close', () => {
        setImmediate(() => {
          if (!settled && received < expectedBytes) {
            fail(new ConfigProviderError(stage, 'unavailable', `transfer closed after ${received} of ${expectedBytes} bytes`))
          }
        })
      })
      link.signal.addEventListener('abort', () => fail(link.signal.reason), { once: true })
      if (io.tap) {
        const tap = io.tap
        tap.on('error', (err) => {
          io.onTapError?.(err)
          hasher.unpipe(tap)
        })
        hasher.pipe(tap)
      }
      source.pipe(hasher).pipe(io.sink)
    })
    const finishedAt = Date.now()
    if (received < expectedBytes) {
      throw new ConfigProviderError(stage, 'unavailable', `transfer ended after ${received} of ${expectedBytes} bytes`)
    }
    const digest = hash.digest('hex')
    if (received !== expectedBytes || digest !== expected.sha256) {
      throw new ConfigProviderError(options.digestStage, 'digest-mismatch', `object digest/size mismatch: got ${digest}/${received}, expected ${expected.sha256}/${expectedBytes}`)
    }
    return {
      received,
      digest,
      firstByteMs: firstByteAt ? firstByteAt - started : finishedAt - started,
      totalMs: finishedAt - started,
    }
  } finally {
    link.dispose()
  }
}

// ── Boot object: download, guard, extract ───────────────────────────────────

export interface DownloadedSnapshot {
  bytes: number
  entries: number
  downloadMs: number
  extractMs: number
  extractor: 'tar' | 'node-tar'
}

function isDecompressionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? ''
  return code.startsWith('Z_') || /incorrect header check|invalid (block|distance|stored)|unexpected end of file|zlib/i.test(errorMessage(err))
}

function isTarError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? ''
  return code.startsWith('TAR_') || /tar/i.test((err as { name?: string })?.name ?? '')
}

/** The archive's declared entry count + slack is the guard's ceiling. */
function entryLimit(descriptor: ProjectSnapshotDescriptor): number {
  return Math.max(descriptor.tree.entries, 0) + ENTRY_SLACK
}

/**
 * Native extraction of the VERIFIED stage file. Returns null when no usable
 * `tar` binary is available (the caller falls back in-process); throws a
 * classified error when tar itself refuses the archive.
 */
async function extractWithSystemTar(
  binary: string,
  file: string,
  stage: string,
  options: { signal?: AbortSignal; timeoutMs: number },
): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    let stderr = ''
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(binary, ['-xzf', file, '-C', stage, '--no-same-owner'], {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: { ...process.env, LC_ALL: 'C' },
      })
    } catch {
      resolve(false)
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
    }, options.timeoutMs)
    const onAbort = () => child.kill('SIGKILL')
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      // ENOENT / EACCES: no tar on this box → in-process fallback.
      resolve(false)
      void err
    })
    child.on('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (code === 0) return resolve(true)
      if (options.signal?.aborted) return reject(new ConfigProviderError('extract', 'cancelled', 'extraction cancelled'))
      if (signal === 'SIGKILL') return reject(new ConfigProviderError('extract', 'timeout', `tar extraction exceeded ${options.timeoutMs}ms`))
      reject(new ConfigProviderError('extract', 'malformed', `tar exited ${code}: ${stderr.trim().slice(0, 300)}`))
    })
  })
}

/**
 * Stream the boot object into `<stage>.tgz` (hash, byte cap, watchdog, and the
 * header guard on a tee), verify the digest, then extract into `stage`.
 * Rejects with a classified ConfigProviderError; the caller removes the stage.
 */
export async function downloadAndExtractProjectSnapshot(
  descriptor: ProjectSnapshotDescriptor,
  stage: string,
  options: {
    fetchImpl?: typeof fetch
    signal?: AbortSignal
    timeoutMs: number
    inactivityTimeoutMs?: number
    /** Override the extractor binary (tests force the in-process fallback with a bogus path). */
    tarBinary?: string
  },
): Promise<DownloadedSnapshot> {
  const file = `${stage}.tgz`
  const guard = makeEntryGuard({ maxEntries: entryLimit(descriptor), maxBytes: MAX_UNCOMPRESSED_BYTES })
  let violation: ConfigProviderError | null = null
  let decoderError: unknown = null
  const gunzip = createGunzip()
  const parser = new tar.Parser({
    strict: true,
    filter: (path, entry) => {
      if (violation) return false
      const problem = guard.check(path, entry as unknown as TarEntryLike)
      if (problem) violation = guardViolationError(problem)
      return false // headers only: every entry's data is drained, nothing is written
    },
  })
  parser.on('error', (err) => {
    decoderError ??= err
  })
  gunzip.on('error', (err) => {
    decoderError ??= err
  })
  gunzip.pipe(parser)
  // The sink can finish while gunzip -> parser still holds unscanned headers.
  // Listen before streaming so no settle event is missed; await it after.
  const scanned = new Promise<void>((resolve) => {
    for (const event of ['end', 'close', 'abort', 'error']) parser.once(event, () => resolve())
    gunzip.once('error', () => resolve())
  })

  await mkdir(dirname(file), { recursive: true })
  const t0 = Date.now()
  let streamed: StreamedObject
  try {
    streamed = await streamObject(
      descriptor.tree.url,
      { bytes: descriptor.tree.bytes, sha256: descriptor.tree.sha256 },
      {
        sink: createWriteStream(file),
        tap: gunzip,
        onTapError: (err) => {
          decoderError ??= err
        },
      },
      {
        fetchImpl: options.fetchImpl,
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        inactivityTimeoutMs: options.inactivityTimeoutMs,
        accept: 'application/gzip',
        stage: 'download',
        digestStage: 'verify',
      },
    )
  } catch (err) {
    await rm(file, { force: true }).catch(() => {})
    throw err
  }
  const downloadMs = Date.now() - t0
  try {
    // Fail closed: nothing is extracted until every header has been scanned.
    const scanBudgetMs = Math.max(5_000, options.timeoutMs - (Date.now() - t0))
    let scanTimer: ReturnType<typeof setTimeout> | undefined
    const scanTimedOut = await Promise.race([
      scanned.then(() => false),
      new Promise<boolean>((resolve) => {
        scanTimer = setTimeout(() => resolve(true), scanBudgetMs)
      }),
    ])
    clearTimeout(scanTimer)
    if (scanTimedOut) {
      throw new ConfigProviderError('extract', 'timeout', `archive header scan did not finish within ${scanBudgetMs}ms`)
    }
    // The bytes ARE the published object (digest verified). Now the guard's
    // verdict on its headers is final, and a decoder error means the object
    // itself is not a valid gzip tar — never a transport problem.
    if (violation) throw violation
    if (decoderError) {
      throw new ConfigProviderError('extract', 'malformed', `archive is not a valid gzip tar: ${errorMessage(decoderError)}`, 0, { cause: decoderError })
    }
    const e0 = Date.now()
    await mkdir(stage, { recursive: true })
    const remaining = Math.max(5_000, options.timeoutMs - (Date.now() - t0))
    const binary = options.tarBinary ?? process.env.KORTIX_SNAPSHOT_TAR_BIN ?? 'tar'
    let extractor: 'tar' | 'node-tar' = 'tar'
    if (!(await extractWithSystemTar(binary, file, stage, { signal: options.signal, timeoutMs: remaining }))) {
      logger.warn('[config-provider] no usable tar binary; extracting in-process', { binary })
      extractor = 'node-tar'
      await rm(stage, { recursive: true, force: true })
      await mkdir(stage, { recursive: true })
      const again = makeEntryGuard({ maxEntries: entryLimit(descriptor), maxBytes: MAX_UNCOMPRESSED_BYTES })
      let late: ConfigProviderError | null = null
      try {
        await tar.x({
          file,
          cwd: stage,
          strict: true,
          preservePaths: false,
          preserveOwner: false,
          filter: (path, entry) => {
            if (late) return false
            const problem = again.check(path, entry as unknown as TarEntryLike)
            if (problem) late = guardViolationError(problem)
            return !problem
          },
        })
      } catch (err) {
        if (isDecompressionError(err) || isTarError(err)) {
          throw new ConfigProviderError('extract', 'malformed', `archive is not a valid gzip tar: ${errorMessage(err)}`, 0, { cause: err })
        }
        throw new ConfigProviderError('extract', 'unavailable', `extraction failed: ${errorMessage(err)}`, 0, { cause: err })
      }
      if (late) throw late
    }
    return {
      bytes: streamed.received,
      entries: guard.counts().entries,
      downloadMs,
      extractMs: Date.now() - e0,
      extractor,
    }
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
}

// ── Verify ──────────────────────────────────────────────────────────────────

const GIT_CONFIG_FORBIDDEN_RE =
  /^\s*\[(remote|credential|include|includeif|filter|url)\b|^\s*(hookspath|fsmonitor|sshcommand|askpass|gitproxy|pager|editor)\s*=/im

/**
 * The extracted stage must be the exact revision the pin named, and its `.git`
 * must not be able to run anything: no hooks (rejected by the guard), no
 * filters / remotes / includes in `.git/config`, and its pack must carry the
 * promisor mark the partial-clone contract relies on. Only plumbing
 * (`rev-parse`) touches the stage before activation — and it needs no blob.
 */
export async function verifyExtractedProjectSnapshot(
  stage: string,
  descriptor: ProjectSnapshotDescriptor,
): Promise<void> {
  let marker: { format?: string; commit_sha?: string; repository?: { external_id?: string } }
  try {
    marker = JSON.parse(await readFile(`${stage}/${PROJECT_SNAPSHOT_MARKER_PATH}`, 'utf8'))
  } catch (err) {
    throw new ConfigProviderError('verify', 'malformed', 'archive carries no readable snapshot marker', 0, { cause: err })
  }
  if (
    marker.format !== PROJECT_SNAPSHOT_FORMAT ||
    marker.commit_sha !== descriptor.commit_sha ||
    marker.repository?.external_id !== descriptor.repository.external_id
  ) {
    throw new ConfigProviderError('verify', 'revision-mismatch', 'snapshot marker does not match the descriptor')
  }
  let gitConfig = ''
  try {
    gitConfig = await readFile(`${stage}/.git/config`, 'utf8')
  } catch (err) {
    throw new ConfigProviderError('verify', 'malformed', 'archive carries no .git/config', 0, { cause: err })
  }
  const forbidden = gitConfig.match(GIT_CONFIG_FORBIDDEN_RE)
  if (forbidden) {
    throw new ConfigProviderError('verify', 'malformed', `archive .git/config carries a forbidden setting: ${forbidden[0].trim()}`)
  }
  let packs: string[] = []
  try {
    packs = await readdir(`${stage}/.git/objects/pack`)
  } catch {
    packs = []
  }
  if (!packs.some((n) => n.endsWith('.pack')) || !packs.some((n) => n.endsWith('.promisor'))) {
    throw new ConfigProviderError('verify', 'malformed', 'snapshot .git carries no promisor-marked pack')
  }
  const head = await runGit(['-C', stage, 'rev-parse', '--verify', 'HEAD'])
  const sha = head.stdout.trim()
  if (head.code !== 0 || sha !== descriptor.commit_sha) {
    throw new ConfigProviderError('verify', 'revision-mismatch', `extracted HEAD is ${sha || head.stderr.trim() || 'unreadable'}, expected ${descriptor.commit_sha}`)
  }
}

// ── The provider ────────────────────────────────────────────────────────────

export interface S3Acquisition {
  /** Verified stage under the target, ready for finalization. */
  stage: string
  descriptor: ProjectSnapshotDescriptor
  metrics: S3AcquisitionMetrics
}

/**
 * Is this boot eligible for an S3 attempt at all? Throws a `precondition`
 * ConfigProviderError naming why not. The coordinator treats these as
 * SKIPS (a Git-only start with a recorded reason), never as S3 failures: a
 * resumed/replacement session (`not-fresh`) must keep its remote-branch
 * restore semantics, and a session the API could not pin (`no-pin` = cache
 * miss) was never a pinned S3 attempt.
 */
export function checkS3Eligibility(req: MaterializeRequest): { sha: string; pin: ProjectSnapshotPin } {
  const cfg = req.cfg
  if (!cfg.sessionFresh) throw new ConfigProviderError('precondition', 'not-fresh', 'only a fresh session may materialize from a snapshot')
  if (!req.expectedSha) throw new ConfigProviderError('precondition', 'no-sha', 'no trusted base SHA (KORTIX_BASE_SHA) for this session')
  const pin = parseProjectSnapshotPin(cfg.projectSnapshotPin)
  if (!pin) throw new ConfigProviderError('precondition', 'no-pin', 'no prepared archive pinned for this session (cache miss)')
  if (pin.sha !== req.expectedSha) throw new ConfigProviderError('precondition', 'pin-mismatch', `pinned archive is for ${pin.sha}, session base is ${req.expectedSha}`)
  if (!cfg.repoUrl || !cfg.sandboxToken) throw new ConfigProviderError('precondition', 'not-configured', 'KORTIX_REPO_URL and KORTIX_TOKEN are required')
  return { sha: pin.sha, pin }
}

export interface S3ProviderOptions {
  fetchImpl?: typeof fetch
  inactivityTimeoutMs?: number
  tarBinary?: string
}

/**
 * Acquire the pinned boot object into a fresh stage. Retries transient
 * failures with jittered backoff inside `req.deadlineMs`; returns the verified
 * stage. Never activates, never falls back, never leaves a stage behind on
 * failure.
 */
export async function materializeFromS3(
  req: MaterializeRequest,
  options: S3ProviderOptions = {},
): Promise<S3Acquisition> {
  const { sha, pin } = checkS3Eligibility(req)
  const deadline = Date.now() + req.deadlineMs
  let attempts = 0
  let lastError: ConfigProviderError | null = null
  while (attempts < S3_MAX_ATTEMPTS) {
    attempts += 1
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new ConfigProviderError(lastError?.stage ?? 'download', 'timeout', `S3 acquisition deadline (${req.deadlineMs}ms) exhausted after ${attempts - 1} attempt(s)`, attempts - 1, { cause: lastError })
    }
    if (req.signal?.aborted) throw new ConfigProviderError('download', 'cancelled', 'acquisition cancelled', attempts - 1)
    const stage = await createStagePath(req.target, 'snapshot')
    try {
      const t0 = Date.now()
      const descriptor = await fetchProjectSnapshotDescriptor(req.cfg, sha, { fetchImpl: options.fetchImpl, signal: req.signal })
      const descriptorMs = Date.now() - t0
      if (descriptor.tree.sha256 !== pin.sha256 || descriptor.tree.bytes !== pin.bytes) {
        throw new ConfigProviderError('descriptor', 'revision-mismatch', 'descriptor names a different boot object than the session pin')
      }
      const downloaded = await downloadAndExtractProjectSnapshot(descriptor, stage, {
        fetchImpl: options.fetchImpl,
        signal: req.signal,
        timeoutMs: Math.max(1_000, deadline - Date.now()),
        inactivityTimeoutMs: options.inactivityTimeoutMs,
        tarBinary: options.tarBinary,
      })
      const v0 = Date.now()
      await verifyExtractedProjectSnapshot(stage, descriptor)
      return {
        stage,
        descriptor,
        metrics: {
          attempts,
          bytes: downloaded.bytes,
          entries: downloaded.entries,
          descriptorMs,
          downloadMs: downloaded.downloadMs,
          extractMs: downloaded.extractMs,
          verifyMs: Date.now() - v0,
          extractor: downloaded.extractor,
        },
      }
    } catch (err) {
      await rm(stage, { recursive: true, force: true }).catch(() => {})
      await rm(`${stage}.tgz`, { force: true }).catch(() => {})
      const failure =
        err instanceof ConfigProviderError
          ? err
          : new ConfigProviderError('extract', 'unavailable', errorMessage(err), attempts, { cause: err })
      lastError = new ConfigProviderError(failure.stage, failure.reason, failure.message, attempts, { cause: failure.cause ?? failure })
      if (!failure.retryable || attempts >= S3_MAX_ATTEMPTS) throw lastError
      const backoff = Math.min(300 * 2 ** (attempts - 1) + Math.floor(Math.random() * 250), Math.max(0, deadline - Date.now()))
      logger.warn('[config-provider] s3 attempt failed; retrying', {
        attempt: attempts,
        stage: failure.stage,
        reason: failure.reason,
        backoffMs: backoff,
        error: failure.message.slice(0, 200),
      })
      if (backoff > 0) await new Promise((r) => setTimeout(r, backoff))
    }
  }
  throw lastError ?? new ConfigProviderError('download', 'unavailable', 'S3 acquisition failed', attempts)
}

// ── After activation: index refresh + blob hydration ────────────────────────

/**
 * The snapshot ships an index with no stat data, so the first `git status`
 * would stat and hash every file. Do that once here, right after activation,
 * off the boot path; it needs no blob. Best effort.
 */
export async function refreshSnapshotIndex(target: string): Promise<number> {
  const t0 = Date.now()
  const res = await runGit(['-C', target, 'update-index', '-q', '--refresh'])
  if (res.code !== 0) {
    logger.warn('[config-provider] index refresh after snapshot activation failed', { stderr: res.stderr.slice(0, 200) })
  }
  return Date.now() - t0
}

/**
 * Import the blob pack into the activated workspace through
 * `git index-pack --stdin`, hashing the stream on the way. index-pack
 * validates every object it writes; the digest check guards against the
 * wrong pack. Marks the imported pack promisor like the boot pack. Retries
 * transient failures; a refused (expired) URL re-fetches the descriptor once
 * per attempt. Returns a summary — never throws: a failed hydration leaves a
 * valid partial clone that fetches blobs lazily through the proxy.
 */
export async function hydrateProjectSnapshotBlobs(
  cfg: Config,
  target: string,
  descriptor: ProjectSnapshotDescriptor,
  options: S3ProviderOptions & { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<SnapshotHydrationSummary> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? DEFAULT_HYDRATION_TIMEOUT_MS
  const packDir = join(target, '.git', 'objects', 'pack')
  let current = descriptor
  let attempts = 0
  let bytes = 0
  let lastError: ConfigProviderError | null = null
  while (attempts < HYDRATION_MAX_ATTEMPTS) {
    attempts += 1
    if (options.signal?.aborted) {
      lastError = new ConfigProviderError('hydrate', 'cancelled', 'hydration cancelled', attempts)
      break
    }
    const child = spawn('git', ['-C', target, 'index-pack', '--stdin'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    child.stdin.on('error', () => {})
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal }))
      child.on('error', () => resolve({ code: -1, signal: null }))
    })
    const packSum = () => stdout.match(/^pack\t([0-9a-f]{40,64})/m)?.[1] ?? null
    try {
      const streamed = await streamObject(
        current.blobs.url,
        { bytes: current.blobs.bytes, sha256: current.blobs.sha256 },
        { sink: child.stdin },
        {
          fetchImpl: options.fetchImpl,
          signal: options.signal,
          timeoutMs,
          inactivityTimeoutMs: options.inactivityTimeoutMs,
          accept: 'application/x-git-pack',
          stage: 'hydrate',
          digestStage: 'hydrate',
        },
      )
      bytes = streamed.received
      const exit = await exited
      const sum = packSum()
      if (exit.code !== 0 || !sum) {
        throw new ConfigProviderError('hydrate', 'malformed', `git index-pack exited ${exit.code}: ${stderr.trim().slice(0, 300)}`)
      }
      await writeFile(join(packDir, `pack-${sum}.promisor`), '')
      return { status: 'ok', attempts, bytes, ms: Date.now() - started, reason: null, error: null }
    } catch (err) {
      child.kill('SIGKILL')
      await exited
      // A pack index-pack finished writing from the WRONG bytes is valid git
      // data from another object; drop it rather than keep a stray.
      const sum = packSum()
      if (sum) {
        for (const ext of ['pack', 'idx', 'promisor', 'rev']) await rm(join(packDir, `pack-${sum}.${ext}`), { force: true }).catch(() => {})
      }
      const failure =
        err instanceof ConfigProviderError ? err : new ConfigProviderError('hydrate', 'unavailable', errorMessage(err), attempts, { cause: err })
      lastError = new ConfigProviderError(failure.stage, failure.reason, failure.message, attempts, { cause: failure.cause ?? failure })
      if (failure.reason === 'cancelled') break
      if (failure.reason === 'expired-authorization' && attempts < HYDRATION_MAX_ATTEMPTS) {
        try {
          current = await fetchProjectSnapshotDescriptor(cfg, descriptor.commit_sha, { fetchImpl: options.fetchImpl, signal: options.signal })
          continue
        } catch (refetch) {
          lastError = refetch instanceof ConfigProviderError ? refetch : lastError
          break
        }
      }
      if (!failure.retryable || attempts >= HYDRATION_MAX_ATTEMPTS) break
      const backoff = 500 * 2 ** (attempts - 1) + Math.floor(Math.random() * 250)
      logger.warn('[config-provider] hydration attempt failed; retrying', {
        attempt: attempts,
        reason: failure.reason,
        backoffMs: backoff,
        error: failure.message.slice(0, 200),
      })
      await new Promise((r) => setTimeout(r, backoff))
    }
  }
  return {
    status: 'failed',
    attempts,
    bytes,
    ms: Date.now() - started,
    reason: lastError?.reason ?? 'unavailable',
    error: (lastError?.message ?? 'hydration failed').slice(0, 300),
  }
}
