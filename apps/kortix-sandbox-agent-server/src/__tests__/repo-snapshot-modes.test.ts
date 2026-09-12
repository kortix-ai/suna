/**
 * `materializeRepo` under each snapshot mode, plus shared-artifact identity.
 *
 * Drives the REAL materialization path with a real archive served over a real
 * local HTTP server, so the mode semantics are exercised where they actually
 * live rather than asserted against a mock.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as tar from 'tar'

import { createCompressor } from '../snapshot-codec'
import { loadConfig } from '../config'
import { __resetRepoTransportAttributionForTests, materializeRepo, readRepoTransportAttribution } from '../git'
import { REPO_SNAPSHOT_EMBEDDED_MANIFEST } from '../repo-snapshot'

const roots: string[] = []
const servers: Server[] = []
const REPOSITORY_ID = '1296269'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Mode Fixture',
      GIT_AUTHOR_EMAIL: 'mode@example.invalid',
      GIT_COMMITTER_NAME: 'Mode Fixture',
      GIT_COMMITTER_EMAIL: 'mode@example.invalid',
    },
    encoding: 'utf8',
  }).trim()
}

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

/** One project-NEUTRAL archive: no origin, no project id, just the revision. */
async function makeArchive(): Promise<{ archive: string; sha256: string; sha: string }> {
  const root = tempRoot('kortix-mode-fixture-')
  const checkout = join(root, 'checkout')
  mkdirSync(checkout)
  git(checkout, 'init', '-b', 'main')
  writeFileSync(join(checkout, 'README.md'), 'shared revision\n')
  git(checkout, 'add', '-A')
  git(checkout, 'commit', '-m', 'shared')
  const sha = git(checkout, 'rev-parse', 'HEAD')
  git(checkout, 'checkout', '--detach', sha)
  rmSync(join(checkout, '.git', 'logs'), { recursive: true, force: true })
  rmSync(join(checkout, '.git', 'hooks'), { recursive: true, force: true })
  rmSync(join(checkout, '.git', 'refs', 'heads', 'main'), { force: true })
  writeFileSync(
    join(checkout, REPO_SNAPSHOT_EMBEDDED_MANIFEST),
    `${JSON.stringify({
      format: 'kortix.project-snapshot.v1',
      source: {
        provider: 'github',
        repository_id: REPOSITORY_ID,
        owner: 'kortix-ai',
        repo: 'shared',
        commit_sha: sha,
        tree_sha: git(checkout, 'rev-parse', 'HEAD^{tree}'),
      },
      checkout: { git_metadata: 'sanitized-shallow', layout_version: 1 },
      producer_version: 'test',
    })}\n`,
  )
  const archive = join(root, 'snapshot.tar.gz')
  await pipeline(
    tar.create({ cwd: checkout, portable: true, noMtime: true }, ['.']),
    createCompressor('gzip'),
    createWriteStream(archive),
  )
  return { archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), sha }
}

async function serve(body: Buffer, status = 200): Promise<string> {
  const server = createServer((_req, res) => {
    if (status !== 200) {
      res.writeHead(status)
      res.end('denied')
      return
    }
    res.writeHead(200, { 'content-length': String(body.byteLength) })
    res.end(body)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/snapshot`
}

function configFor(options: {
  mode: string
  url?: string
  sha256?: string
  sha: string
  target: string
  branch: string
  repositoryId?: string
}) {
  return loadConfig({
    KORTIX_PROJECT_TARGET: options.target,
    KORTIX_PROJECT_AUTO_CLONE: '1',
    KORTIX_PROJECT_ID: '11111111-1111-4111-8111-111111111111',
    // Any clone attempt must go somewhere unreachable so a silent fallback to
    // the Git path fails loudly instead of quietly succeeding.
    KORTIX_REPO_URL: 'https://api.kortix.invalid/v1/git/project.git',
    KORTIX_API_URL: 'https://api.kortix.invalid/v1',
    KORTIX_TOKEN: 'sandbox-token',
    KORTIX_SESSION_FRESH: '1',
    KORTIX_BRANCH_NAME: options.branch,
    KORTIX_BASE_SHA: options.sha,
    KORTIX_REPO_SNAPSHOT_MODE: options.mode,
    ...(options.url ? { KORTIX_REPO_SNAPSHOT_URL: options.url } : {}),
    ...(options.sha256 ? { KORTIX_REPO_SNAPSHOT_SHA256: options.sha256 } : {}),
    KORTIX_REPO_SNAPSHOT_COMPRESSION: 'gzip',
    KORTIX_REPO_SNAPSHOT_COMMIT_SHA: options.sha,
    KORTIX_REPO_SNAPSHOT_REPOSITORY_ID: options.repositoryId ?? REPOSITORY_ID,
  } as NodeJS.ProcessEnv)
}

// The attribution counter is module state shared by every test in this bun
// process, so it is reset BEFORE each test as well as after: the zero-network
// assertions must describe this test, not whatever ran before it.
beforeEach(() => {
  __resetRepoTransportAttributionForTests()
})

afterEach(async () => {
  __resetRepoTransportAttributionForTests()
  for (const server of servers.splice(0)) await new Promise<void>((r) => server.close(() => r()))
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('materializeRepo under each snapshot mode', () => {
  test('prefer: adopts the archive, installs this session origin and branch', async () => {
    const fixture = await makeArchive()
    const url = await serve(readFileSync(fixture.archive))
    const target = join(tempRoot('kortix-mode-target-'), 'workspace')

    await materializeRepo(
      configFor({ mode: 'prefer', url, sha256: fixture.sha256, sha: fixture.sha, target, branch: 'session-a' }),
    )

    expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('shared revision\n')
    expect(git(target, 'rev-parse', 'HEAD')).toBe(fixture.sha)
    expect(git(target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('session-a')
    // The archive ships NO origin; the session installs its own.
    expect(git(target, 'remote', 'get-url', 'origin')).toBe('https://api.kortix.invalid/v1/git/project.git')
    const attribution = readRepoTransportAttribution()
    expect(attribution.snapshot?.used).toBe(true)
    expect(attribution.gitNetworkOps).toBe(0)
  }, 60_000)

  test('one artifact serves two sessions, each with its own branch', async () => {
    const fixture = await makeArchive()
    const body = readFileSync(fixture.archive)
    const first = join(tempRoot('kortix-mode-target-'), 'workspace')
    const second = join(tempRoot('kortix-mode-target-'), 'workspace')

    await materializeRepo(
      configFor({
        mode: 'prefer',
        url: await serve(body),
        sha256: fixture.sha256,
        sha: fixture.sha,
        target: first,
        branch: 'session-one',
      }),
    )
    __resetRepoTransportAttributionForTests()
    await materializeRepo(
      configFor({
        mode: 'prefer',
        url: await serve(body),
        sha256: fixture.sha256,
        sha: fixture.sha,
        target: second,
        branch: 'session-two',
      }),
    )

    expect(git(first, 'rev-parse', 'HEAD')).toBe(git(second, 'rev-parse', 'HEAD'))
    expect(git(first, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('session-one')
    expect(git(second, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('session-two')
    // Separate workspaces: a write in one is invisible to the other.
    writeFileSync(join(first, 'only-in-one.txt'), 'x\n')
    expect(existsSync(join(second, 'only-in-one.txt'))).toBe(false)
  }, 120_000)

  test('shadow: verifies the archive and then leaves the workspace to the existing path', async () => {
    const fixture = await makeArchive()
    const url = await serve(readFileSync(fixture.archive))
    const target = join(tempRoot('kortix-mode-target-'), 'workspace')

    // The Git fallback cannot reach its remote, so shadow must fail the clone
    // rather than adopt the archive. That failure IS the assertion: shadow does
    // not mutate the live workspace.
    await expect(
      materializeRepo(
        configFor({ mode: 'shadow', url, sha256: fixture.sha256, sha: fixture.sha, target, branch: 'session-a' }),
      ),
    ).rejects.toThrow()
    expect(existsSync(join(target, 'README.md'))).toBe(false)
    expect(readRepoTransportAttribution().snapshot?.used).toBe(false)
  }, 120_000)

  test('required: a missing descriptor fails closed instead of cloning', async () => {
    const fixture = await makeArchive()
    const target = join(tempRoot('kortix-mode-target-'), 'workspace')
    await expect(
      materializeRepo(configFor({ mode: 'required', sha: fixture.sha, target, branch: 'session-a' })),
    ).rejects.toThrow(/carries no snapshot descriptor/)
    expect(readRepoTransportAttribution().gitNetworkOps).toBe(0)
  }, 60_000)

  test('required: an identity mismatch fails closed, never substitutes a revision', async () => {
    const fixture = await makeArchive()
    const url = await serve(readFileSync(fixture.archive))
    const target = join(tempRoot('kortix-mode-target-'), 'workspace')
    await expect(
      materializeRepo(
        configFor({
          mode: 'required',
          url,
          sha256: fixture.sha256,
          sha: fixture.sha,
          target,
          branch: 'session-a',
          repositoryId: '999999',
        }),
      ),
    ).rejects.toThrow(/identity does not match/)
    expect(existsSync(join(target, 'README.md'))).toBe(false)
    expect(readRepoTransportAttribution().gitNetworkOps).toBe(0)
  }, 60_000)

  test('off: the descriptor is ignored entirely', async () => {
    const fixture = await makeArchive()
    const url = await serve(readFileSync(fixture.archive))
    const target = join(tempRoot('kortix-mode-target-'), 'workspace')
    await expect(
      materializeRepo(
        configFor({ mode: 'off', url, sha256: fixture.sha256, sha: fixture.sha, target, branch: 'session-a' }),
      ),
    ).rejects.toThrow()
    expect(readRepoTransportAttribution().snapshot).toBeNull()
    // It attempted the existing clone path, which is exactly the rollback shape.
    expect(readRepoTransportAttribution().gitNetworkOps).toBeGreaterThan(0)
  }, 120_000)
})
