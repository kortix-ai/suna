/**
 * Config provider (src/config-provider): S3 acquisition of the two-object
 * snapshot (boot tree + blob pack), classified failures, bounded fallback to
 * Git, strict mode, cancellation, denial, the archive safety guards, native
 * vs in-process extraction, and the post-activation blob hydration — driven
 * through the REAL coordinator with real objects built by git and served by a
 * local HTTP server standing in for the Git proxy + object store.
 *
 * The Git fallback lands through the image-baked scaffold zero-network path
 * (the scaffold's HEAD == the pinned base SHA), so "fallback at the same
 * revision" is asserted on a real checkout, not a stub.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as tar from 'tar'

import { loadConfig, type Config } from '../config'
import { materializeProject } from '../config-provider/config-provider'
import {
  PROJECT_SNAPSHOT_FORMAT,
  buildProjectSnapshotDescriptorUrl,
  downloadAndExtractProjectSnapshot,
  makeEntryGuard,
  parseProjectSnapshotPin,
  type ProjectSnapshotDescriptor,
} from '../config-provider/s3/s3-config-provider'
import { ConfigProviderError } from '../config-provider/types'
import { __clearRepoIdentityMemoForTests, __setScaffoldRepoPathForTests, readRepoInfo } from '../git'

const PROJECT_ID = '11111111-1111-4111-8111-111111111111'
const EXTERNAL_ID = '424242'
const TOKEN = 'sandbox-token-for-tests'

const roots: string[] = []

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t.test',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t.test',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim()
}

function gitBuffer(cwd: string, args: string[], input?: Buffer | string): Buffer {
  return execFileSync('git', args, { cwd, input, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

interface Snapshot {
  /** The boot object (working tree + blobless .git), tar.gz. */
  path: string
  bytes: Buffer
  sha256: string
  entries: number
  /** The hydration object (blob pack). */
  blobs: { bytes: Buffer; sha256: string }
  sha: string
}

/** A committed project (several files so gzip streams multiple entries). */
function makeSourceRepo(root: string, marker = 'v1'): { checkout: string; sha: string } {
  const checkout = join(root, `source-${marker}`)
  mkdirSync(checkout)
  git(checkout, 'init', '-q', '-b', 'main')
  writeFileSync(join(checkout, 'README.md'), `project ${marker}\n`)
  mkdirSync(join(checkout, 'src'))
  for (let i = 0; i < 12; i += 1) {
    writeFileSync(join(checkout, 'src', `file-${i}.txt`), `${marker} file ${i}\n${'x'.repeat(4096 + i * 97)}\n`)
  }
  mkdirSync(join(checkout, '.kortix', 'opencode'), { recursive: true })
  writeFileSync(join(checkout, '.kortix', 'opencode', 'opencode.jsonc'), '{"$schema":"x"}\n')
  writeFileSync(join(checkout, 'kortix.yaml'), 'kortix_version: 2\n')
  // An in-tree symlink is ordinary Git content and must survive extraction.
  symlinkSync('README.md', join(checkout, 'README-link'))
  git(checkout, 'add', '-A')
  git(checkout, 'commit', '-q', '-m', `source ${marker}`)
  return { checkout, sha: git(checkout, 'rev-parse', 'HEAD') }
}

/** Pack a directory the way the API producer does (node-tar, portable, no mtimes). */
async function packDir(dir: string, path: string): Promise<{ path: string; bytes: Buffer; sha256: string; entries: number }> {
  let entries = 0
  await tar.create(
    { cwd: dir, file: path, gzip: true, portable: true, noMtime: true, filter: () => (entries += 1, true) },
    ['.'],
  )
  const bytes = readFileSync(path)
  return { path, bytes, sha256: sha256(bytes), entries }
}

/**
 * What the API producer ships (project-snapshot.ts buildProjectSnapshotArchive):
 * a sanitized shallow checkout whose ONE pack holds commit + trees (marked
 * promisor) tarred with the working tree, plus the blob pack as its own object.
 */
async function makeSnapshot(root: string, source: { checkout: string; sha: string }, label = 'archive'): Promise<Snapshot> {
  const stage = join(root, `${label}-stage`)
  git(root, 'clone', '-q', '--depth', '1', `file://${source.checkout}`, stage)
  git(stage, 'remote', 'remove', 'origin')
  rmSync(join(stage, '.git', 'logs'), { recursive: true, force: true })
  rmSync(join(stage, '.git', 'hooks'), { recursive: true, force: true })
  rmSync(join(stage, '.git', 'index'), { force: true })
  git(stage, 'read-tree', 'HEAD')
  const packDirPath = join(stage, '.git', 'objects', 'pack')
  const fetched = readdirSync(packDirPath)
  const blobsPack = gitBuffer(stage, ['pack-objects', '--revs', '--stdout', '-q'], 'HEAD\n')
  // Boot pack = commit + trees + symlink blobs (git compares a symlink against
  // its blob's content on refresh); regular-file blobs ride the blob pack.
  const nonBlobs = gitBuffer(stage, ['rev-list', '--objects', '--filter=blob:none', 'HEAD']).toString().split('\n').map((l) => l.slice(0, 40))
  const symlinkBlobs = gitBuffer(stage, ['ls-tree', '-r', 'HEAD'])
    .toString()
    .split('\n')
    .filter((l) => l.startsWith('120000 blob '))
    .map((l) => l.split(/\s+/)[2] ?? '')
  const bootObjects = [...nonBlobs, ...symlinkBlobs].filter((id) => /^[0-9a-f]{40}$/.test(id))
  const treePack = gitBuffer(stage, ['pack-objects', '--stdout', '-q'], `${bootObjects.join('\n')}\n`)
  const indexed = gitBuffer(stage, ['index-pack', '--stdin'], treePack).toString()
  const sum = indexed.match(/^pack\t([0-9a-f]+)/m)?.[1]
  if (!sum) throw new Error(`index-pack did not name the pack: ${indexed}`)
  for (const name of fetched) rmSync(join(packDirPath, name), { force: true })
  for (const entry of readdirSync(join(stage, '.git', 'objects'))) {
    if (/^[0-9a-f]{2}$/.test(entry)) rmSync(join(stage, '.git', 'objects', entry), { recursive: true, force: true })
  }
  writeFileSync(join(packDirPath, `pack-${sum}.promisor`), '')
  writeFileSync(
    join(stage, '.git', 'kortix-project-snapshot.json'),
    `${JSON.stringify({
      format: PROJECT_SNAPSHOT_FORMAT,
      repository: { owner: 'kortix', name: 'demo', external_id: EXTERNAL_ID },
      ref: 'main',
      commit_sha: source.sha,
    })}\n`,
  )
  const packed = await packDir(stage, join(root, `${label}.tree.tar.gz`))
  return { ...packed, sha: source.sha, blobs: { bytes: blobsPack, sha256: sha256(blobsPack) } }
}

interface FakeApi {
  url: string
  requests: Array<{ path: string; auth: string | null }>
  descriptorStatus: number
  /** How the BOOT object is served (`forbidden-once`: 403 on the first request, then ok). */
  archiveMode: 'ok' | 'forbidden' | 'forbidden-once' | 'stall' | 'cut' | 'corrupt' | 'slow'
  /** How the HYDRATION object is served (`forbidden-once`: 403 on the first request, then ok). */
  blobsMode: 'ok' | 'missing' | 'forbidden' | 'forbidden-once'
  archive: Snapshot
  firstHalfSent: Promise<void>
  stop: () => void
}

/**
 * The descriptor the fake proxy serves for `sha` — also what a test feeds the
 * daemon through KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR (the API presigns the same
 * body at session create). `ttlMs` sets both objects' expiry.
 */
function descriptorFor(state: FakeApi, sha: string, ttlMs = 60_000): ProjectSnapshotDescriptor {
  return {
    format: PROJECT_SNAPSHOT_FORMAT,
    commit_sha: sha,
    ref: 'main',
    repository: { owner: 'kortix', name: 'demo', external_id: EXTERNAL_ID },
    tree: {
      url: `${state.url}/tree/${state.archive.sha256}.tree.tar.gz?X-Amz-Signature=test-signature`,
      sha256: state.archive.sha256,
      bytes: state.archive.bytes.byteLength,
      entries: state.archive.entries,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
    },
    blobs: {
      url: `${state.url}/blobs/${state.archive.blobs.sha256}.blobs.pack?X-Amz-Signature=test-signature`,
      sha256: state.archive.blobs.sha256,
      bytes: state.archive.blobs.bytes.byteLength,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
    },
  }
}

/** Base64 JSON, exactly as `encodeProjectSnapshotDescriptorForEnv` in the API writes it. */
function envDescriptor(descriptor: ProjectSnapshotDescriptor): string {
  return Buffer.from(JSON.stringify(descriptor)).toString('base64')
}

function startFakeApi(archive: Snapshot, opts: { deadlineStallMs?: number } = {}): FakeApi {
  let resolveFirstHalf!: () => void
  const firstHalfSent = new Promise<void>((r) => {
    resolveFirstHalf = r
  })
  const state: FakeApi = {
    url: '',
    requests: [],
    descriptorStatus: 200,
    archiveMode: 'ok',
    blobsMode: 'ok',
    archive,
    firstHalfSent,
    stop: () => {},
  }
  // node:http rather than Bun.serve: the `cut` mode needs a REAL socket reset
  // mid-body (what a flaky object store looks like on the wire), which only the
  // raw socket can produce.
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    state.requests.push({ path: url.pathname, auth: req.headers.authorization ?? null })
    if (url.pathname.endsWith('/project-snapshot')) {
      if (state.descriptorStatus !== 200) {
        res.writeHead(state.descriptorStatus, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not_prepared' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(descriptorFor(state, url.searchParams.get('sha') ?? '')))
      return
    }
    if (url.pathname.startsWith('/blobs/')) {
      const body = state.archive.blobs.bytes
      switch (state.blobsMode) {
        case 'missing':
          res.writeHead(404, { 'content-type': 'application/xml' })
          res.end('<Error><Code>NoSuchKey</Code></Error>')
          return
        case 'forbidden-once':
          state.blobsMode = 'ok'
        // fall through
        case 'forbidden':
          res.writeHead(403, { 'content-type': 'application/xml' })
          res.end('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>')
          return
        default:
          res.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/x-git-pack' })
          res.end(body)
          return
      }
    }
    if (url.pathname.startsWith('/tree/')) {
      const body = state.archive.bytes
      const half = Math.floor(body.length / 2)
      switch (state.archiveMode) {
        case 'forbidden-once':
          state.archiveMode = 'ok'
        // fall through
        case 'forbidden':
          res.writeHead(403, { 'content-type': 'application/xml' })
          res.end('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>')
          return
        case 'corrupt': {
          const corrupt = Buffer.from(body)
          for (let i = half; i < corrupt.length; i += 7) corrupt[i] = corrupt[i]! ^ 0xff
          res.writeHead(200, { 'content-length': String(corrupt.length), 'content-type': 'application/gzip' })
          res.end(corrupt)
          return
        }
        case 'stall':
          res.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/gzip' })
          res.write(body.subarray(0, half))
          resolveFirstHalf()
          setTimeout(() => res.end(body.subarray(half)), opts.deadlineStallMs ?? 5_000)
          return
        case 'cut':
          res.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/gzip' })
          res.write(body.subarray(0, half))
          resolveFirstHalf()
          setTimeout(() => res.socket?.destroy(), 30)
          return
        case 'slow':
          res.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/gzip' })
          res.write(body.subarray(0, half))
          resolveFirstHalf()
          setTimeout(() => res.end(body.subarray(half)), 600)
          return
        default:
          res.writeHead(200, { 'content-length': String(body.length), 'content-type': 'application/gzip' })
          res.end(body)
          return
      }
    }
    res.writeHead(404)
    res.end('not found')
  })
  server.listen(0, '127.0.0.1')
  const port = (server.address() as AddressInfo).port
  state.url = `http://127.0.0.1:${port}`
  state.stop = () => server.close()
  return state
}

function makeConfig(
  api: FakeApi,
  target: string,
  sha: string,
  overrides: Partial<Record<string, string>> = {},
): Config {
  return loadConfig({
    KORTIX_PROJECT_AUTO_CLONE: '1',
    KORTIX_PROJECT_TARGET: target,
    KORTIX_WORKSPACE: target,
    KORTIX_REPO_URL: `${api.url}/v1/git/${PROJECT_ID}.git`,
    KORTIX_PROJECT_ID: PROJECT_ID,
    KORTIX_API_URL: `${api.url}/v1`,
    KORTIX_TOKEN: TOKEN,
    KORTIX_SESSION_FRESH: '1',
    KORTIX_BASE_SHA: sha,
    KORTIX_BRANCH_NAME: 'sess-0001',
    KORTIX_DEFAULT_BRANCH: 'main',
    KORTIX_PROJECT_SNAPSHOT_MODE: 'prefer-s3',
    KORTIX_PROJECT_SNAPSHOT_PIN: `${sha}:${api.archive.sha256}:${api.archive.bytes.byteLength}`,
    ...overrides,
  })
}

let root: string
let source: { checkout: string; sha: string }
let archive: Snapshot
let api: FakeApi

beforeEach(async () => {
  __clearRepoIdentityMemoForTests()
  root = tmp('kortix-config-provider-')
  source = makeSourceRepo(root)
  archive = await makeSnapshot(root, source)
  api = startFakeApi(archive)
  // The Git fallback's zero-network scaffold path: a bare copy whose HEAD IS
  // the pinned base SHA, exactly what the image bakes for a fresh project.
  const scaffold = join(root, 'scaffold.git')
  git(root, 'clone', '-q', '--bare', `file://${source.checkout}`, scaffold)
  __setScaffoldRepoPathForTests(scaffold)
})

afterEach(() => {
  api.stop()
  __setScaffoldRepoPathForTests()
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Private stage dirs AND stage files (`.kortix-snapshot-*.tgz`) left under the target. */
function stageDirs(target: string): string[] {
  return existsSync(target) ? readdirSync(target).filter((n) => n.startsWith('.kortix-')) : []
}

/** Objects reachable from HEAD that are not in the local object store (no lazy fetch). */
function missingObjects(target: string): number {
  return git(target, 'rev-list', '--objects', '--missing=print', 'HEAD')
    .split('\n')
    .filter((l) => l.startsWith('?')).length
}

function packFiles(target: string): string[] {
  return readdirSync(join(target, '.git', 'objects', 'pack')).sort()
}

async function expectWorkspaceAtSha(target: string, sha: string, repoUrl: string): Promise<void> {
  const info = await readRepoInfo(target)
  expect(info?.commit).toBe(sha)
  expect(info?.branch).toBe('sess-0001')
  expect(info?.remoteUrl).toBe(repoUrl)
  expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('project v1\n')
  expect(git(target, 'ls-files').split('\n').length).toBe(git(source.checkout, 'ls-files').split('\n').length)
  expect(git(target, 'config', '--local', '--get', 'kortix.adopted-session')).toBe('sess-0001')
  expect(git(target, 'status', '--porcelain')).toBe('')
  expect(existsSync(join(target, '.git', 'hooks', 'pre-commit'))).toBe(false)
  expect(stageDirs(target)).toEqual([])
}

/** The partial-clone contract a snapshot start leaves behind. */
function expectPartialCloneConfig(target: string): void {
  expect(git(target, 'config', '--local', '--get', 'remote.origin.promisor')).toBe('true')
  expect(git(target, 'config', '--local', '--get', 'remote.origin.partialclonefilter')).toBe('blob:none')
  expect(git(target, 'config', '--local', '--get', 'extensions.partialclone')).toBe('origin')
}

describe('pin + descriptor url', () => {
  test('parses a well-formed pin and rejects malformed ones', () => {
    const sha = 'a'.repeat(40)
    const digest = 'b'.repeat(64)
    expect(parseProjectSnapshotPin(`${sha}:${digest}:1234`)).toEqual({ sha, sha256: digest, bytes: 1234 })
    expect(parseProjectSnapshotPin(`${sha}:${digest}:0`)).toBeNull()
    expect(parseProjectSnapshotPin(`${sha}:${digest}`)).toBeNull()
    expect(parseProjectSnapshotPin('nope')).toBeNull()
    expect(parseProjectSnapshotPin(undefined)).toBeNull()
  })

  test('derives the descriptor endpoint from the proxied repo url without credentials', () => {
    expect(buildProjectSnapshotDescriptorUrl('https://user:pw@api.kortix.test/v1/git/p.git', 'c'.repeat(40))).toBe(
      `https://api.kortix.test/v1/git/p.git/project-snapshot?sha=${'c'.repeat(40)}`,
    )
    expect(() => buildProjectSnapshotDescriptorUrl('file:///tmp/repo.git', 'c'.repeat(40))).toThrow(ConfigProviderError)
  })
})

describe('materializeProject — prefer-s3', () => {
  test('acquires the pinned boot object, activates a blob-less partial clone, then hydrates the blobs off the boot path', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.archiveMode = 'slow'
    const marks: string[] = []
    // Two-pass proof: while the server is pausing mid-body, the object is
    // accumulating in the private stage FILE and nothing has been extracted
    // yet — no byte reaches the tree before the whole object is verified.
    const midway = api.firstHalfSent.then(async () => {
      await new Promise((r) => setTimeout(r, 250))
      const entries = stageDirs(target)
      return { files: entries.filter((n) => n.endsWith('.tgz')), dirs: entries.filter((n) => !n.endsWith('.tgz')) }
    })
    const result = await materializeProject(cfg, { bootMark: (l) => marks.push(l) })
    const observed = await midway

    expect(result.provider).toBe('s3')
    expect(result.fallback).toBeUndefined()
    expect(result.sha).toBe(archive.sha)
    expect(result.summary.sha_matches).toBe(true)
    expect(result.s3?.attempts).toBe(1)
    expect(result.s3?.bytes).toBe(archive.bytes.byteLength)
    expect(result.s3?.extractor).toBe('tar')
    expect(observed.files.length).toBe(1)
    expect(observed.dirs).toEqual([])
    expect(marks).toContain('config-provider:s3:ok')
    // Boot path: a valid partial clone with NO blobs yet (hydration still pending).
    expect(result.summary.hydration?.status).toBe('pending')
    expectPartialCloneConfig(target)
    expect(packFiles(target).filter((n) => n.endsWith('.promisor')).length).toBe(1)
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
    // The symlink committed in the source survives as a symlink.
    expect(readFileSync(join(target, 'README-link'), 'utf8')).toBe('project v1\n')

    // Hydration: the blob pack lands as a second promisor pack; nothing is missing.
    const hydration = await result.hydration!
    expect(hydration.status).toBe('ok')
    expect(hydration.bytes).toBe(archive.blobs.bytes.byteLength)
    expect(result.summary.hydration?.status).toBe('ok')
    expect(marks).toContain('config-provider:hydrate:ok')
    expect(packFiles(target).filter((n) => n.endsWith('.pack')).length).toBe(2)
    expect(packFiles(target).filter((n) => n.endsWith('.promisor')).length).toBe(2)
    expect(missingObjects(target)).toBe(0)
    expect(git(target, 'cat-file', '-p', 'HEAD:README.md')).toBe('project v1')
    // The refreshed index makes status a stat-only check; still clean.
    expect(git(target, 'status', '--porcelain')).toBe('')

    // Descriptor carried the sandbox credential; neither object request did.
    const descriptorReq = api.requests.find((r) => r.path.endsWith('/project-snapshot'))
    const treeReq = api.requests.find((r) => r.path.startsWith('/tree/'))
    const blobsReq = api.requests.find((r) => r.path.startsWith('/blobs/'))
    expect(descriptorReq?.auth).toBe(`Bearer ${TOKEN}`)
    expect(treeReq?.auth).toBeNull()
    expect(blobsReq?.auth).toBeNull()
  })

  test('a lost blob pack leaves a working partial clone: boot ok, hydration failed and visible', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.blobsMode = 'missing'
    const marks: string[] = []
    const result = await materializeProject(cfg, { bootMark: (l) => marks.push(l) })
    expect(result.provider).toBe('s3')
    const hydration = await result.hydration!
    expect(hydration).toMatchObject({ status: 'failed', reason: 'missing', attempts: 1 })
    expect(result.summary.hydration?.status).toBe('failed')
    expect(marks).toContain('config-provider:hydrate:failed')
    // Still a valid repository at the right commit, with blobs marked fetchable.
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
    expectPartialCloneConfig(target)
    expect(missingObjects(target)).toBeGreaterThan(0)
    expect(packFiles(target).filter((n) => n.endsWith('.pack')).length).toBe(1)
  })

  test('an expired blob-pack URL re-fetches the descriptor and completes hydration', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    // The first blob-pack request is refused (403); the daemon re-fetches the
    // descriptor and the store accepts the second request.
    api.blobsMode = 'forbidden-once'
    const result = await materializeProject(cfg)
    const hydration = await result.hydration!
    expect(hydration.status).toBe('ok')
    expect(hydration.attempts).toBe(2)
    expect(api.requests.filter((r) => r.path.endsWith('/project-snapshot')).length).toBe(2)
    expect(missingObjects(target)).toBe(0)
  })

  test('a descriptor presigned in the env skips the proxy: one direct GET from the store, then hydration', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha, {
      KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR: envDescriptor(descriptorFor(api, archive.sha)),
    })
    let summary: { s3_descriptor: 'env' | 'proxy' | null } | undefined
    const result = await materializeProject(cfg, { onSummary: (s) => (summary = s) })
    expect(result.provider).toBe('s3')
    expect(result.s3?.descriptorSource).toBe('env')
    expect(summary?.s3_descriptor).toBe('env')
    // The proxy was never asked; the store was asked exactly once for the boot object.
    expect(api.requests.filter((r) => r.path.endsWith('/project-snapshot')).length).toBe(0)
    expect(api.requests.filter((r) => r.path.startsWith('/tree/')).length).toBe(1)
    const hydration = await result.hydration!
    expect(hydration.status).toBe('ok')
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
    expect(missingObjects(target)).toBe(0)
  })

  test('an env descriptor with no lifetime left is ignored: the proxy is asked, once', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha, {
      // 10 s left is under the 30 s margin: not worth starting a transfer on.
      KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR: envDescriptor(descriptorFor(api, archive.sha, 10_000)),
    })
    const result = await materializeProject(cfg)
    expect(result.provider).toBe('s3')
    expect(result.s3?.descriptorSource).toBe('proxy')
    expect(result.s3?.attempts).toBe(1)
    expect(api.requests.filter((r) => r.path.endsWith('/project-snapshot')).length).toBe(1)
    await result.hydration
  })

  test('an env descriptor the store refuses (403) is replaced by a fresh proxy descriptor, not a Git fallback', async () => {
    const target = join(root, 'ws')
    api.archiveMode = 'forbidden-once'
    const cfg = makeConfig(api, target, archive.sha, {
      KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR: envDescriptor(descriptorFor(api, archive.sha)),
    })
    const result = await materializeProject(cfg)
    expect(result.provider).toBe('s3')
    expect(result.fallback).toBeUndefined()
    expect(result.s3?.attempts).toBe(2)
    expect(result.s3?.descriptorSource).toBe('proxy')
    expect(api.requests.filter((r) => r.path.endsWith('/project-snapshot')).length).toBe(1)
    await result.hydration
    expect(missingObjects(target)).toBe(0)
  })

  test('a malformed env descriptor costs one round trip, not the boot', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha, { KORTIX_PROJECT_SNAPSHOT_DESCRIPTOR: 'definitely-not-base64-json' })
    const result = await materializeProject(cfg)
    expect(result.provider).toBe('s3')
    expect(result.s3?.descriptorSource).toBe('proxy')
    expect(api.requests.filter((r) => r.path.endsWith('/project-snapshot')).length).toBe(1)
    await result.hydration
  })

  test('falls back to the in-process extractor when no tar binary is usable', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    const result = await materializeProject(cfg, { tarBinary: join(root, 'no-such-tar') })
    expect(result.provider).toBe('s3')
    expect(result.s3?.extractor).toBe('node-tar')
    await result.hydration
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
    expect(readFileSync(join(target, 'README-link'), 'utf8')).toBe('project v1\n')
    expect(missingObjects(target)).toBe(0)
  })

  test('missing archive (404) falls back to Git at the SAME revision with the reason attributed', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.descriptorStatus = 404
    const marks: string[] = []
    const result = await materializeProject(cfg, { bootMark: (l) => marks.push(l) })
    expect(result.provider).toBe('git')
    expect(result.fallback).toMatchObject({ from: 's3', stage: 'descriptor', reason: 'missing', attempts: 1 })
    expect(result.summary).toMatchObject({ s3_attempted: true, s3_failed: true, s3_reason: 'missing', fallback: true, sha_matches: true, hydration: null })
    expect(marks).toEqual(expect.arrayContaining(['config-provider:s3:failed:missing', 'config-provider:fallback', 'config-provider:git:fallback']))
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
    // No object download was ever attempted for a missing descriptor.
    expect(api.requests.filter((r) => r.path.startsWith('/tree/') || r.path.startsWith('/blobs/'))).toHaveLength(0)
  })

  test('an interrupted transfer is retried with backoff, then falls back once', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.archiveMode = 'cut'
    const result = await materializeProject(cfg, { deadlineMs: 20_000, inactivityTimeoutMs: 500 })
    expect(result.provider).toBe('git')
    expect(result.fallback).toMatchObject({ from: 's3', reason: 'unavailable', attempts: 3 })
    // One GET per provider attempt on Bun 1.4; Bun 1.3 (the sandbox agent's
    // build runtime) re-issues the GET itself after the reset and appends the
    // second response to the same body, so the server may see two per attempt.
    // The provider's own attempt count above is the contract.
    expect(api.requests.filter((r) => r.path.startsWith('/tree/')).length).toBeGreaterThanOrEqual(3)
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
  }, 30_000)

  test('a stalled transfer hits the total deadline and falls back with reason=timeout', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.archiveMode = 'stall'
    const started = Date.now()
    const result = await materializeProject(cfg, { deadlineMs: 1_500 })
    expect(Date.now() - started).toBeLessThan(6_000)
    expect(result.provider).toBe('git')
    expect(result.fallback?.reason).toBe('timeout')
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
  })

  test('a corrupt object fails the digest once (no retry) and falls back', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.archiveMode = 'corrupt'
    const result = await materializeProject(cfg)
    expect(result.provider).toBe('git')
    expect(result.fallback?.reason).toBe('digest-mismatch')
    expect(result.fallback?.attempts).toBe(1)
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
  })

  test('an archive built from another commit is refused as revision-mismatch and falls back', async () => {
    const target = join(root, 'ws')
    const other = await makeSnapshot(root, makeSourceRepo(root, 'v2'), 'other')
    // The server serves the OTHER snapshot, self-consistent (digests match),
    // but the pin/descriptor name the session's base SHA.
    api.archive = { ...other, sha: archive.sha }
    const cfg = makeConfig(api, target, archive.sha, {
      KORTIX_PROJECT_SNAPSHOT_PIN: `${archive.sha}:${other.sha256}:${other.bytes.byteLength}`,
    })
    const result = await materializeProject(cfg)
    expect(result.provider).toBe('git')
    expect(result.fallback).toMatchObject({ stage: 'verify', reason: 'revision-mismatch', attempts: 1 })
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
  })

  test('expired download authorization (403 from storage) falls back without retrying', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.archiveMode = 'forbidden'
    const result = await materializeProject(cfg)
    expect(result.provider).toBe('git')
    expect(result.fallback).toMatchObject({ stage: 'download', reason: 'expired-authorization', attempts: 1 })
  })

  test('no pin (cache miss) is a Git-only start with the reason recorded — not an S3 attempt, not a fallback', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha, { KORTIX_PROJECT_SNAPSHOT_PIN: '' })
    const marks: string[] = []
    const result = await materializeProject(cfg, { bootMark: (l) => marks.push(l) })
    expect(result.provider).toBe('git')
    expect(result.fallback).toBeUndefined()
    expect(result.summary).toMatchObject({ s3_attempted: false, s3_failed: false, s3_skipped: true, s3_stage: 'precondition', s3_reason: 'no-pin', fallback: false })
    expect(marks).toContain('config-provider:s3:skipped:no-pin')
    expect(api.requests).toHaveLength(0)
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
  })

  test('a resumed/replacement (not fresh) session never attempts S3, in every mode', async () => {
    for (const mode of ['prefer-s3', 'require-s3'] as const) {
      const target = join(root, `ws-${mode}`)
      const cfg = makeConfig(api, target, archive.sha, {
        KORTIX_PROJECT_SNAPSHOT_MODE: mode,
        KORTIX_SESSION_FRESH: '0',
        // Not fresh → the Git path fetches the session branch from the remote,
        // which this fake API cannot serve; a scaffold-rooted base still lets
        // the checkout land, and the failure to fetch the branch is the
        // existing (tolerated) behaviour of checkoutSessionBranch.
      })
      const result = await materializeProject(cfg).catch((err) => ({ error: err as Error }))
      // Either the Git path completes (scaffold) or it fails for a Git reason —
      // never an S3 attempt and never an S3 failure.
      if ('error' in result) {
        expect(result.error).not.toBeInstanceOf(ConfigProviderError)
      } else {
        expect(result.provider).toBe('git')
        expect(result.summary).toMatchObject({ s3_attempted: false, s3_skipped: true, s3_reason: 'not-fresh' })
      }
      expect(api.requests.filter((r) => r.path.endsWith('/project-snapshot'))).toHaveLength(0)
    }
  })

  test('authorization denial on the descriptor is a denial: no fallback, nothing materialized', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.descriptorStatus = 403
    let summary: unknown = null
    await expect(materializeProject(cfg, { onSummary: (s) => (summary = s) })).rejects.toMatchObject({ reason: 'denied', stage: 'descriptor' })
    expect(summary).toMatchObject({ outcome: 'error', s3_reason: 'denied', fallback: false })
    expect(existsSync(join(target, '.git'))).toBe(false)
    expect(stageDirs(target)).toEqual([])
  })

  test('cancellation stops acquisition and never falls back; the stage is cleaned', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.archiveMode = 'slow'
    const controller = new AbortController()
    void api.firstHalfSent.then(() => controller.abort(new Error('boot cancelled')))
    await expect(materializeProject(cfg, { signal: controller.signal })).rejects.toMatchObject({ reason: 'cancelled' })
    expect(existsSync(join(target, '.git'))).toBe(false)
    expect(stageDirs(target)).toEqual([])
    expect(api.requests.filter((r) => r.path.startsWith('/tree/'))).toHaveLength(1)
  })

  test('a baked checkout that IS the base is adopted before any provider runs', async () => {
    const target = join(root, 'ws')
    mkdirSync(target)
    git(root, 'clone', '-q', `file://${source.checkout}`, target)
    const cfg = makeConfig(api, target, archive.sha)
    const marks: string[] = []
    const result = await materializeProject(cfg, { bootMark: (l) => marks.push(l) })
    expect(result.provider).toBe('git')
    expect(result.summary.s3_attempted).toBe(false)
    expect(marks).toContain('config-provider:warm')
    expect(api.requests).toHaveLength(0)
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
  })
})

describe('materializeProject — require-s3 and git', () => {
  test('require-s3 fails closed on a missing archive instead of cloning', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha, { KORTIX_PROJECT_SNAPSHOT_MODE: 'require-s3' })
    api.descriptorStatus = 404
    await expect(materializeProject(cfg)).rejects.toMatchObject({ reason: 'missing' })
    expect(existsSync(join(target, '.git'))).toBe(false)
    expect(stageDirs(target)).toEqual([])
  })

  test('require-s3 succeeds on a prepared archive', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha, { KORTIX_PROJECT_SNAPSHOT_MODE: 'require-s3' })
    const result = await materializeProject(cfg)
    expect(result.provider).toBe('s3')
    await result.hydration
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
  })

  test('git mode never contacts the snapshot endpoint (legacy parity, zero S3 traffic)', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha, { KORTIX_PROJECT_SNAPSHOT_MODE: 'git' })
    const result = await materializeProject(cfg)
    expect(result.provider).toBe('git')
    expect(result.summary).toMatchObject({ mode: 'git', s3_attempted: false, fallback: false, sha_matches: true })
    expect(api.requests).toHaveLength(0)
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
  })

  test('mode unset in the config object behaves as git', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    delete cfg.projectSnapshotMode
    const result = await materializeProject(cfg)
    expect(result.provider).toBe('git')
    expect(api.requests).toHaveLength(0)
  })
})

describe('archive safety guards', () => {
  const limits = { maxEntries: 100, maxBytes: 1_000_000 }

  test('rejects traversal, absolute paths, escaping symlinks, special files, hooks and duplicates', () => {
    const guard = makeEntryGuard(limits)
    expect(guard.check('./README.md', { type: 'File', size: 3 })).toBeNull()
    expect(guard.check('./README.md', { type: 'File', size: 3 })).toMatch(/duplicate/)
    expect(guard.check('../evil', { type: 'File', size: 1 })).toMatch(/traversal/)
    expect(guard.check('a/../../evil', { type: 'File', size: 1 })).toMatch(/traversal/)
    expect(guard.check('/etc/passwd', { type: 'File', size: 1 })).toMatch(/absolute/)
    expect(guard.check('./link', { type: 'SymbolicLink', linkpath: '../../etc' })).toMatch(/escapes/)
    expect(guard.check('./abs-link', { type: 'SymbolicLink', linkpath: '/etc/passwd' })).toMatch(/absolute symlink/)
    expect(guard.check('./ok-link', { type: 'SymbolicLink', linkpath: 'README.md' })).toBeNull()
    expect(guard.check('./deep/ok-link', { type: 'SymbolicLink', linkpath: '../README.md' })).toBeNull()
    expect(guard.check('./fifo', { type: 'FIFO' })).toMatch(/unsupported/)
    expect(guard.check('./dev', { type: 'CharacterDevice' })).toMatch(/unsupported/)
    expect(guard.check('./hard', { type: 'Link', linkpath: 'README.md' })).toMatch(/unsupported/)
    expect(guard.check('./.git/hooks/pre-commit', { type: 'File', size: 1 })).toMatch(/hook/)
    expect(guard.check('./.git/hooks', { type: 'Directory' })).toBeNull()
  })

  test('enforces entry-count and uncompressed-size limits', () => {
    const small = makeEntryGuard({ maxEntries: 2, maxBytes: 10 })
    expect(small.check('a', { type: 'File', size: 4 })).toBeNull()
    expect(small.check('b', { type: 'File', size: 4 })).toBeNull()
    expect(small.check('c', { type: 'File', size: 1 })).toMatch(/entry count/)
    const bytes = makeEntryGuard({ maxEntries: 10, maxBytes: 10 })
    expect(bytes.check('big', { type: 'File', size: 11 })).toMatch(/uncompressed size/)
  })

  test('a real archive with a traversal entry is refused before anything is extracted', async () => {
    const evilRoot = join(root, 'evil')
    mkdirSync(join(evilRoot, 'checkout'), { recursive: true })
    writeFileSync(join(evilRoot, 'outside.txt'), 'must not be written\n')
    writeFileSync(join(evilRoot, 'checkout', 'inner.txt'), 'inner\n')
    const evilPath = join(root, 'evil.tar.gz')
    await tar.create({ cwd: join(evilRoot, 'checkout'), file: evilPath, gzip: true, preservePaths: true }, ['inner.txt', '../outside.txt'])
    const bytes = readFileSync(evilPath)
    api.archive = { ...archive, path: evilPath, bytes, sha256: sha256(bytes), entries: 2 }
    const descriptor: ProjectSnapshotDescriptor = {
      format: PROJECT_SNAPSHOT_FORMAT,
      commit_sha: archive.sha,
      ref: 'main',
      repository: { owner: 'kortix', name: 'demo', external_id: EXTERNAL_ID },
      tree: { url: `${api.url}/tree/x.tree.tar.gz`, sha256: api.archive.sha256, bytes: bytes.byteLength, entries: 2, expires_at: '' },
      blobs: { url: `${api.url}/blobs/x.blobs.pack`, sha256: archive.blobs.sha256, bytes: archive.blobs.bytes.byteLength, expires_at: '' },
    }
    const ws = join(root, 'ws')
    const stage = join(ws, '.kortix-snapshot-test')
    mkdirSync(ws, { recursive: true })
    await expect(downloadAndExtractProjectSnapshot(descriptor, stage, { timeoutMs: 5_000 })).rejects.toMatchObject({ stage: 'extract', reason: 'malformed' })
    expect(existsSync(join(ws, 'outside.txt'))).toBe(false)
    // Nothing was extracted at all: the guard verdict lands before the extractor runs.
    expect(existsSync(stage)).toBe(false)
    expect(existsSync(`${stage}.tgz`)).toBe(false)
  })

  test('a .git/config that names a remote, filter, or hooksPath is refused at verify', async () => {
    const target = join(root, 'ws')
    const tainted = join(root, 'tainted-stage')
    git(root, 'clone', '-q', '--depth', '1', `file://${source.checkout}`, tainted)
    // Leave `origin` in place (credential-bearing remotes are exactly what the
    // contract forbids) and add a hooksPath; drop the sample hooks so the
    // failure is attributable to .git/config, not to the hook-entry guard.
    git(tainted, 'config', '--local', 'core.hooksPath', '/tmp/hooks')
    rmSync(join(tainted, '.git', 'hooks'), { recursive: true, force: true })
    rmSync(join(tainted, '.git', 'logs'), { recursive: true, force: true })
    writeFileSync(
      join(tainted, '.git', 'kortix-project-snapshot.json'),
      `${JSON.stringify({ format: PROJECT_SNAPSHOT_FORMAT, repository: { owner: 'kortix', name: 'demo', external_id: EXTERNAL_ID }, ref: 'main', commit_sha: archive.sha })}\n`,
    )
    const packed = await packDir(tainted, join(root, 'tainted.tar.gz'))
    api.archive = { ...packed, sha: archive.sha, blobs: archive.blobs }
    const cfg = makeConfig(api, target, archive.sha, {
      KORTIX_PROJECT_SNAPSHOT_MODE: 'require-s3',
      KORTIX_PROJECT_SNAPSHOT_PIN: `${archive.sha}:${api.archive.sha256}:${packed.bytes.byteLength}`,
    })
    await expect(materializeProject(cfg)).rejects.toMatchObject({ stage: 'verify', reason: 'malformed' })
    expect(existsSync(join(target, '.git'))).toBe(false)
  })

  test('a snapshot whose pack is not marked promisor is refused at verify', async () => {
    const target = join(root, 'ws')
    const plain = join(root, 'plain-stage')
    git(root, 'clone', '-q', '--depth', '1', `file://${source.checkout}`, plain)
    git(plain, 'remote', 'remove', 'origin')
    rmSync(join(plain, '.git', 'hooks'), { recursive: true, force: true })
    rmSync(join(plain, '.git', 'logs'), { recursive: true, force: true })
    writeFileSync(
      join(plain, '.git', 'kortix-project-snapshot.json'),
      `${JSON.stringify({ format: PROJECT_SNAPSHOT_FORMAT, repository: { owner: 'kortix', name: 'demo', external_id: EXTERNAL_ID }, ref: 'main', commit_sha: archive.sha })}\n`,
    )
    const packed = await packDir(plain, join(root, 'plain.tar.gz'))
    api.archive = { ...packed, sha: archive.sha, blobs: archive.blobs }
    const cfg = makeConfig(api, target, archive.sha, {
      KORTIX_PROJECT_SNAPSHOT_MODE: 'require-s3',
      KORTIX_PROJECT_SNAPSHOT_PIN: `${archive.sha}:${api.archive.sha256}:${packed.bytes.byteLength}`,
    })
    await expect(materializeProject(cfg)).rejects.toMatchObject({ stage: 'verify', reason: 'malformed' })
    expect(existsSync(join(target, '.git'))).toBe(false)
  })
})
