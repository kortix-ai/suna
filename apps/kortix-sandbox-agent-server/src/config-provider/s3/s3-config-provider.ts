/**
 * S3 transport: streaming, verified acquisition of a PREPARED project snapshot
 * archive into a private stage directory under the project target.
 *
 *   descriptor (Git proxy, KORTIX_TOKEN)  →  presigned GET (no credential)
 *   → compressed-byte SHA-256 + byte cap  →  gunzip  →  safe TAR extraction
 *   → verify marker / .git/config / HEAD  →  (coordinator) activate
 *
 * Download and extraction OVERLAP: bytes flow from the socket through the
 * hasher into the decompressor and the extractor as they arrive. The archive
 * is never buffered and never written to disk as a whole.
 *
 * The sandbox env carries only the archive IDENTITY (KORTIX_PROJECT_SNAPSHOT_PIN
 * = sha:sha256:bytes). The download URL is minted per boot by the API and
 * expires in minutes, so no bucket credential ever reaches the box.
 *
 * Every failure is classified (see types.ts); the coordinator decides whether
 * it falls back. This module never falls back and never touches the live
 * workspace — a failed attempt removes its own stage and nothing else.
 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { Readable, Transform } from 'node:stream'
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
} from '../types'

export const PROJECT_SNAPSHOT_FORMAT = 'project-snapshot-v1'
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

export interface ProjectSnapshotDescriptor {
  format: typeof PROJECT_SNAPSHOT_FORMAT
  commit_sha: string
  ref: string
  repository: { owner: string; name: string; external_id: string }
  archive: { url: string; sha256: string; bytes: number; entries: number; expires_at: string }
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

// ── Descriptor ──────────────────────────────────────────────────────────────

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
    throw new ConfigProviderError('descriptor', reason, `descriptor request failed: ${(err as Error)?.message ?? String(err)}`, 0, { cause: err })
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
    typeof body.archive?.url !== 'string' ||
    !SHA256_RE.test(body.archive?.sha256 ?? '') ||
    !Number.isInteger(body.archive?.bytes) ||
    body.archive.bytes <= 0 ||
    typeof body.repository?.external_id !== 'string'
  ) {
    throw new ConfigProviderError('descriptor', 'malformed', 'descriptor does not describe the expected archive')
  }
  return body
}

// ── Download + extract ──────────────────────────────────────────────────────

type TarEntryLike = { type: string; linkpath?: string; size?: number }

/** Normalize a tar member path: strip `./` prefixes; '' means the archive root. */
function normalizeEntryPath(raw: string): string {
  let p = raw.replace(/\\/g, '/')
  while (p.startsWith('./')) p = p.slice(2)
  if (p === '.') p = ''
  return p.replace(/\/+$/, '')
}

/**
 * The archive contract, enforced entry by entry BEFORE anything is written:
 * relative paths only, no `..`, files / directories / in-tree symlinks only,
 * no hooks, no duplicates, bounded count and size. node-tar's own `strict`
 * checks (path escape, link escape, depth) run on top.
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

function isDecompressionError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? ''
  return code.startsWith('Z_') || /incorrect header check|invalid (block|distance|stored)|unexpected end of file|zlib/i.test((err as Error)?.message ?? '')
}

function isTarError(err: unknown): boolean {
  const code = (err as { code?: string })?.code ?? ''
  return code.startsWith('TAR_') || /tar/i.test((err as { name?: string })?.name ?? '')
}

export interface DownloadedSnapshot {
  bytes: number
  entries: number
  downloadMs: number
  extractMs: number
}

/**
 * Stream the presigned archive through hash → gunzip → tar into `stage`.
 * Rejects with a classified ConfigProviderError; the caller removes the stage.
 */
export async function downloadAndExtractProjectSnapshot(
  descriptor: ProjectSnapshotDescriptor,
  stage: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs: number; inactivityTimeoutMs?: number },
): Promise<DownloadedSnapshot> {
  const expectedBytes = descriptor.archive.bytes
  const inactivityMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS
  const link = linkedSignal(options.signal, options.timeoutMs)
  const started = Date.now()
  let res: Response
  try {
    // No Authorization header: the URL IS the authorization, and the object
    // store would reject a foreign credential anyway.
    res = await (options.fetchImpl ?? fetch)(descriptor.archive.url, {
      headers: { accept: 'application/gzip' },
      signal: link.signal,
      redirect: 'error',
    })
  } catch (err) {
    link.dispose()
    const reason = isAbortError(err) ? abortReason(options, link.timedOut()) : 'unavailable'
    throw new ConfigProviderError('download', reason, `archive request failed: ${(err as Error)?.message ?? String(err)}`, 0, { cause: err })
  }
  try {
    if (res.status === 403) {
      throw new ConfigProviderError('download', 'expired-authorization', 'archive download authorization was refused (HTTP 403)')
    }
    if (res.status === 404) throw new ConfigProviderError('download', 'missing', 'archive object not found (HTTP 404)')
    if (!res.ok) throw new ConfigProviderError('download', 'unavailable', `archive HTTP ${res.status}`)
    if (!res.body) throw new ConfigProviderError('download', 'unavailable', 'archive response has no body')
    const declared = Number(res.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > 0 && declared !== expectedBytes) {
      throw new ConfigProviderError('download', declared > expectedBytes ? 'limit-exceeded' : 'digest-mismatch', `archive content-length ${declared} != expected ${expectedBytes}`)
    }

    await mkdir(stage, { recursive: true })
    const hash = createHash('sha256')
    let received = 0
    let firstByteAt = 0
    const guard = makeEntryGuard({
      maxEntries: Math.max(descriptor.archive.entries, 0) + ENTRY_SLACK,
      maxBytes: MAX_UNCOMPRESSED_BYTES,
    })
    let violation: ConfigProviderError | null = null

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
          callback(new ConfigProviderError('download', 'limit-exceeded', `archive exceeds declared ${expectedBytes} bytes`))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })
    const gunzip = createGunzip()
    const unpack = tar.x({
      cwd: stage,
      strict: true,
      preservePaths: false,
      // Owner/mode metadata in the archive is the producer's, never this box's.
      preserveOwner: false,
      filter: (path, entry) => {
        if (violation) return false
        const problem = guard.check(path, entry as unknown as TarEntryLike)
        if (problem) {
          violation = new ConfigProviderError('extract', problem.startsWith('entry count') || problem.startsWith('uncompressed size') ? 'limit-exceeded' : 'malformed', `unsafe archive entry: ${problem}`)
          unpack.abort(violation)
          return false
        }
        return true
      },
    }) as unknown as NodeJS.WritableStream & { abort: (err: Error) => void; on: (ev: string, fn: (...a: unknown[]) => void) => unknown }

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (stage: S3Stage, err: unknown) => {
        if (settled) return
        settled = true
        if (watchdog) clearTimeout(watchdog)
        source.destroy()
        if (violation) return reject(violation)
        if (err instanceof ConfigProviderError) return reject(err)
        if (isAbortError(err) || link.signal.aborted) {
          return reject(new ConfigProviderError(stage, abortReason(options, link.timedOut()), `archive transfer aborted: ${(err as Error)?.message ?? ''}`, 0, { cause: err }))
        }
        if (isDecompressionError(err) || isTarError(err)) {
          return reject(new ConfigProviderError('extract', 'malformed', `archive is not a valid gzip tar: ${(err as Error)?.message ?? String(err)}`, 0, { cause: err }))
        }
        reject(new ConfigProviderError(stage, 'unavailable', `archive transfer failed: ${(err as Error)?.message ?? String(err)}`, 0, { cause: err }))
      }
      const done = () => {
        if (settled) return
        settled = true
        if (watchdog) clearTimeout(watchdog)
        resolve()
      }
      onInactivity = () =>
        fail('download', new ConfigProviderError('download', 'unavailable', `archive transfer stalled: no bytes for ${inactivityMs}ms`))
      armWatchdog()
      source.on('error', (err) => fail('download', err))
      hasher.on('error', (err) => fail('download', err))
      gunzip.on('error', (err) => fail('extract', err))
      unpack.on('error', (err) => fail('extract', err))
      unpack.on('end', done)
      unpack.on('finish', done)
      link.signal.addEventListener('abort', () => fail('download', link.signal.reason), { once: true })
      source.pipe(hasher).pipe(gunzip).pipe(unpack)
    })
    const finishedAt = Date.now()
    if (received < expectedBytes) {
      // A clean EOF short of the declared size is a truncated transfer, not a
      // bad archive: transient, so the attempt is retried.
      throw new ConfigProviderError('download', 'unavailable', `archive transfer ended after ${received} of ${expectedBytes} bytes`)
    }
    const digest = hash.digest('hex')
    if (received !== expectedBytes || digest !== descriptor.archive.sha256) {
      throw new ConfigProviderError('verify', 'digest-mismatch', `archive digest/size mismatch: got ${digest}/${received}, expected ${descriptor.archive.sha256}/${expectedBytes}`)
    }
    return {
      bytes: received,
      entries: guard.counts().entries,
      downloadMs: finishedAt - started,
      extractMs: firstByteAt ? finishedAt - firstByteAt : 0,
    }
  } finally {
    link.dispose()
  }
}

// ── Verify ──────────────────────────────────────────────────────────────────

const GIT_CONFIG_FORBIDDEN_RE =
  /^\s*\[(remote|credential|include|includeif|filter|url)\b|^\s*(hookspath|fsmonitor|sshcommand|askpass|gitproxy|pager|editor)\s*=/im

/**
 * The extracted stage must be the exact revision the pin named, and its `.git`
 * must not be able to run anything: no hooks (rejected at extraction), no
 * filters / remotes / includes in `.git/config`. Only plumbing (`rev-parse`)
 * touches the stage before activation.
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

/**
 * Acquire the pinned archive into a fresh stage. Retries transient failures
 * with jittered backoff inside `req.deadlineMs`; returns the verified stage.
 * Never activates, never falls back, never leaves a stage behind on failure.
 */
export async function materializeFromS3(
  req: MaterializeRequest,
  options: { fetchImpl?: typeof fetch; inactivityTimeoutMs?: number } = {},
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
      if (descriptor.archive.sha256 !== pin.sha256 || descriptor.archive.bytes !== pin.bytes) {
        throw new ConfigProviderError('descriptor', 'revision-mismatch', 'descriptor names a different archive than the session pin')
      }
      const downloaded = await downloadAndExtractProjectSnapshot(descriptor, stage, {
        fetchImpl: options.fetchImpl,
        signal: req.signal,
        timeoutMs: Math.max(1_000, deadline - Date.now()),
        inactivityTimeoutMs: options.inactivityTimeoutMs,
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
        },
      }
    } catch (err) {
      await rm(stage, { recursive: true, force: true }).catch(() => {})
      const failure =
        err instanceof ConfigProviderError
          ? err
          : new ConfigProviderError('extract', 'unavailable', (err as Error)?.message ?? String(err), attempts, { cause: err })
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
