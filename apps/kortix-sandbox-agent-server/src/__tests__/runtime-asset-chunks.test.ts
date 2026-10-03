import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchArtifactByChunks, MAX_INDEXED_CHUNKS_PER_SOURCE } from '@/services/runtime-assets/runtime-asset-chunks'

const BASE = 'https://api.test.invalid/v1/runtime-assets'
const TOKEN = 'kortix_pat_test'
const CHUNK = 8

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true })
})

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')

/** A body built from 8-byte chunks, one letter each. `'abc'` → 24 bytes. */
const body = (letters: string) =>
  Buffer.concat([...letters].map((ch) => Buffer.alloc(CHUNK, ch.charCodeAt(0))))

async function onDisk(name: string, letters: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chunk-client-'))
  dirs.push(dir)
  const path = join(dir, name)
  await Bun.write(path, body(letters))
  return path
}

interface StubOptions {
  /** What the server says the component is. */
  served: string | Buffer
  /** Override the whole-file digest the chunk manifest advertises. */
  sha256?: string
  /** Serve corrupt bytes for these chunk digests. */
  corrupt?: Set<string>
  manifestStatus?: number
}

function stub(opts: StubOptions) {
  const served = typeof opts.served === 'string' ? body(opts.served) : opts.served
  const chunks: string[] = []
  for (let o = 0; o < served.length; o += CHUNK) chunks.push(sha(served.subarray(o, o + CHUNK)))
  const calls: string[] = []
  const impl = (async (input: string | URL | Request) => {
    const url = String(input)
    calls.push(url)
    if (url.includes('/chunks/')) {
      if (opts.manifestStatus && opts.manifestStatus !== 200) {
        return new Response('nope', { status: opts.manifestStatus })
      }
      return Response.json({
        sha256: opts.sha256 ?? sha(served),
        size: served.length,
        chunk_size: CHUNK,
        chunks,
      })
    }
    if (url.includes('/chunk/')) {
      const digest = url.slice(url.lastIndexOf('/') + 1)
      const index = chunks.indexOf(digest)
      if (index === -1) return new Response('nope', { status: 404 })
      if (opts.corrupt?.has(digest)) return new Response(Buffer.alloc(CHUNK, 0))
      return new Response(served.subarray(index * CHUNK, (index + 1) * CHUNK))
    }
    return new Response('unexpected', { status: 500 })
  }) as unknown as typeof fetch
  return { impl, calls, served, chunks }
}

const run = (s: ReturnType<typeof stub>, localSources: string[], expectedSha?: string) =>
  fetchArtifactByChunks({
    fetchImpl: s.impl,
    base: BASE,
    token: TOKEN,
    component: 'cli',
    expectedSha: expectedSha ?? sha(s.served),
    localSources,
  })

describe('fetchArtifactByChunks', () => {
  test('moves only the chunks this box does not already have', async () => {
    // The shape of a version bump: one chunk of eleven differs.
    const s = stub({ served: 'aaaaaXaaaaa' })
    const local = await onDisk('kortix', 'aaaaaaaaaaa')

    const assembled = await run(s, [local])

    expect(assembled).not.toBeNull()
    expect(Buffer.compare(assembled!, s.served)).toBe(0)
    const fetched = s.calls.filter((u) => u.includes('/chunk/'))
    expect(fetched).toEqual([`${BASE}/chunk/${s.chunks[5]}`])
  })

  test('ONE store, both binaries: a chunk only the daemon has on disk is still reused', async () => {
    // 'b' appears in no CLI on this box — only in the daemon binary beside it.
    const s = stub({ served: 'aab' })
    const cli = await onDisk('kortix', 'aaa')
    const agent = await onDisk('kortix-agent', 'bbb')

    const assembled = await run(s, [cli, agent])

    expect(Buffer.compare(assembled!, s.served)).toBe(0)
    expect(s.calls.filter((u) => u.includes('/chunk/'))).toEqual([])
  })

  test('a missing local source is skipped, not fatal', async () => {
    const s = stub({ served: 'aab' })
    const cli = await onDisk('kortix', 'aab')

    const assembled = await run(s, [join(tmpdir(), 'kortix-chunk-absent'), cli])

    expect(Buffer.compare(assembled!, s.served)).toBe(0)
  })

  test('a corrupt chunk fails the whole-file digest and installs NOTHING', async () => {
    const s = stub({ served: 'aaaaaXaaaaa' })
    const corrupt = stub({ served: 'aaaaaXaaaaa', corrupt: new Set([s.chunks[5]!]) })
    const local = await onDisk('kortix', 'aaaaaaaaaaa')

    expect(await run(corrupt, [local])).toBeNull()
  })

  test('a chunk manifest for other bytes than the manifest promised is refused outright', async () => {
    const s = stub({ served: 'aaaaaXaaaaa', sha256: sha('something else entirely') })
    const local = await onDisk('kortix', 'aaaaaaaaaaa')

    expect(await run(s, [local], sha(s.served))).toBeNull()
    // Refused on the manifest, before a single chunk moved.
    expect(s.calls.filter((u) => u.includes('/chunk/'))).toEqual([])
  })

  test('an API with no chunk routes falls back instead of failing the component', async () => {
    const s = stub({ served: 'aab', manifestStatus: 404 })
    expect(await run(s, [await onDisk('kortix', 'aab')])).toBeNull()
  })

  test('a box with nothing to reuse takes the full download, not 11 round trips for it', async () => {
    const s = stub({ served: 'abcdefghijk' })
    expect(await run(s, [await onDisk('kortix', 'zzzzzzzzzzz')])).toBeNull()
    expect(s.calls.filter((u) => u.includes('/chunk/'))).toEqual([])
  })

  test('a source past the chunk cap stops indexing at the cap and fetches its tail', async () => {
    // The live hang this cap exists for: the local index costs
    // O(source_bytes / chunk_size) and chunk_size comes from the API's
    // manifest — an 8-byte-chunk manifest over the box's ~116 MB CLI never
    // finished. (cap + 1) DISTINCT chunks is the smallest witness: the index
    // is content-addressed, so every chunk needs its own bytes for the tail
    // to be unavailable locally. The chunk past the cap must NOT come from
    // the local index — the tail is fetched from the API and the whole-file
    // digest still gates the result. Without the cap the call list stays
    // empty (every chunk indexed locally) and the real incident's 14.5M-chunk
    // index hangs past every timeout.
    const total = MAX_INDEXED_CHUNKS_PER_SOURCE + 1
    const served = Buffer.alloc(total * CHUNK)
    for (let i = 0; i < total; i++) served.writeBigUInt64BE(BigInt(i), i * CHUNK)
    const s = stub({ served })
    const dir = await mkdtemp(join(tmpdir(), 'chunk-client-'))
    dirs.push(dir)
    const local = join(dir, 'kortix')
    await Bun.write(local, served)

    const assembled = await run(s, [local])
    expect(assembled).not.toBeNull()
    expect(assembled!.equals(s.served)).toBe(true)
    expect(s.calls.some((url) => url.includes('/chunk/'))).toBe(true)
  })
})
