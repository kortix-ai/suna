/**
 * Stream one pinned repository snapshot into a private staging directory.
 *
 * Pipeline, with backpressure and cancellation across every stage:
 *
 *   authenticated object response
 *     -> compressed-byte counter + SHA-256
 *     -> decompressor (gzip | zstd)
 *     -> bounded TAR extractor
 *     -> fresh, private staging directory on the workspace filesystem
 *     -> full verification + local session Git setup
 *     -> atomic activation (the caller's swapStageIntoTarget)
 *
 * Extraction STARTS before the response ends; activation happens only after the
 * whole-object digest matches. Files may exist on disk before they are trusted;
 * they can never become the live workspace before verification passes.
 *
 * The descriptor's URL carries a credential in its query string. It is never
 * logged and the Kortix bearer token is never forwarded to object storage.
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import * as tar from 'tar'

import { createDecompressor } from './snapshot-codec'

import type { Config } from './config'
import { logger } from './logger'

export const REPO_SNAPSHOT_FORMAT = 'kortix.project-snapshot.v1'
export const REPO_SNAPSHOT_EMBEDDED_MANIFEST = '.git/kortix-project-snapshot.json'

/** Hard ceilings. A descriptor may lower them; it may never raise them. */
const MAX_COMPRESSED_BYTES = 512 * 1024 * 1024
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024
const MAX_ENTRY_BYTES = 512 * 1024 * 1024
const MAX_ENTRY_COUNT = 500_000
const TRANSFER_TIMEOUT_MS = 180_000
const GIT_CHECK_TIMEOUT_MS = 20_000
const MAX_ATTEMPTS = 3

/**
 * Verification Git invocations run with the repository's smudge filters
 * DISABLED.
 *
 * `.gitattributes` is archive-supplied content and a filter is a command, so
 * letting `git status` run one here would execute code the archive chose — the
 * same thing the hook check below refuses. It is also what makes an LFS
 * repository unverifiable on an image with no `git-lfs`: the status call fails
 * with "git-lfs: command not found" and a perfectly good snapshot is rejected.
 *
 * This is scoped to VERIFICATION. The session's own Git, and the agent's, read
 * the repository config normally afterwards, so LFS behaves exactly as it does
 * on the clone path.
 */
const VERIFY_GIT_FILTER_OVERRIDES = [
  '-c', 'filter.lfs.required=false',
  '-c', 'filter.lfs.smudge=cat',
  '-c', 'filter.lfs.clean=cat',
  '-c', 'filter.lfs.process=',
]

export type RepoSnapshotCompression = 'gzip' | 'zstd'

export interface RepoSnapshotDescriptor {
  url: string
  /**
   * `bearer` tells the daemon to attach its Kortix session token. It is only
   * ever honoured for a URL on the control plane's own origin — object storage
   * must never receive a Kortix credential, whatever a descriptor claims.
   */
  auth?: 'bearer' | 'none'
  /** Control-plane origin the bearer may be sent to. */
  apiOrigin?: string
  sha256: string
  compression: RepoSnapshotCompression
  commitSha: string
  repositoryId: string
  compressedBytes?: number
  expandedBytes?: number
  entryCount?: number
}

export interface RepoSnapshotMetrics {
  bytes: number
  expandedBytes: number
  entryCount: number
  compression: RepoSnapshotCompression
  /** Wall time from request to the last response byte. */
  transferMs: number
  /** Wall time from the first response byte to extractor completion. */
  extractMs: number
  /** Proof that extraction overlapped the download rather than following it. */
  firstEntryAtMs: number
  verifyMs: number
  sha256: string
  commitSha: string
  attempts: number
}

export class RepoSnapshotError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message)
    this.name = 'RepoSnapshotError'
  }
}

const SHA_RE = /^[0-9a-f]{40}$/
const SHA256_RE = /^[0-9a-f]{64}$/
const REPOSITORY_ID_RE = /^[0-9]{1,20}$/

/** Read the pinned descriptor out of the session environment. */
export function readRepoSnapshotDescriptor(cfg: Config): RepoSnapshotDescriptor | null {
  const url = (cfg.repoSnapshotUrl ?? '').trim()
  const sha256 = (cfg.repoSnapshotSha256 ?? '').trim().toLowerCase()
  const commitSha = (cfg.repoSnapshotCommitSha ?? '').trim().toLowerCase()
  const repositoryId = (cfg.repoSnapshotRepositoryId ?? '').trim()
  const compression = cfg.repoSnapshotCompression
  if (!url || !sha256 || !commitSha || !repositoryId || !compression) return null
  if (!SHA256_RE.test(sha256)) throw new RepoSnapshotError('descriptor sha256 is invalid', 'bad_descriptor', false)
  if (!SHA_RE.test(commitSha)) throw new RepoSnapshotError('descriptor commit sha is invalid', 'bad_descriptor', false)
  if (!REPOSITORY_ID_RE.test(repositoryId)) {
    throw new RepoSnapshotError('descriptor repository id is invalid', 'bad_descriptor', false)
  }
  let apiOrigin: string | undefined
  try {
    apiOrigin = cfg.apiUrl ? new URL(cfg.apiUrl).origin : undefined
  } catch {
    apiOrigin = undefined
  }
  return {
    url,
    auth: cfg.repoSnapshotAuth ?? 'none',
    apiOrigin,
    sha256,
    compression,
    commitSha,
    repositoryId,
    compressedBytes: cfg.repoSnapshotCompressedBytes,
    expandedBytes: cfg.repoSnapshotExpandedBytes,
    entryCount: cfg.repoSnapshotEntryCount,
  }
}

/**
 * Headers for the archive request.
 *
 * The bearer is attached ONLY when the descriptor asks for it AND the URL is on
 * the control plane's own origin. A descriptor that says `bearer` for a
 * third-party host is refused rather than honoured: that is the shape a stolen
 * or tampered descriptor would take, and the cost of getting it wrong is the
 * session credential.
 */
export function archiveRequestHeaders(
  descriptor: RepoSnapshotDescriptor,
  token: string | undefined,
): Record<string, string> {
  if (descriptor.auth !== 'bearer') return {}
  if (!token) throw new RepoSnapshotError('snapshot descriptor requires a bearer but none is configured', 'bad_descriptor', false)
  let host: string
  try {
    host = new URL(descriptor.url).origin
  } catch {
    throw new RepoSnapshotError('snapshot descriptor url is not a valid URL', 'bad_descriptor', false)
  }
  if (!descriptor.apiOrigin || host !== descriptor.apiOrigin) {
    throw new RepoSnapshotError(
      `refusing to send the Kortix token to ${host}; bearer delivery is only valid for the control plane`,
      'bad_descriptor',
      false,
    )
  }
  return { authorization: `Bearer ${token}` }
}

/** Strip credentials and query from a URL so it can safely reach a log line. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '(unparseable url)'
  }
}

/**
 * Reject every TAR entry that could write outside the staging directory, carry
 * privilege, or represent something a Git checkout cannot contain.
 *
 * Returns null when the entry is acceptable, or the reason it is not. node-tar
 * sanitizes some of these on its own; a snapshot that contains one is a broken
 * or hostile archive, so it fails the whole materialization instead of being
 * quietly normalized.
 */
export function unsafeEntryReason(entry: {
  path: string
  type: string
  mode?: number
  linkpath?: string | null
}): string | null {
  const path = entry.path
  if (!path || path === '.' || path === './') return null
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) return `absolute path: ${path}`
  if (path.includes('\0')) return 'path contains a NUL byte'
  const segments = path.split('/')
  if (segments.some((s) => s === '..')) return `path escapes the archive root: ${path}`
  if (path.startsWith('..')) return `path escapes the archive root: ${path}`

  switch (entry.type) {
    case 'File':
    case 'Directory':
    case 'SymbolicLink':
    case 'GNULongName':
    case 'GNULongLinkPath':
    case 'ExtendedHeader':
    case 'OldExtendedHeader':
    case 'NextFileHasLongName':
    case 'NextFileHasLongLinkpath':
      break
    case 'Link':
      // A hard link inside the archive is legal TAR but has no counterpart in a
      // Git checkout, and its target resolution is a second escape surface.
      return `hard links are not allowed: ${path}`
    default:
      return `unsupported entry type ${entry.type}: ${path}`
  }

  if (typeof entry.mode === 'number' && (entry.mode & 0o7000) !== 0) {
    return `privileged mode ${entry.mode.toString(8)}: ${path}`
  }

  if (entry.type === 'SymbolicLink') {
    const target = entry.linkpath ?? ''
    if (!target) return `symlink with no target: ${path}`
    if (target.startsWith('/') || /^[A-Za-z]:[\\/]/.test(target)) {
      return `symlink escapes staging (absolute): ${path} -> ${target}`
    }
    // Resolve the link relative to its own directory and require the result to
    // stay inside the archive root. `a/b -> ../c` is fine; `a/b -> ../../c` is not.
    const dir = segments.slice(0, -1)
    const resolved: string[] = [...dir]
    for (const part of target.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') {
        if (resolved.length === 0) return `symlink escapes staging: ${path} -> ${target}`
        resolved.pop()
        continue
      }
      resolved.push(part)
    }
  }
  return null
}

interface ExtractOutcome {
  entryCount: number
  firstEntryAtMs: number
}

/**
 * Download, decompress and extract in one pass.
 *
 * Every failure aborts the whole pipeline: the fetch is cancelled, the
 * decompressor and extractor are destroyed, and the caller removes only this
 * attempt's staging directory.
 */
async function streamIntoStage(
  descriptor: RepoSnapshotDescriptor,
  stage: string,
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): Promise<{ bytes: number; expandedBytes: number; sha256: string; transferMs: number } & ExtractOutcome> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TRANSFER_TIMEOUT_MS)
  const started = Date.now()
  try {
    // Presigned delivery sends NO credential: object storage authenticates the
    // URL itself, and forwarding a session token to a third-party host would
    // hand it to whoever answers. Proxy delivery sends the bearer, and only
    // after `archiveRequestHeaders` has proved the URL is the control plane's.
    const response = await fetchImpl(descriptor.url, {
      headers,
      signal: controller.signal,
    })
    if (!response.ok) {
      const retryable = response.status === 403 || response.status === 408 || response.status >= 500
      throw new RepoSnapshotError(
        `snapshot HTTP ${response.status} for ${redactUrl(descriptor.url)}`,
        response.status === 403 ? 'expired_capability' : `http_${response.status}`,
        retryable,
      )
    }
    if (!response.body) throw new RepoSnapshotError('snapshot response has no body', 'empty_body', true)

    const compressedLimit = Math.min(descriptor.compressedBytes ?? MAX_COMPRESSED_BYTES, MAX_COMPRESSED_BYTES)
    const expandedLimit = Math.min(descriptor.expandedBytes ?? MAX_EXPANDED_BYTES, MAX_EXPANDED_BYTES)
    const entryLimit = Math.min(descriptor.entryCount ?? MAX_ENTRY_COUNT, MAX_ENTRY_COUNT)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > compressedLimit) {
      throw new RepoSnapshotError(
        `snapshot declares ${declared} bytes over the ${compressedLimit} limit`,
        'too_large',
        false,
      )
    }

    const hash = createHash('sha256')
    let bytes = 0
    const digest = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        if (bytes > compressedLimit) {
          callback(new RepoSnapshotError(`snapshot exceeds ${compressedLimit} compressed bytes`, 'too_large', false))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      },
    })

    let expandedBytes = 0
    const expansion = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        expandedBytes += chunk.length
        if (expandedBytes > expandedLimit) {
          callback(new RepoSnapshotError(`snapshot expands past ${expandedLimit} bytes`, 'too_large', false))
          return
        }
        callback(null, chunk)
      },
    })

    let entryCount = 0
    let firstEntryAtMs = -1
    let rejection: RepoSnapshotError | null = null
    // A repeated path means the LAST copy silently wins on disk, so an archive
    // can ship a benign file and then overwrite it. A well-formed snapshot
    // never contains one.
    const seenPaths = new Set<string>()
    const extractor = tar.x({
      cwd: stage,
      // Reject rather than sanitize: node-tar strips leading `/` and `..` with a
      // warning, which would turn a hostile archive into a silently different
      // checkout instead of a failure.
      preservePaths: false,
      strip: 0,
      // Ownership comes from the runtime user, never from the archive.
      noChmod: false,
      portable: true,
      filter: (path, entry) => {
        const reason = unsafeEntryReason({
          path,
          type: String((entry as { type?: unknown }).type ?? 'File'),
          mode: (entry as { mode?: number }).mode,
          linkpath: (entry as { linkpath?: string | null }).linkpath ?? null,
        })
        if (reason && !rejection) {
          rejection = new RepoSnapshotError(`unsafe archive entry — ${reason}`, 'unsafe_entry', false)
        }
        return !reason
      },
      onReadEntry: (entry) => {
        if (firstEntryAtMs < 0) firstEntryAtMs = Date.now() - started
        entryCount += 1
        const normalized = String(entry.path).replace(/\/+$/, '')
        if (seenPaths.has(normalized)) {
          rejection ??= new RepoSnapshotError(
            `archive contains a duplicate entry: ${normalized}`,
            'duplicate_entry',
            false,
          )
        }
        seenPaths.add(normalized)
        if (entryCount > entryLimit) {
          rejection ??= new RepoSnapshotError(`snapshot exceeds ${entryLimit} entries`, 'too_many_entries', false)
        }
        const size = (entry as { size?: number }).size ?? 0
        if (size > MAX_ENTRY_BYTES) {
          rejection ??= new RepoSnapshotError(
            `archive entry ${entry.path} exceeds ${MAX_ENTRY_BYTES} bytes`,
            'entry_too_large',
            false,
          )
        }
      },
    })

    await pipeline(
      Readable.fromWeb(response.body as never),
      digest,
      createDecompressor(descriptor.compression),
      expansion,
      extractor,
    )
    // A filter rejection makes node-tar SKIP the entry rather than fail, which
    // would leave an incomplete checkout looking successful.
    if (rejection) throw rejection

    return {
      bytes,
      expandedBytes,
      sha256: hash.digest('hex'),
      transferMs: Date.now() - started,
      entryCount,
      firstEntryAtMs: firstEntryAtMs < 0 ? Date.now() - started : firstEntryAtMs,
    }
  } catch (error) {
    if (error instanceof RepoSnapshotError) throw error
    const message = error instanceof Error ? error.message : String(error)
    if (/aborted|timeout|ECONNRESET|socket hang up|fetch failed|terminated/i.test(message)) {
      throw new RepoSnapshotError(`snapshot transfer failed: ${message}`, 'transfer_failed', true)
    }
    // A corrupt gzip/zstd stream or malformed TAR is never retried into success
    // against the same immutable object.
    throw new RepoSnapshotError(`snapshot stream is unusable: ${message}`, 'corrupt_archive', false)
  } finally {
    clearTimeout(timeout)
  }
}

function runProcess(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      stderr += `\nprocess exceeded ${timeoutMs}ms`
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${command} failed: ${stderr.trim() || `exit ${code}`}`))
    })
  })
}

/**
 * Prove the extracted tree IS the pinned revision before anything may use it.
 *
 * The embedded manifest is archive-supplied and therefore untrusted on its own;
 * it only becomes meaningful once the whole-object digest has already matched
 * the descriptor the API authenticated.
 */
async function verifyStage(stage: string, descriptor: RepoSnapshotDescriptor): Promise<void> {
  let raw: string
  try {
    raw = await readFile(`${stage}/${REPO_SNAPSHOT_EMBEDDED_MANIFEST}`, 'utf8')
  } catch {
    throw new RepoSnapshotError('snapshot archive has no embedded manifest', 'missing_manifest', false)
  }
  let manifest: { format?: string; source?: Record<string, unknown> }
  try {
    manifest = JSON.parse(raw)
  } catch {
    throw new RepoSnapshotError('embedded manifest is not valid JSON', 'bad_manifest', false)
  }
  const source = manifest.source ?? {}
  if (
    manifest.format !== REPO_SNAPSHOT_FORMAT ||
    String(source.commit_sha) !== descriptor.commitSha ||
    String(source.repository_id) !== descriptor.repositoryId
  ) {
    throw new RepoSnapshotError('snapshot identity does not match the pinned revision', 'identity_mismatch', false)
  }
  // Never execute archive-supplied code: no hooks, no filters, no includes.
  const hooks = await lstat(`${stage}/.git/hooks`).catch(() => null)
  if (hooks) throw new RepoSnapshotError('snapshot archive carries Git hooks', 'unsafe_archive', false)

  const head = await runProcess(
    'git',
    ['-C', stage, ...VERIFY_GIT_FILTER_OVERRIDES, 'rev-parse', '--verify', 'HEAD'],
    GIT_CHECK_TIMEOUT_MS,
  )
  if (head.stdout.trim() !== descriptor.commitSha) {
    throw new RepoSnapshotError(
      `snapshot HEAD is ${head.stdout.trim() || 'unreadable'}, expected ${descriptor.commitSha}`,
      'head_mismatch',
      false,
    )
  }
  const status = await runProcess(
    'git',
    ['-C', stage, ...VERIFY_GIT_FILTER_OVERRIDES, 'status', '--porcelain'],
    GIT_CHECK_TIMEOUT_MS,
  )
  if (status.stdout.trim() !== '') {
    throw new RepoSnapshotError('snapshot working tree is not clean after extraction', 'dirty_checkout', false)
  }
}

export interface MaterializeOptions {
  fetchImpl?: typeof fetch
  /** Built by `archiveRequestHeaders`; empty for presigned delivery. */
  headers?: Record<string, string>
  /** Re-authorize with the control plane when the object capability expired. */
  refreshDescriptor?: () => Promise<RepoSnapshotDescriptor | null>
  maxAttempts?: number
}

/**
 * Materialize the pinned snapshot into `stage`. On any failure the stage is
 * left for the caller to remove; a previously valid workspace is never touched.
 */
export async function materializeRepoSnapshotToStage(
  descriptorInput: RepoSnapshotDescriptor,
  stage: string,
  options: MaterializeOptions = {},
): Promise<RepoSnapshotMetrics> {
  const fetchImpl = options.fetchImpl ?? fetch
  const maxAttempts = Math.max(1, options.maxAttempts ?? MAX_ATTEMPTS)
  let descriptor = descriptorInput
  let lastError: RepoSnapshotError | null = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Every attempt starts from a FRESH staging directory: a half-extracted
    // tree from a failed attempt must never be mistaken for a complete one.
    await rm(stage, { recursive: true, force: true })
    await mkdir(stage, { recursive: true, mode: 0o755 })
    try {
      const streamed = await streamIntoStage(descriptor, stage, fetchImpl, options.headers ?? {})
      if (streamed.sha256 !== descriptor.sha256) {
        throw new RepoSnapshotError(
          `snapshot digest mismatch: expected ${descriptor.sha256}, got ${streamed.sha256}`,
          'digest_mismatch',
          false,
        )
      }
      const verifyStarted = Date.now()
      await verifyStage(stage, descriptor)
      return {
        bytes: streamed.bytes,
        expandedBytes: streamed.expandedBytes,
        entryCount: streamed.entryCount,
        compression: descriptor.compression,
        transferMs: streamed.transferMs,
        extractMs: streamed.transferMs - streamed.firstEntryAtMs,
        firstEntryAtMs: streamed.firstEntryAtMs,
        verifyMs: Date.now() - verifyStarted,
        sha256: streamed.sha256,
        commitSha: descriptor.commitSha,
        attempts: attempt,
      }
    } catch (error) {
      const failure =
        error instanceof RepoSnapshotError
          ? error
          : new RepoSnapshotError(
              error instanceof Error ? error.message : String(error),
              'unknown',
              false,
            )
      lastError = failure
      await rm(stage, { recursive: true, force: true }).catch(() => {})
      if (!failure.retryable || attempt === maxAttempts) break
      if (failure.code === 'expired_capability' && options.refreshDescriptor) {
        const refreshed = await options.refreshDescriptor().catch(() => null)
        // A refreshed capability must still name the SAME revision. Retries are
        // bound to the pinned SHA; a newer tip requires a new binding.
        if (
          refreshed &&
          refreshed.commitSha === descriptor.commitSha &&
          refreshed.sha256 === descriptor.sha256 &&
          refreshed.repositoryId === descriptor.repositoryId
        ) {
          descriptor = refreshed
        }
      }
      logger.warn('[repo-snapshot] attempt failed; retrying', {
        attempt,
        maxAttempts,
        code: failure.code,
        url: redactUrl(descriptor.url),
      })
      await new Promise((resolve) => setTimeout(resolve, 300 * attempt + Math.floor(Math.random() * 400)))
    }
  }
  throw lastError ?? new RepoSnapshotError('snapshot materialization failed', 'unknown', false)
}

/**
 * Ask the control plane for a fresh object capability for the SAME revision.
 * This is the only Kortix-authenticated call in the transport path, and it
 * never triggers a build.
 */
export function buildDescriptorRefresher(cfg: Config, descriptor: RepoSnapshotDescriptor) {
  return async (): Promise<RepoSnapshotDescriptor | null> => {
    if (!cfg.apiUrl || !cfg.projectId || !cfg.sandboxToken) return null
    const base = cfg.apiUrl.replace(/\/+$/, '')
    const url = `${base}/git/${encodeURIComponent(cfg.projectId)}/repo-snapshot?sha=${descriptor.commitSha}`
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${cfg.sandboxToken}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
    if (!response.ok) return null
    const body = (await response.json()) as Record<string, unknown>
    const refreshed: RepoSnapshotDescriptor = {
      url: String(body.url ?? ''),
      sha256: String(body.sha256 ?? ''),
      compression: (body.compression === 'zstd' ? 'zstd' : 'gzip') as RepoSnapshotCompression,
      commitSha: String(body.commit_sha ?? ''),
      repositoryId: String(body.repository_id ?? ''),
      compressedBytes: typeof body.compressed_bytes === 'number' ? body.compressed_bytes : undefined,
      expandedBytes: typeof body.expanded_bytes === 'number' ? body.expanded_bytes : undefined,
      entryCount: typeof body.entry_count === 'number' ? body.entry_count : undefined,
    }
    return refreshed.url && SHA256_RE.test(refreshed.sha256) ? refreshed : null
  }
}
