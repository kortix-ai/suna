import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { loadOpenCodeConfig as loadConfig } from '../harness/open-code/config'
import { resolveHintedOpencodeConfigDir } from '../harness/open-code/config'
import { __setScaffoldRepoPathForTests, buildFastBootBundleUrl, isShallowRepo, materializeRepo } from '../git'

const roots: string[] = []
const realFetch = globalThis.fetch
const PINNED = {
  GIT_AUTHOR_NAME: 'Kortix',
  GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
  GIT_COMMITTER_NAME: 'Kortix',
  GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: { ...process.env, ...PINNED }, encoding: 'utf8' }).trim()
}

afterEach(() => {
  globalThis.fetch = realFetch
  __setScaffoldRepoPathForTests()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A starter-seeded project: scaffold root + `commits` project commits. */
function seed(commits: number, opts: { big?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kortix-fast-boot-delta-'))
  roots.push(root)
  const source = join(root, 'source')
  mkdirSync(source)
  git(source, 'init', '-q', '-b', 'main')
  writeFileSync(join(source, 'README.md'), 'generic scaffold\n')
  git(source, 'add', '-A')
  git(source, 'commit', '-q', '-m', 'chore: scaffold Kortix project')
  const scaffoldSha = git(source, 'rev-parse', 'HEAD')
  const scaffoldRepo = join(root, 'scaffold.git')
  git(root, 'clone', '-q', '--bare', source, scaffoldRepo)
  for (let i = 1; i <= commits; i += 1) {
    writeFileSync(join(source, `file-${i}.txt`), `change ${i}\n`)
    if (opts.big && i === commits) writeFileSync(join(source, 'blob.bin'), randomBytes(300 * 1024))
    git(source, 'add', '-A')
    git(source, 'commit', '-q', '-m', `feat: change ${i}`)
  }
  const baseSha = git(source, 'rev-parse', 'HEAD')
  const bundlePath = join(root, 'delta.bundle')
  git(source, 'bundle', 'create', bundlePath, 'refs/heads/main', `^${scaffoldSha}`)
  const bundle = readFileSync(bundlePath)
  const parentCommit = execFileSync('git', ['cat-file', 'commit', scaffoldSha], { cwd: source })
  const target = join(root, 'workspace')
  mkdirSync(target)
  __setScaffoldRepoPathForTests(scaffoldRepo)
  return { root, source, scaffoldSha, baseSha, bundle, parentCommitBase64: parentCommit.toString('base64'), target }
}

function baseEnv(
  p: { target: string; baseSha: string; scaffoldSha: string; parentCommitBase64: string },
  repoUrl: string,
): Record<string, string> {
  return {
    KORTIX_PROJECT_AUTO_CLONE: '1',
    KORTIX_PROJECT_TARGET: p.target,
    KORTIX_WORKSPACE: p.target,
    KORTIX_PROJECT_ID: '11111111-1111-4111-8111-111111111111',
    KORTIX_REPO_URL: repoUrl,
    KORTIX_TOKEN: 'sandbox-token',
    KORTIX_BRANCH_NAME: 'sess-1',
    KORTIX_SESSION_FRESH: '1',
    KORTIX_BASE_SHA: p.baseSha,
    KORTIX_GIT_DELTA_PARENT_SHA: p.scaffoldSha,
    KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64: p.parentCommitBase64,
  }
}

describe('fast-boot delta materialization', () => {
  test('applies an inline multi-commit bundle on the baked scaffold with zero network', async () => {
    const p = seed(5)
    globalThis.fetch = (async () => {
      throw new Error('network must not be touched')
    }) as unknown as typeof fetch
    const cfg = loadConfig({
      ...baseEnv(p, 'https://api.kortix.test/v1/git/11111111-1111-4111-8111-111111111111.git'),
      KORTIX_GIT_DELTA_BUNDLE_BASE64: p.bundle.toString('base64'),
    })
    await materializeRepo(cfg)
    expect(git(p.target, 'rev-parse', 'HEAD')).toBe(p.baseSha)
    expect(git(p.target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sess-1')
    expect(git(p.target, 'rev-parse', 'main')).toBe(p.baseSha)
    expect(git(p.target, 'rev-list', '--count', 'HEAD')).toBe('6')
    expect(readFileSync(join(p.target, 'file-5.txt'), 'utf8')).toBe('change 5\n')
    expect(git(p.target, 'remote', 'get-url', 'origin')).toContain('/v1/git/')
  })

  test('downloads a REMOTE bundle with one authenticated GET and applies it', async () => {
    const p = seed(3, { big: true })
    expect(p.bundle.byteLength).toBeGreaterThan(24 * 1024)
    const repoUrl = 'https://api.kortix.test/v1/git/11111111-1111-4111-8111-111111111111.git'
    const calls: { url: string; auth: string | undefined }[] = []
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
      calls.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization })
      return new Response(p.bundle, {
        status: 200,
        headers: { 'content-type': 'application/x-git-bundle', 'content-length': String(p.bundle.byteLength) },
      })
    }) as unknown as typeof fetch
    const cfg = loadConfig({ ...baseEnv(p, repoUrl), KORTIX_GIT_DELTA_BUNDLE_REMOTE: '1' })
    await materializeRepo(cfg)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(buildFastBootBundleUrl(repoUrl, 'main', p.baseSha, p.scaffoldSha))
    expect(calls[0]!.auth).toBe('Bearer sandbox-token')
    expect(git(p.target, 'rev-parse', 'HEAD')).toBe(p.baseSha)
    expect(git(p.target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sess-1')
    expect(readFileSync(join(p.target, 'file-3.txt'), 'utf8')).toBe('change 3\n')
  })

  test('falls back to a single-round-trip shallow fetch when the bundle route fails', async () => {
    const p = seed(4)
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response('fast-boot bundle unavailable', { status: 503 })
    }) as unknown as typeof fetch
    // A local upstream stands in for the proxy: what matters is the fetch shape.
    const cfg = loadConfig({ ...baseEnv(p, `file://${p.source}`), KORTIX_GIT_DELTA_BUNDLE_REMOTE: '1' })
    await materializeRepo(cfg)
    expect(calls).toBe(1)
    expect(git(p.target, 'rev-parse', 'HEAD')).toBe(p.baseSha)
    expect(git(p.target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sess-1')
    // `--depth 1`: one negotiation round, history restored later off the critical path.
    expect(await isShallowRepo(p.target)).toBe(true)
  })

  test('materializes a bundle whose provider parent differs from the scaffold commit (same tree)', async () => {
    // The provider rebuilt the parent commit (new SHA, same tree) and ships its
    // raw bytes in KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64; the daemon recreates
    // that commit over the scaffold tree and applies the bundle on it.
    const root = mkdtempSync(join(tmpdir(), 'kortix-provider-parent-'))
    roots.push(root)
    const source = join(root, 'source')
    mkdirSync(source)
    git(source, 'init', '-q', '-b', 'main')
    writeFileSync(join(source, 'README.md'), 'generic scaffold\n')
    git(source, 'add', '-A')
    git(source, 'commit', '-q', '-m', 'chore: scaffold Kortix project')
    const scaffoldSha = git(source, 'rev-parse', 'HEAD')
    const scaffoldRepo = join(root, 'scaffold.git')
    git(root, 'clone', '-q', '--bare', source, scaffoldRepo)
    const target = join(root, 'workspace')
    mkdirSync(target)
    __setScaffoldRepoPathForTests(scaffoldRepo)
    const p = { root, source, scaffoldSha, target, baseSha: '', parentCommitBase64: '' }
    globalThis.fetch = (async () => {
      throw new Error('network must not be touched')
    }) as unknown as typeof fetch
    execFileSync('git', ['commit', '-q', '--amend', '--no-edit'], {
      cwd: p.source,
      env: { ...process.env, ...PINNED, GIT_AUTHOR_DATE: '2026-01-02T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z' },
    })
    const providerParentSha = git(p.source, 'rev-parse', 'HEAD')
    expect(providerParentSha).not.toBe(p.scaffoldSha)
    const parentCommit = execFileSync('git', ['cat-file', 'commit', providerParentSha], { cwd: p.source })
    writeFileSync(join(p.source, 'README.md'), 'project setup\n')
    git(p.source, 'add', '-A')
    git(p.source, 'commit', '-q', '-m', 'feat: project setup')
    const baseSha = git(p.source, 'rev-parse', 'HEAD')
    const bundlePath = join(p.root, 'provider.bundle')
    git(p.source, 'bundle', 'create', bundlePath, 'refs/heads/main', `^${providerParentSha}`)

    const cfg = loadConfig({
      ...baseEnv(p, `file://${p.source}`),
      KORTIX_BASE_SHA: baseSha,
      KORTIX_GIT_DELTA_PARENT_SHA: providerParentSha,
      KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64: parentCommit.toString('base64'),
      KORTIX_GIT_DELTA_BUNDLE_BASE64: readFileSync(bundlePath).toString('base64'),
    })
    await materializeRepo(cfg)
    expect(git(p.target, 'rev-parse', 'HEAD')).toBe(baseSha)
    expect(git(p.target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sess-1')
    expect(readFileSync(join(p.target, 'README.md'), 'utf8')).toBe('project setup\n')
  })

  // A delta the scaffold cannot prove must never land a wrong tree: it falls
  // back to a Git fetch of the base.
  test.each([
    ['the scaffold does not hold the parent tree', 'other-scaffold'],
    ['the parent commit payload is forged', 'forged-parent'],
  ] as const)('a bad delta (%s) falls back to a Git fetch and lands on base', async (_name, fault) => {
    const p = seed(2)
    let parentCommitBase64 = p.parentCommitBase64
    if (fault === 'other-scaffold') {
      const other = mkdtempSync(join(tmpdir(), 'kortix-other-scaffold-'))
      roots.push(other)
      const otherSrc = join(other, 'src')
      mkdirSync(otherSrc)
      git(otherSrc, 'init', '-q', '-b', 'main')
      writeFileSync(join(otherSrc, 'README.md'), 'unrelated starter\n')
      git(otherSrc, 'add', '-A')
      git(otherSrc, 'commit', '-q', '-m', 'chore: other scaffold')
      const otherBare = join(other, 'scaffold.git')
      git(other, 'clone', '-q', '--bare', otherSrc, otherBare)
      __setScaffoldRepoPathForTests(otherBare)
    } else {
      parentCommitBase64 = Buffer.from('forged parent commit').toString('base64')
    }
    const cfg = loadConfig({
      ...baseEnv(p, `file://${p.source}`),
      KORTIX_GIT_DELTA_PARENT_COMMIT_BASE64: parentCommitBase64,
      KORTIX_GIT_DELTA_BUNDLE_BASE64: p.bundle.toString('base64'),
    })
    await materializeRepo(cfg)
    expect(git(p.target, 'rev-parse', 'HEAD')).toBe(p.baseSha)
    expect(readFileSync(join(p.target, 'file-2.txt'), 'utf8')).toBe('change 2\n')
    expect(readFileSync(join(p.target, 'README.md'), 'utf8')).toBe('generic scaffold\n')
    // The fallback is a real Git fetch; it measured up to ~5 s on a loaded host.
  }, 20_000)
})

describe('resolveHintedOpencodeConfigDir', () => {
  const cfg = loadConfig({ KORTIX_PROJECT_TARGET: '/workspace', KORTIX_DEFAULT_OPENCODE_CONFIG_DIR: '/ephemeral/oc' })
  test('maps the API hint to the dir OpenCode will read at Instance init', () => {
    expect(resolveHintedOpencodeConfigDir({ ...cfg, opencodeConfigDirHint: '.kortix/opencode' })).toBe(
      '/workspace/.kortix/opencode',
    )
    expect(resolveHintedOpencodeConfigDir({ ...cfg, opencodeConfigDirHint: '' })).toBe('/ephemeral/oc')
    expect(resolveHintedOpencodeConfigDir({ ...cfg, opencodeConfigDirHint: undefined })).toBeNull()
  })
  test('refuses anything that is not a plain relative path', () => {
    for (const bad of ['/etc', '../x', 'a/../b', '-flag', ':(top)*']) {
      expect(resolveHintedOpencodeConfigDir({ ...cfg, opencodeConfigDirHint: bad })).toBeNull()
    }
  })
})
