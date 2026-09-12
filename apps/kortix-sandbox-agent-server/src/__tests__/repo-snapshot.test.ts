/**
 * Streaming snapshot materialization: overlap, guards, limits, and failure
 * containment. Every archive here is a REAL tar stream served over a REAL local
 * HTTP server, so the pipeline under test is the shipped one.
 */
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { afterEach, describe, expect, test } from 'bun:test'
import * as tar from 'tar'

import { createCompressor } from '../snapshot-codec'

import {
  REPO_SNAPSHOT_EMBEDDED_MANIFEST,
  RepoSnapshotError,
  archiveRequestHeaders,
  materializeRepoSnapshotToStage,
  readRepoSnapshotDescriptor,
  redactUrl,
  unsafeEntryReason,
  type RepoSnapshotDescriptor,
} from '../repo-snapshot'
import { loadConfig } from '../config'

const roots: string[] = []
const servers: Server[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Snapshot Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Snapshot Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    },
    encoding: 'utf8',
  }).trim()
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

interface Fixture {
  archive: string
  sha256: string
  bytes: number
  commitSha: string
  repositoryId: string
}

/** A realistic snapshot: a shallow detached checkout plus its embedded manifest. */
async function makeFixture(
  compression: 'gzip' | 'zstd' = 'gzip',
  /** Runs after the archive tree is final; use it to make a HOSTILE archive. */
  mutate?: (checkout: string) => void,
  /** Runs before the commit; use it to add tracked content. */
  seed?: (checkout: string) => void,
): Promise<Fixture> {
  const root = tempRoot('kortix-snapshot-fixture-')
  const checkout = join(root, 'checkout')
  mkdirSync(checkout)
  git(checkout, 'init', '-b', 'main')
  writeFileSync(join(checkout, 'README.md'), 'snapshot workspace\n')
  mkdirSync(join(checkout, '.kortix', 'skills', 'spare'), { recursive: true })
  writeFileSync(join(checkout, '.kortix', 'skills', 'spare', 'SKILL.md'), '# spare skill\n')
  writeFileSync(join(checkout, 'run.sh'), '#!/bin/sh\necho ok\n', { mode: 0o755 })
  symlinkSync('README.md', join(checkout, 'readme-link'))
  seed?.(checkout)
  git(checkout, 'add', '-A')
  git(checkout, 'commit', '-m', 'snapshot')
  const commitSha = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'checkout', '--detach', commitSha)
  rmSync(join(checkout, '.git', 'logs'), { recursive: true, force: true })
  rmSync(join(checkout, '.git', 'hooks'), { recursive: true, force: true })
  rmSync(join(checkout, '.git', 'refs', 'heads', 'main'), { force: true })
  const repositoryId = '424242'
  writeFileSync(
    join(checkout, REPO_SNAPSHOT_EMBEDDED_MANIFEST),
    `${JSON.stringify({
      format: 'kortix.project-snapshot.v1',
      source: {
        provider: 'github',
        repository_id: repositoryId,
        owner: 'kortix-ai',
        repo: 'fixture',
        commit_sha: commitSha,
        tree_sha: git(checkout, 'rev-parse', 'HEAD^{tree}'),
      },
      checkout: { git_metadata: 'sanitized-shallow', layout_version: 1 },
      producer_version: 'test',
    })}\n`,
  )
  mutate?.(checkout)

  const archive = join(root, `snapshot.tar.${compression === 'zstd' ? 'zst' : 'gz'}`)
  const { createWriteStream } = await import('node:fs')
  await pipeline(
    tar.create({ cwd: checkout, portable: true, noMtime: true }, ['.']),
    createCompressor(compression),
    createWriteStream(archive),
  )
  // One read, two facts. A stat() followed by a readFile() of the same path is
  // a check-then-use on a file this process just wrote.
  const archived = readFileSync(archive)
  const bytes = archived.byteLength
  const sha256 = createHash('sha256').update(archived).digest('hex')
  return { archive, sha256, bytes, commitSha, repositoryId }
}

/** Serve a body, optionally in slow chunks so overlap is observable. */
async function serve(options: {
  body: Buffer | (() => Readable)
  status?: number
  chunkBytes?: number
  chunkDelayMs?: number
  onRequest?: () => void
}): Promise<string> {
  const server = createServer(async (req, res) => {
    options.onRequest?.()
    if (options.status && options.status !== 200) {
      res.writeHead(options.status)
      res.end('denied')
      return
    }
    if (typeof options.body === 'function') {
      res.writeHead(200)
      const stream = options.body()
      stream.pipe(res)
      return
    }
    const buffer = options.body
    res.writeHead(200, { 'content-length': String(buffer.byteLength) })
    const size = options.chunkBytes ?? buffer.byteLength
    for (let offset = 0; offset < buffer.byteLength; offset += size) {
      res.write(buffer.subarray(offset, Math.min(offset + size, buffer.byteLength)))
      if (options.chunkDelayMs) await new Promise((r) => setTimeout(r, options.chunkDelayMs))
    }
    res.end()
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return `http://127.0.0.1:${port}/snapshot?X-Amz-Signature=deadbeef`
}

function descriptorFor(fixture: Fixture, url: string, overrides: Partial<RepoSnapshotDescriptor> = {}): RepoSnapshotDescriptor {
  return {
    url,
    sha256: fixture.sha256,
    compression: 'gzip',
    commitSha: fixture.commitSha,
    repositoryId: fixture.repositoryId,
    compressedBytes: fixture.bytes,
    ...overrides,
  }
}

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('unsafeEntryReason', () => {
  test('rejects traversal, absolute paths, escaping links, devices and privileged modes', () => {
    expect(unsafeEntryReason({ path: 'src/app.ts', type: 'File', mode: 0o644 })).toBeNull()
    expect(unsafeEntryReason({ path: 'bin/run', type: 'File', mode: 0o755 })).toBeNull()
    expect(unsafeEntryReason({ path: 'a/b', type: 'SymbolicLink', linkpath: '../c' })).toBeNull()
    expect(unsafeEntryReason({ path: '.git/config', type: 'File', mode: 0o644 })).toBeNull()

    expect(unsafeEntryReason({ path: '/etc/passwd', type: 'File' })).toMatch(/absolute/)
    expect(unsafeEntryReason({ path: '../escape', type: 'File' })).toMatch(/escapes/)
    expect(unsafeEntryReason({ path: 'a/../../escape', type: 'File' })).toMatch(/escapes/)
    expect(unsafeEntryReason({ path: 'dev/null', type: 'CharacterDevice' })).toMatch(/unsupported entry type/)
    expect(unsafeEntryReason({ path: 'pipe', type: 'FIFO' })).toMatch(/unsupported entry type/)
    expect(unsafeEntryReason({ path: 'link', type: 'Link', linkpath: 'README.md' })).toMatch(/hard links/)
    expect(unsafeEntryReason({ path: 'sudo', type: 'File', mode: 0o4755 })).toMatch(/privileged mode/)
    expect(unsafeEntryReason({ path: 'sgid', type: 'File', mode: 0o2755 })).toMatch(/privileged mode/)
    expect(unsafeEntryReason({ path: 'esc', type: 'SymbolicLink', linkpath: '/etc/passwd' })).toMatch(/absolute/)
    expect(unsafeEntryReason({ path: 'a/esc', type: 'SymbolicLink', linkpath: '../../outside' })).toMatch(/escapes/)
  })
})

describe('redactUrl', () => {
  test('drops the signed query string and any credential', () => {
    expect(redactUrl('https://bucket.s3.amazonaws.com/a/b.tar.gz?X-Amz-Signature=abc&X-Amz-Credential=key')).toBe(
      'https://bucket.s3.amazonaws.com/a/b.tar.gz',
    )
    expect(redactUrl('https://user:pass@host/x?y=1')).toBe('https://host/x')
  })
})

describe('materializeRepoSnapshotToStage', () => {
  test('extracts a verified snapshot and leaves a clean detached checkout', async () => {
    const fixture = await makeFixture()
    const url = await serve({ body: readFileSync(fixture.archive) })
    const stage = join(tempRoot('kortix-snapshot-stage-'), 'stage')

    const metrics = await materializeRepoSnapshotToStage(descriptorFor(fixture, url), stage)
    expect(metrics.sha256).toBe(fixture.sha256)
    expect(metrics.commitSha).toBe(fixture.commitSha)
    expect(metrics.attempts).toBe(1)
    expect(metrics.entryCount).toBeGreaterThan(0)

    expect(readFileSync(join(stage, 'README.md'), 'utf8')).toBe('snapshot workspace\n')
    expect(readFileSync(join(stage, '.kortix/skills/spare/SKILL.md'), 'utf8')).toBe('# spare skill\n')
    expect(statSync(join(stage, 'run.sh')).mode & 0o111).not.toBe(0)
    expect(git(stage, 'rev-parse', 'HEAD')).toBe(fixture.commitSha)
    expect(git(stage, 'status', '--porcelain')).toBe('')
  }, 60_000)

  test('supports zstd end to end', async () => {
    const fixture = await makeFixture('zstd')
    const url = await serve({ body: readFileSync(fixture.archive) })
    const stage = join(tempRoot('kortix-snapshot-stage-'), 'stage')
    const metrics = await materializeRepoSnapshotToStage(
      descriptorFor(fixture, url, { compression: 'zstd' }),
      stage,
    )
    expect(metrics.compression).toBe('zstd')
    expect(git(stage, 'rev-parse', 'HEAD')).toBe(fixture.commitSha)
  }, 60_000)

  test('starts extracting before the response ends', async () => {
    // Incompressible payload so the wire body is large enough to span many
    // chunks: with one chunk there is nothing to overlap and the assertion
    // would pass for the wrong reason.
    const fixture = await makeFixture('gzip', undefined, (checkout) => {
      writeFileSync(join(checkout, 'payload.bin'), randomBytes(2 * 1024 * 1024))
    })
    const body = readFileSync(fixture.archive)
    expect(body.byteLength).toBeGreaterThan(1_000_000)
    // 64 KiB every 5 ms — a slow link. If extraction waited for the last byte,
    // the first entry would land at the same time as the final chunk.
    const url = await serve({ body, chunkBytes: 64 * 1024, chunkDelayMs: 5 })
    const stage = join(tempRoot('kortix-snapshot-stage-'), 'stage')
    const metrics = await materializeRepoSnapshotToStage(descriptorFor(fixture, url), stage)
    expect(metrics.transferMs).toBeGreaterThan(100)
    // The proof: the first entry was written well before the transfer ended.
    expect(metrics.firstEntryAtMs).toBeLessThan(metrics.transferMs / 2)
    expect(metrics.extractMs).toBeGreaterThan(0)
  }, 120_000)

  test('a digest mismatch leaves nothing on disk', async () => {
    const fixture = await makeFixture()
    const url = await serve({ body: readFileSync(fixture.archive) })
    const stage = join(tempRoot('kortix-snapshot-stage-'), 'stage')
    await expect(
      materializeRepoSnapshotToStage(descriptorFor(fixture, url, { sha256: 'f'.repeat(64) }), stage),
    ).rejects.toThrow(/digest mismatch/)
    await expect(stat(stage)).rejects.toThrow()
  }, 60_000)

  test('a truncated stream fails and removes the partial tree', async () => {
    const fixture = await makeFixture()
    const body = readFileSync(fixture.archive)
    const url = await serve({ body: body.subarray(0, Math.floor(body.byteLength / 2)) })
    const stage = join(tempRoot('kortix-snapshot-stage-'), 'stage')
    await expect(materializeRepoSnapshotToStage(descriptorFor(fixture, url), stage, { maxAttempts: 1 })).rejects.toThrow()
    await expect(stat(stage)).rejects.toThrow()
  }, 60_000)

  test('a corrupt compressed stream fails without retrying an immutable object', async () => {
    const fixture = await makeFixture()
    const corrupt = Buffer.from(readFileSync(fixture.archive))
    const flip = Math.floor(corrupt.byteLength / 2)
    corrupt.writeUInt8(corrupt.readUInt8(flip) ^ 0xff, flip)
    let requests = 0
    const url = await serve({ body: corrupt, onRequest: () => { requests += 1 } })
    const stage = join(tempRoot('kortix-snapshot-stage-'), 'stage')
    await expect(
      materializeRepoSnapshotToStage(
        descriptorFor(fixture, url, { sha256: createHash('sha256').update(corrupt).digest('hex') }),
        stage,
      ),
    ).rejects.toThrow()
    expect(requests).toBe(1)
  }, 60_000)

  test('rejects an archive containing a traversal entry', async () => {
    const root = tempRoot('kortix-snapshot-hostile-')
    const src = join(root, 'src')
    mkdirSync(join(src, 'nested'), { recursive: true })
    writeFileSync(join(src, 'nested', 'ok.txt'), 'ok\n')
    const archive = join(root, 'hostile.tar.gz')
    const { createWriteStream } = await import('node:fs')
    // `preservePaths` on the PRODUCING side is what lets the fixture contain a
    // path the consumer must refuse.
    await pipeline(
      tar.create({ cwd: src, portable: true, noMtime: true, preservePaths: true }, ['nested/ok.txt']).on('error', () => {}),
      createGzip(),
      createWriteStream(archive),
    )
    // Hand-assemble a traversal header: tar.create will not emit one.
    const hostile = join(root, 'traversal.tar.gz')
    const header = Buffer.alloc(512)
    header.write('../../escaped.txt', 0, 'utf8')
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write('00000000006\0', 124)
    header.write('00000000000\0', 136)
    header.write('        ', 148)
    header.write('0', 156)
    header.write('ustar\0', 257)
    header.write('00', 263)
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
    const content = Buffer.alloc(512)
    content.write('bad\n')
    const raw = Buffer.concat([header, content, Buffer.alloc(1024)])
    await pipeline(Readable.from([raw]), createGzip(), createWriteStream(hostile))
    const bytes = readFileSync(hostile)
    const url = await serve({ body: bytes })
    const stage = join(tempRoot('kortix-snapshot-stage-'), 'stage')
    await expect(
      materializeRepoSnapshotToStage(
        {
          url,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          compression: 'gzip',
          commitSha: 'a'.repeat(40),
          repositoryId: '1',
        },
        stage,
      ),
    ).rejects.toThrow(/unsafe archive entry|escapes/)
    await expect(stat(stage)).rejects.toThrow()
    await expect(stat(join(root, 'escaped.txt'))).rejects.toThrow()
  }, 60_000)

  test('refuses an archive whose identity is not the pinned revision', async () => {
    const fixture = await makeFixture()
    const url = await serve({ body: readFileSync(fixture.archive) })
    const stage = join(tempRoot('kortix-snapshot-stage-'), 'stage')
    await expect(
      materializeRepoSnapshotToStage(
        descriptorFor(fixture, url, { repositoryId: '999' }),
        stage,
      ),
    ).rejects.toThrow(/identity does not match/)
    await expect(stat(stage)).rejects.toThrow()
  }, 60_000)

  test('refuses an archive carrying Git hooks', async () => {
    const fixture = await makeFixture('gzip', (checkout) => {
      mkdirSync(join(checkout, '.git', 'hooks'), { recursive: true })
      writeFileSync(join(checkout, '.git', 'hooks', 'post-checkout'), '#!/bin/sh\necho pwned\n', { mode: 0o755 })
    })
    const url = await serve({ body: readFileSync(fixture.archive) })
    const stage = join(tempRoot('kortix-snapshot-stage-'), 'stage')
    await expect(materializeRepoSnapshotToStage(descriptorFor(fixture, url), stage)).rejects.toThrow(/Git hooks/)
  }, 60_000)

  test('enforces the declared expansion bound', async () => {
    const fixture = await makeFixture()
    const url = await serve({ body: readFileSync(fixture.archive) })
    const stage = join(tempRoot('kortix-snapshot-stage-'), 'stage')
    await expect(
      materializeRepoSnapshotToStage(descriptorFor(fixture, url, { expandedBytes: 1024 }), stage, { maxAttempts: 1 }),
    ).rejects.toThrow(/expands past/)
    await expect(stat(stage)).rejects.toThrow()
  }, 60_000)

  test('refreshes an expired capability and stays bound to the same revision', async () => {
    const fixture = await makeFixture()
    const denied = await serve({ body: Buffer.alloc(0), status: 403 })
    const allowed = await serve({ body: readFileSync(fixture.archive) })
    const stage = join(tempRoot('kortix-snapshot-stage-'), 'stage')

    let refreshes = 0
    const metrics = await materializeRepoSnapshotToStage(descriptorFor(fixture, denied), stage, {
      refreshDescriptor: async () => {
        refreshes += 1
        return descriptorFor(fixture, allowed)
      },
    })
    expect(refreshes).toBe(1)
    expect(metrics.attempts).toBe(2)
    expect(metrics.commitSha).toBe(fixture.commitSha)

    // A refresh naming a DIFFERENT revision must be ignored, not adopted.
    const other = await serve({ body: readFileSync(fixture.archive), status: 403 })
    await expect(
      materializeRepoSnapshotToStage(descriptorFor(fixture, other), join(stage, '..', 'stage2'), {
        maxAttempts: 2,
        refreshDescriptor: async () => descriptorFor(fixture, allowed, { commitSha: 'b'.repeat(40) }),
      }),
    ).rejects.toThrow(/HTTP 403/)
  }, 60_000)
})

describe('archiveRequestHeaders', () => {
  const base = {
    url: 'https://api.kortix.test/v1/git/p/repo-snapshot/archive?sha=abc',
    sha256: 'a'.repeat(64),
    compression: 'gzip' as const,
    commitSha: 'b'.repeat(40),
    repositoryId: '1',
  }

  test('presigned delivery sends no credential at all', () => {
    expect(archiveRequestHeaders({ ...base, auth: 'none' }, 'sandbox-token')).toEqual({})
    expect(archiveRequestHeaders(base, 'sandbox-token')).toEqual({})
  })

  test('proxy delivery sends the bearer to the control plane origin', () => {
    expect(
      archiveRequestHeaders(
        { ...base, auth: 'bearer', apiOrigin: 'https://api.kortix.test' },
        'sandbox-token',
      ),
    ).toEqual({ authorization: 'Bearer sandbox-token' })
  })

  test('refuses to send the Kortix token anywhere but the control plane', () => {
    // This is the shape a stolen or tampered descriptor takes: `auth: bearer`
    // pointed at someone else's host. The cost of honouring it is the session
    // credential, so it fails instead.
    expect(() =>
      archiveRequestHeaders(
        {
          ...base,
          url: 'https://evil.invalid/archive.tar.gz',
          auth: 'bearer',
          apiOrigin: 'https://api.kortix.test',
        },
        'sandbox-token',
      ),
    ).toThrow(/refusing to send the Kortix token/)
    // An S3 host is equally refused, even though it is a legitimate snapshot host.
    expect(() =>
      archiveRequestHeaders(
        {
          ...base,
          url: 'https://bucket.s3.us-east-1.amazonaws.com/key.tar.gz?X-Amz-Signature=x',
          auth: 'bearer',
          apiOrigin: 'https://api.kortix.test',
        },
        'sandbox-token',
      ),
    ).toThrow(/refusing to send the Kortix token/)
    // No origin recorded → nothing is trusted.
    expect(() =>
      archiveRequestHeaders({ ...base, auth: 'bearer' }, 'sandbox-token'),
    ).toThrow(/refusing to send the Kortix token/)
    // Bearer requested but no token configured is a descriptor error.
    expect(() =>
      archiveRequestHeaders({ ...base, auth: 'bearer', apiOrigin: 'https://api.kortix.test' }, undefined),
    ).toThrow(/requires a bearer/)
  })
})

describe('readRepoSnapshotDescriptor', () => {
  test('returns null without a complete descriptor and rejects a malformed one', () => {
    const base = {
      KORTIX_PROJECT_TARGET: '/workspace',
      KORTIX_REPO_SNAPSHOT_MODE: 'prefer',
    }
    expect(readRepoSnapshotDescriptor(loadConfig(base as NodeJS.ProcessEnv))).toBeNull()

    const complete = loadConfig({
      ...base,
      KORTIX_REPO_SNAPSHOT_URL: 'https://example.invalid/a.tar.gz?sig=1',
      KORTIX_REPO_SNAPSHOT_SHA256: 'a'.repeat(64),
      KORTIX_REPO_SNAPSHOT_COMPRESSION: 'gzip',
      KORTIX_REPO_SNAPSHOT_COMMIT_SHA: 'b'.repeat(40),
      KORTIX_REPO_SNAPSHOT_REPOSITORY_ID: '12345',
    } as NodeJS.ProcessEnv)
    expect(readRepoSnapshotDescriptor(complete)?.commitSha).toBe('b'.repeat(40))

    const malformed = loadConfig({
      ...base,
      KORTIX_REPO_SNAPSHOT_URL: 'https://example.invalid/a.tar.gz',
      KORTIX_REPO_SNAPSHOT_SHA256: 'not-a-digest',
      KORTIX_REPO_SNAPSHOT_COMPRESSION: 'gzip',
      KORTIX_REPO_SNAPSHOT_COMMIT_SHA: 'b'.repeat(40),
      KORTIX_REPO_SNAPSHOT_REPOSITORY_ID: '12345',
    } as NodeJS.ProcessEnv)
    expect(() => readRepoSnapshotDescriptor(malformed)).toThrow(RepoSnapshotError)
  })
})
