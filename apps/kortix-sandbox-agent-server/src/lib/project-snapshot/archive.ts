import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { dirname, posix } from 'node:path'
import { createGunzip } from 'node:zlib'
import * as tar from 'tar'

import { logger } from '../log/logger'
import type { ProjectSnapshotDescriptor } from './contract'
import { ProjectSnapshotError, errorMessage, type S3FailureReason } from './errors'
import { streamObject, type StreamedObject } from './transfer'

/** Extraction guard: the sum of entry sizes may not exceed this (tar bomb). */
const MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024 * 1024

/** Extraction guard: entries beyond the descriptor's count (+ slack) are refused. */
const ENTRY_SLACK = 1_024

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

function guardViolationError(problem: string): ProjectSnapshotError {
  const reason: S3FailureReason =
    problem.startsWith('entry count') || problem.startsWith('uncompressed size') ? 'limit-exceeded' : 'malformed'
  return new ProjectSnapshotError('extract', reason, `unsafe archive entry: ${problem}`)
}

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
function entryLimit(descriptor: Pick<ProjectSnapshotDescriptor, 'tree'>): number {
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
      if (options.signal?.aborted) return reject(new ProjectSnapshotError('extract', 'cancelled', 'extraction cancelled'))
      if (signal === 'SIGKILL') return reject(new ProjectSnapshotError('extract', 'timeout', `tar extraction exceeded ${options.timeoutMs}ms`))
      reject(new ProjectSnapshotError('extract', 'malformed', `tar exited ${code}: ${stderr.trim().slice(0, 300)}`))
    })
  })
}

/**
 * Stream the boot object into `<stage>.tgz` (hash, byte cap, watchdog, and the
 * header guard on a tee), verify the digest, then extract into `stage`.
 * Rejects with a classified ProjectSnapshotError; the caller removes the stage.
 */
export async function downloadAndExtractProjectSnapshot(
  descriptor: Pick<ProjectSnapshotDescriptor, 'tree'>,
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
  let violation: ProjectSnapshotError | null = null
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
  // The file sink can finish before the decompressor/parser. Its completion
  // does not prove that the archive guard has inspected every header.
  const guardFinished = new Promise<void>((resolve) => {
    parser.once('end', resolve)
    parser.once('error', () => resolve())
    gunzip.once('error', () => resolve())
  })
  gunzip.pipe(parser)

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
    await guardFinished
    // The bytes ARE the published object (digest verified). Now the guard's
    // verdict on its headers is final, and a decoder error means the object
    // itself is not a valid gzip tar — never a transport problem.
    if (violation) throw violation
    if (decoderError) {
      throw new ProjectSnapshotError('extract', 'malformed', `archive is not a valid gzip tar: ${errorMessage(decoderError)}`, 0, { cause: decoderError })
    }
    const e0 = Date.now()
    await mkdir(stage, { recursive: true })
    const remaining = Math.max(5_000, options.timeoutMs - (Date.now() - t0))
    const binary = options.tarBinary ?? process.env.KORTIX_SNAPSHOT_TAR_BIN ?? 'tar'
    let extractor: 'tar' | 'node-tar' = 'tar'
    if (!(await extractWithSystemTar(binary, file, stage, { signal: options.signal, timeoutMs: remaining }))) {
      logger.warn('[project-snapshot] no usable tar binary; extracting in-process', { binary })
      extractor = 'node-tar'
      await rm(stage, { recursive: true, force: true })
      await mkdir(stage, { recursive: true })
      const again = makeEntryGuard({ maxEntries: entryLimit(descriptor), maxBytes: MAX_UNCOMPRESSED_BYTES })
      let late: ProjectSnapshotError | null = null
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
          throw new ProjectSnapshotError('extract', 'malformed', `archive is not a valid gzip tar: ${errorMessage(err)}`, 0, { cause: err })
        }
        throw new ProjectSnapshotError('extract', 'unavailable', `extraction failed: ${errorMessage(err)}`, 0, { cause: err })
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
