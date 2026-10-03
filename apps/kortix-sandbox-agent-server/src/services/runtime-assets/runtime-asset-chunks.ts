/**
 * Move only the bytes that changed.
 *
 * THE WASTE THIS REMOVES. A changed CLI cost every box a fresh ~105 MB
 * download, of which ~90 MB provably did not change: that prefix is the
 * embedded Bun runtime, byte-identical in every `bun --compile` output we
 * ship. Measured on real linux-x64 builds at 1 MiB fixed chunks — two CLI
 * builds differing only in `KORTIX_CLI_VERSION` share 100 of 102 chunks
 * (98.0%), and the CLI and the daemon share 89 of 102 (87.3%).
 *
 * THE CROSS-ARTIFACT NUMBER IS CONDITIONAL, AND TODAY THE CONDITION DOES NOT
 * HOLD. 87.3% is what two binaries compiled by the SAME Bun share. The shipped
 * API image compiles them with two different ones — `apps/api/Dockerfile`
 * builds the daemon on `SANDBOX_AGENT_BUN_VERSION=1.3.11` (a deliberate pin:
 * Bun 1.2 breaks `Bun.spawn({terminal})`) and the CLI on `BUN_VERSION=1.2`,
 * the API's own runtime. Different runtimes, different bytes: measured against
 * a deployed preview, the two share 0 of 111 chunks, and even their FIRST MiB
 * differs. So cross-artifact reuse is 0% until those two pins agree, and that
 * alignment is its own change with its own risk, not a line in this one. The
 * same-artifact case — a box that holds the previous build of the SAME binary,
 * which is what a CLI update actually is — is unaffected and is where the
 * 98.0% lives.
 *
 * WHERE THE CHUNK STORE IS. There is no chunk cache directory, and adding one
 * would be the wrong shape: the box already holds ~210 MB of chunks in the
 * binaries it RUNS. `/usr/local/bin/kortix`, the running daemon, and the baked
 * floor beside it are the store — always current, never stale, needing no
 * eviction policy, no garbage collection and not one extra byte of disk. One
 * index over all of them serves both components, which is where the
 * cross-artifact 87.3% would come from once the two build stages agree on a
 * Bun version (see above); it costs nothing while they do not.
 *
 * FIXED-SIZE, and a rolling hash is not the next increment. The usual argument
 * for content-defined chunking is that an insertion shifts every later byte out
 * of alignment. It does not here: `bun --compile` pads its output to a fixed
 * length, so a 400-byte source addition to apps/cli produced a 106,727,552-byte
 * binary exactly like the build before it, and moved the same 2 of 102 chunks.
 * There is nothing left for a rolling hash to recover, so there is no reason to
 * carry one.
 *
 * WHAT THIS IS NOT ALLOWED TO DO. It is an optimization and nothing more. The
 * whole-file sha256 from `GET /runtime-assets/manifest` remains the single
 * authority: this function verifies its assembly against it and returns `null`
 * on ANY doubt — an API with no chunk routes, a chunk manifest describing other
 * bytes, a refused chunk, a short read, a digest that does not match. `null`
 * means "use the full download", never "install this anyway".
 */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { logger } from '@/lib/log/logger'

/** What the API serves at `GET /v1/runtime-assets/chunks/{component}`. */
interface ChunkManifest {
  sha256: string
  size: number
  chunk_size: number
  chunks: string[]
}

export interface ChunkedFetchOptions {
  fetchImpl: typeof fetch
  /** `${apiRoot}/runtime-assets`. */
  base: string
  token: string
  component: 'agent' | 'cli'
  /** The digest the digest-manifest advertises. The assembly must match it. */
  expectedSha: string
  /** Files already on this box whose chunks may be reused. Missing ones are skipped. */
  localSources: string[]
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 180_000

/**
 * Below this much reuse a chunked transfer is strictly worse than the plain
 * one: the same bytes, split across one request per chunk. 105 MB in ~100
 * sequential round trips to save 5 MB is not a trade worth making, and the
 * full download is the path that is exercised on every box every day.
 */
const MIN_REUSE_RATIO = 0.1

function isChunkManifest(value: unknown, expectedSha: string): value is ChunkManifest {
  if (!value || typeof value !== 'object') return false
  const m = value as Partial<ChunkManifest>
  if (typeof m.sha256 !== 'string' || m.sha256 !== expectedSha) return false
  if (typeof m.size !== 'number' || !Number.isInteger(m.size) || m.size <= 0) return false
  if (typeof m.chunk_size !== 'number' || !Number.isInteger(m.chunk_size) || m.chunk_size <= 0) {
    return false
  }
  if (!Array.isArray(m.chunks) || m.chunks.length === 0) return false
  if (!m.chunks.every((c) => typeof c === 'string' && /^[0-9a-f]{64}$/.test(c))) return false
  // The manifest decides how many bytes this box will allocate and where each
  // one lands, so its own arithmetic has to hold before any of it is used.
  return m.chunks.length === Math.ceil(m.size / m.chunk_size)
}

/** Where one chunk's bytes already exist on this box. */
interface LocalChunk {
  path: string
  offset: number
  length: number
}

/**
 * Index the binaries this box already runs, chunk by chunk.
 *
 * Read through one reused buffer rather than `readFile`: two ~105 MB sources
 * on the heap is exactly the memory pressure that makes a box abort a turn
 * (the 2026-09-22 page-cache guard incident), and this runs beside a live
 * OpenCode process.
 *
 * The work is O(source_bytes / chunk_size) hashes, and chunk_size comes from
 * the API's manifest. A manifest with an absurdly small chunk_size must not
 * turn one reconcile into an hour of hashing over the box's ~116 MB binaries
 * (seen live: a test fixture served 8-byte chunks and the running CLI's index
 * never finished). Cap the chunks indexed per source; the real API serves
 * 1 MiB chunks, so a full CLI indexes ~105. A source past the cap contributes
 * nothing and the transfer degrades to the full download.
 */
const MAX_INDEXED_CHUNKS_PER_SOURCE = 65536

async function indexLocalChunks(
  paths: string[],
  chunkSize: number,
): Promise<Map<string, LocalChunk>> {
  const index = new Map<string, LocalChunk>()
  const buffer = Buffer.allocUnsafe(chunkSize)
  for (const path of [...new Set(paths)]) {
    // Open FIRST and stat the HANDLE. A stat-then-open pair is a TOCTOU race
    // (CodeQL js/file-system-race), and the handle answers the same questions.
    let handle
    try {
      handle = await open(path, 'r')
    } catch {
      continue
    }
    try {
      const stats = await handle.stat()
      if (!stats.isFile() || stats.size === 0) continue
      const size = Math.min(stats.size, MAX_INDEXED_CHUNKS_PER_SOURCE * chunkSize)
      for (let offset = 0; offset < size; offset += chunkSize) {
        const length = Math.min(chunkSize, size - offset)
        const { bytesRead } = await handle.read(buffer, 0, length, offset)
        if (bytesRead !== length) break
        const digest = createHash('sha256').update(buffer.subarray(0, length)).digest('hex')
        if (!index.has(digest)) index.set(digest, { path, offset, length })
      }
    } catch {
      // A source we cannot read contributes nothing. It is never fatal: the
      // worst case is the full download this is trying to avoid.
      continue
    } finally {
      await handle?.close().catch(() => {})
    }
  }
  return index
}

/**
 * Assemble `component` from the chunks this box already has plus the ones it
 * does not, or `null` to tell the caller to take the full download.
 */
export async function fetchArtifactByChunks(
  options: ChunkedFetchOptions,
): Promise<Buffer | null> {
  const { fetchImpl, base, token, component, expectedSha } = options
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const headers = { Authorization: `Bearer ${token}` }

  let manifest: unknown
  try {
    const res = await fetchImpl(`${base}/chunks/${component}`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    // 404 is the ordinary answer from an API that predates these routes. A box
    // must roll forward against an older control plane, so this is not a
    // failure — it is the fallback path.
    if (!res.ok) return null
    manifest = await res.json()
  } catch {
    return null
  }
  if (!isChunkManifest(manifest, expectedSha)) return null
  const { size, chunk_size: chunkSize, chunks } = manifest

  const local = await indexLocalChunks(options.localSources, chunkSize)
  const reusable = chunks.filter((digest) => local.has(digest)).length
  if (reusable / chunks.length < MIN_REUSE_RATIO) return null

  const out = Buffer.allocUnsafe(size)
  let moved = 0
  for (let i = 0; i < chunks.length; i++) {
    const digest = chunks[i] as string
    const offset = i * chunkSize
    const length = Math.min(chunkSize, size - offset)
    const hit = local.get(digest)
    if (hit) {
      let handle
      try {
        handle = await open(hit.path, 'r')
        const { bytesRead } = await handle.read(out, offset, length, hit.offset)
        if (bytesRead !== length) return null
      } catch {
        return null
      } finally {
        await handle?.close().catch(() => {})
      }
      continue
    }
    try {
      // Sequential on purpose. This runs off the readiness path, the common
      // case is a handful of chunks, and one request at a time is one fewer
      // thing to reason about beside a live turn.
      const res = await fetchImpl(`${base}/chunk/${digest}`, {
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) return null
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length !== length) return null
      bytes.copy(out, offset)
      moved += bytes.length
    } catch {
      return null
    }
  }

  // The digest check the whole lane already trusted, unchanged and still the
  // authority. A mismatch discards everything — nothing partial is installed.
  if (createHash('sha256').update(out).digest('hex') !== expectedSha) {
    logger.warn('[runtime-assets] chunked assembly did not match the manifest digest', {
      component,
      expected: expectedSha.slice(0, 12),
    })
    return null
  }
  logger.info('[runtime-assets] assembled from chunks', {
    component,
    movedBytes: moved,
    totalBytes: size,
    reusedChunks: reusable,
    totalChunks: chunks.length,
  })
  return out
}
