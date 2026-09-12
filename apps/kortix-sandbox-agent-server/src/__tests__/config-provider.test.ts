/**
 * Config provider (src/config-provider): S3 acquisition, classified failures,
 * bounded fallback to Git, strict mode, cancellation, denial, and the archive
 * safety guards — driven through the REAL coordinator with a real tar.gz
 * served by a local HTTP server standing in for the Git proxy + object store.
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
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Snapshot Test',
      GIT_AUTHOR_EMAIL: 'snapshot@kortix.test',
      GIT_COMMITTER_NAME: 'Snapshot Test',
      GIT_COMMITTER_EMAIL: 'snapshot@kortix.test',
    },
    encoding: 'utf8',
  }).trim()
}

function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

interface Archive {
  path: string
  bytes: Buffer
  sha256: string
  sha: string
  entries: number
}

/** A committed project (several files so gzip streams multiple entries) and its sanitized snapshot archive. */
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
async function packDir(dir: string, path: string): Promise<Archive> {
  let entries = 0
  await tar.create(
    { cwd: dir, file: path, gzip: true, portable: true, noMtime: true, filter: () => (entries += 1, true) },
    ['.'],
  )
  const bytes = readFileSync(path)
  return { path, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), sha: '', entries }
}

/** What the API producer ships: committed tree + sanitized shallow .git + marker, tar.gz. */
async function makeArchive(root: string, source: { checkout: string; sha: string }, label = 'archive'): Promise<Archive> {
  const stage = join(root, `${label}-stage`)
  git(root, 'clone', '-q', '--depth', '1', `file://${source.checkout}`, stage)
  git(stage, 'remote', 'remove', 'origin')
  rmSync(join(stage, '.git', 'logs'), { recursive: true, force: true })
  rmSync(join(stage, '.git', 'hooks'), { recursive: true, force: true })
  writeFileSync(
    join(stage, '.git', 'kortix-project-snapshot.json'),
    `${JSON.stringify({
      format: PROJECT_SNAPSHOT_FORMAT,
      repository: { owner: 'kortix', name: 'demo', external_id: EXTERNAL_ID },
      ref: 'main',
      commit_sha: source.sha,
    })}\n`,
  )
  const packed = await packDir(stage, join(root, `${label}.tar.gz`))
  return { ...packed, sha: source.sha }
}

interface FakeApi {
  url: string
  requests: Array<{ path: string; auth: string | null }>
  descriptorStatus: number
  archiveMode: 'ok' | 'forbidden' | 'stall' | 'cut' | 'corrupt' | 'slow'
  archive: Archive
  firstHalfSent: Promise<void>
  stop: () => void
}

function startFakeApi(archive: Archive, opts: { deadlineStallMs?: number } = {}): FakeApi {
  let resolveFirstHalf!: () => void
  const firstHalfSent = new Promise<void>((r) => {
    resolveFirstHalf = r
  })
  const state: FakeApi = {
    url: '',
    requests: [],
    descriptorStatus: 200,
    archiveMode: 'ok',
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
      const descriptor: ProjectSnapshotDescriptor = {
        format: PROJECT_SNAPSHOT_FORMAT,
        commit_sha: url.searchParams.get('sha') ?? '',
        ref: 'main',
        repository: { owner: 'kortix', name: 'demo', external_id: EXTERNAL_ID },
        archive: {
          url: `${state.url}/archive/${state.archive.sha256}.tar.gz?X-Amz-Signature=test-signature`,
          sha256: state.archive.sha256,
          bytes: state.archive.bytes.byteLength,
          entries: state.archive.entries,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(descriptor))
      return
    }
    if (url.pathname.startsWith('/archive/')) {
      const body = state.archive.bytes
      const half = Math.floor(body.length / 2)
      switch (state.archiveMode) {
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
  const address = server.address() as AddressInfo
  state.url = `http://127.0.0.1:${address.port}`
  state.stop = () => {
    server.closeAllConnections?.()
    server.close()
  }
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
let archive: Archive
let api: FakeApi

beforeEach(async () => {
  __clearRepoIdentityMemoForTests()
  root = tmp('kortix-config-provider-')
  source = makeSourceRepo(root)
  archive = await makeArchive(root, source)
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

function stageDirs(target: string): string[] {
  return existsSync(target) ? readdirSync(target).filter((n) => n.startsWith('.kortix-')) : []
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
  test('acquires the pinned archive by streaming, activates it, and delivers the Git checkout contract', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.archiveMode = 'slow'
    const marks: string[] = []
    // Overlap proof: after the first half of the body has been sent and the
    // server is pausing, files from that half must already be on disk in the
    // private stage — extraction did not wait for the download to finish.
    const overlap = api.firstHalfSent.then(async () => {
      await new Promise((r) => setTimeout(r, 250))
      const stages = stageDirs(target)
      const files = stages.flatMap((s) => {
        const dir = join(target, s)
        return existsSync(dir) ? readdirSync(dir, { recursive: true }) : []
      })
      return { stages, files: files.length }
    })
    const result = await materializeProject(cfg, { bootMark: (l) => marks.push(l) })
    const observed = await overlap

    expect(result.provider).toBe('s3')
    expect(result.fallback).toBeUndefined()
    expect(result.sha).toBe(archive.sha)
    expect(result.summary.sha_matches).toBe(true)
    expect(result.s3?.attempts).toBe(1)
    expect(result.s3?.bytes).toBe(archive.bytes.byteLength)
    expect(observed.stages.length).toBe(1)
    expect(observed.files).toBeGreaterThan(0)
    expect(marks).toContain('config-provider:s3:ok')
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
    // The symlink committed in the source survives as a symlink.
    expect(readFileSync(join(target, 'README-link'), 'utf8')).toBe('project v1\n')
    // Descriptor carried the sandbox credential; the archive request did not.
    const descriptorReq = api.requests.find((r) => r.path.endsWith('/project-snapshot'))
    const archiveReq = api.requests.find((r) => r.path.startsWith('/archive/'))
    expect(descriptorReq?.auth).toBe(`Bearer ${TOKEN}`)
    expect(archiveReq?.auth).toBeNull()
  })

  test('missing archive (404) falls back to Git at the SAME revision with the reason attributed', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.descriptorStatus = 404
    const marks: string[] = []
    const result = await materializeProject(cfg, { bootMark: (l) => marks.push(l) })
    expect(result.provider).toBe('git')
    expect(result.fallback).toMatchObject({ from: 's3', stage: 'descriptor', reason: 'missing', attempts: 1 })
    expect(result.summary).toMatchObject({ s3_attempted: true, s3_failed: true, s3_reason: 'missing', fallback: true, sha_matches: true })
    expect(marks).toEqual(expect.arrayContaining(['config-provider:s3:failed:missing', 'config-provider:fallback', 'config-provider:git:fallback']))
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
    // No archive download was ever attempted for a missing descriptor.
    expect(api.requests.filter((r) => r.path.startsWith('/archive/'))).toHaveLength(0)
  })

  test('an interrupted transfer is retried with backoff, then falls back once', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.archiveMode = 'cut'
    const result = await materializeProject(cfg, { deadlineMs: 20_000, inactivityTimeoutMs: 500 })
    expect(result.provider).toBe('git')
    expect(result.fallback).toMatchObject({ from: 's3', reason: 'unavailable', attempts: 3 })
    expect(api.requests.filter((r) => r.path.startsWith('/archive/'))).toHaveLength(3)
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

  test('a corrupt archive fails verification once (no retry) and falls back', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha)
    api.archiveMode = 'corrupt'
    const result = await materializeProject(cfg)
    expect(result.provider).toBe('git')
    expect(['digest-mismatch', 'malformed']).toContain(result.fallback?.reason)
    expect(result.fallback?.attempts).toBe(1)
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
  })

  test('an archive built from another commit is refused as revision-mismatch and falls back', async () => {
    const target = join(root, 'ws')
    const other = await makeArchive(root, makeSourceRepo(root, 'v2'), 'other')
    // The server serves the OTHER archive, self-consistent (digest matches),
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

  test('no pin (cache miss) skips S3 entirely and records the reason', async () => {
    const target = join(root, 'ws')
    const cfg = makeConfig(api, target, archive.sha, { KORTIX_PROJECT_SNAPSHOT_PIN: '' })
    const result = await materializeProject(cfg)
    expect(result.provider).toBe('git')
    expect(result.fallback).toMatchObject({ stage: 'precondition', reason: 'no-pin' })
    expect(api.requests).toHaveLength(0)
    await expectWorkspaceAtSha(target, archive.sha, cfg.repoUrl!)
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
    expect(api.requests.filter((r) => r.path.startsWith('/archive/'))).toHaveLength(1)
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

  test('a real archive with a traversal entry is refused before anything escapes the stage', async () => {
    const evilRoot = join(root, 'evil')
    mkdirSync(join(evilRoot, 'checkout'), { recursive: true })
    writeFileSync(join(evilRoot, 'outside.txt'), 'must not be written\n')
    writeFileSync(join(evilRoot, 'checkout', 'inner.txt'), 'inner\n')
    const evilPath = join(root, 'evil.tar.gz')
    await tar.create({ cwd: join(evilRoot, 'checkout'), file: evilPath, gzip: true, preservePaths: true }, ['inner.txt', '../outside.txt'])
    const bytes = readFileSync(evilPath)
    const evil: Archive = { path: evilPath, bytes, sha256: createHash('sha256').update(bytes).digest('hex'), sha: archive.sha, entries: 2 }
    api.archive = evil
    const descriptor: ProjectSnapshotDescriptor = {
      format: PROJECT_SNAPSHOT_FORMAT,
      commit_sha: archive.sha,
      ref: 'main',
      repository: { owner: 'kortix', name: 'demo', external_id: EXTERNAL_ID },
      archive: { url: `${api.url}/archive/x.tar.gz`, sha256: evil.sha256, bytes: bytes.byteLength, entries: 2, expires_at: '' },
    }
    const stage = join(root, 'ws', '.kortix-snapshot-test')
    mkdirSync(join(root, 'ws'), { recursive: true })
    await expect(downloadAndExtractProjectSnapshot(descriptor, stage, { timeoutMs: 5_000 })).rejects.toMatchObject({ stage: 'extract', reason: 'malformed' })
    expect(existsSync(join(root, 'ws', 'outside.txt'))).toBe(false)
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
    api.archive = { ...packed, sha: archive.sha }
    const cfg = makeConfig(api, target, archive.sha, {
      KORTIX_PROJECT_SNAPSHOT_MODE: 'require-s3',
      KORTIX_PROJECT_SNAPSHOT_PIN: `${archive.sha}:${api.archive.sha256}:${packed.bytes.byteLength}`,
    })
    await expect(materializeProject(cfg)).rejects.toMatchObject({ stage: 'verify', reason: 'malformed' })
    expect(existsSync(join(target, '.git'))).toBe(false)
  })
})
