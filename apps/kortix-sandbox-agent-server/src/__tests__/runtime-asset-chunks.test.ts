import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchArtifactByChunks } from '../services/runtime-assets/runtime-asset-chunks'

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
  served: string
  /** Override the whole-file digest the chunk manifest advertises. */
  sha256?: string
  /** Serve corrupt bytes for these chunk digests. */
  corrupt?: Set<string>
  manifestStatus?: number
}

function stub(opts: StubOptions) {
  const served = body(opts.served)
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
})
