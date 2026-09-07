import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { loadConfig } from '../config'
import { __setScaffoldRepoPathForTests, materializeRepo } from '../git'

/**
 * `materializeRepo` used to reuse the on-disk checkout ONLY when
 * `bakedHead === cfg.baseSha`. Every other value cleared the directory and
 * re-downloaded the repository, deleting objects it was about to fetch again.
 * `tryReuseCheckoutDelta` advances that checkout instead.
 *
 * The wipe was self-healing by construction, so these tests pin the two guards
 * that earn that property back. Both were written against a reproduced failure:
 * without the identity guard a workspace holding a DIFFERENT project fetched
 * into the same object database and produced a repo with two unrelated roots;
 * without the integrity guard a truncated pack passed `rev-parse HEAD` (which
 * reads a loose ref, not an object) and the session booted on a repo whose
 * `fsck` failed.
 *
 * Origins are `file://` URLs on purpose: `git clone /abs/path` IGNORES `--depth`
 * and hardlinks the object database, so a plain path cannot express "this disk
 * is missing the newer objects" at all.
 */

const roots: string[] = []
const PINNED = {
  GIT_AUTHOR_NAME: 'Kortix',
  GIT_AUTHOR_EMAIL: 'noreply@kortix.ai',
  GIT_COMMITTER_NAME: 'Kortix',
  GIT_COMMITTER_EMAIL: 'noreply@kortix.ai',
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    env: { ...process.env, ...PINNED },
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  }).trim()
}

function gitQuiet(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: { ...process.env, ...PINNED }, stdio: 'ignore' })
}

/** True when the command succeeds — used to ask "is this object present?". */
function gitOk(cwd: string, ...args: string[]): boolean {
  try {
    gitQuiet(cwd, ...args)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  __setScaffoldRepoPathForTests()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** A bare origin on `main` with `commits` commits. Returns every SHA in order. */
function seedOrigin(commits: number, marker = 'ALPHA') {
  const root = mkdtempSync(join(tmpdir(), 'kortix-reuse-'))
  roots.push(root)
  const src = join(root, 'source')
  mkdirSync(src)
  gitQuiet(src, 'init', '-q', '-b', 'main')
  const shas: string[] = []
  for (let i = 1; i <= commits; i += 1) {
    writeFileSync(join(src, `file-${i}.txt`), `${marker} ${i}\n`)
    gitQuiet(src, 'add', '-A')
    gitQuiet(src, 'commit', '-q', '-m', `commit ${i}`)
    shas.push(git(src, 'rev-parse', 'HEAD'))
  }
  const bare = join(root, 'origin.git')
  gitQuiet(root, 'clone', '-q', '--bare', src, bare)
  // No scaffold on the box: the fallback below is the plain clone path.
  __setScaffoldRepoPathForTests(join(root, 'absent-scaffold.git'))
  return { root, bare, shas, tip: shas[commits - 1]!, url: `file://${bare}` }
}

/**
 * A SHALLOW checkout of `sha`, presented exactly as a previous boot would have
 * left it: on `branch`, with `origin` pointing at `originUrl`.
 *
 * `--single-branch --branch <tmp>` pins `remote.origin.fetch` to the temporary
 * ref and creates `refs/remotes/origin/<tmp>`; both are repaired here, because
 * leaving them breaks tracking setup once the temp ref is deleted and that is a
 * fixture artifact, not the behaviour under test.
 */
function seedStaleCheckout(bare: string, target: string, sha: string, originUrl: string) {
  const branch = 'main'
  const tmpRef = `stale-${Math.random().toString(36).slice(2)}`
  gitQuiet(bare, 'branch', '-f', tmpRef, sha)
  try {
    gitQuiet(
      join(target, '..'),
      'clone', '-q', '--depth', '1', '--single-branch', '--branch', tmpRef,
      `file://${bare}`, target,
    )
    gitQuiet(target, 'branch', '-m', tmpRef, branch)
    gitQuiet(target, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
    gitQuiet(target, 'update-ref', `refs/remotes/origin/${branch}`, sha)
    gitQuiet(target, 'update-ref', '-d', `refs/remotes/origin/${tmpRef}`)
    gitQuiet(target, 'remote', 'set-url', 'origin', originUrl)
  } finally {
    gitQuiet(bare, 'branch', '-D', tmpRef)
  }
}

function envFor(target: string, url: string, tip: string, extra: Record<string, string> = {}) {
  return {
    KORTIX_PROJECT_AUTO_CLONE: '1',
    KORTIX_PROJECT_TARGET: target,
    KORTIX_WORKSPACE: target,
    KORTIX_PROJECT_ID: '11111111-1111-4111-8111-111111111111',
    KORTIX_REPO_URL: url,
    KORTIX_TOKEN: 'sandbox-token',
    KORTIX_BRANCH_NAME: 'sess-1',
    KORTIX_SESSION_FRESH: '1',
    KORTIX_BASE_REF: 'main',
    KORTIX_DEFAULT_BRANCH: 'main',
    KORTIX_BASE_SHA: tip,
    ...extra,
  }
}

/** A workspace directory that already holds a checkout. */
function targetIn(root: string): string {
  const target = join(root, 'workspace')
  mkdirSync(target, { recursive: true })
  rmSync(target, { recursive: true, force: true })
  return target
}

describe('materializeRepo checkout reuse', () => {
  test('advances a stale checkout with a delta fetch instead of re-downloading', async () => {
    const origin = seedOrigin(3)
    const target = targetIn(origin.root)
    seedStaleCheckout(origin.bare, target, origin.shas[0]!, origin.url)

    expect(gitOk(target, 'cat-file', '-e', `${origin.tip}^{commit}`)).toBe(false)

    await materializeRepo(loadConfig(envFor(target, origin.url, origin.tip)))

    expect(git(target, 'rev-parse', 'HEAD')).toBe(origin.tip)
    expect(git(target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sess-1')
    expect(git(target, 'rev-parse', 'main')).toBe(origin.tip)
    expect(git(target, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    // The proof that the checkout was REUSED rather than rebuilt: the commit it
    // started on is still in the object database. A wipe followed by a depth-1
    // clone of the tip cannot contain it.
    expect(gitOk(target, 'cat-file', '-e', `${origin.shas[0]}^{commit}`)).toBe(true)
  })

  test('refuses reuse when origin points at a different project, and never merges its objects', async () => {
    const wanted = seedOrigin(3, 'ALPHA')
    const foreign = seedOrigin(3, 'BRAVO')
    const target = targetIn(wanted.root)
    // The disk holds `foreign`, but this session is for `wanted`.
    seedStaleCheckout(foreign.bare, target, foreign.tip, foreign.url)

    await materializeRepo(loadConfig(envFor(target, wanted.url, wanted.tip)))

    expect(git(target, 'rev-parse', 'HEAD')).toBe(wanted.tip)
    // One root only. Two would mean the other project's history was fetched
    // into this sandbox's object database.
    const allRoots = git(target, 'rev-list', '--max-parents=0', '--all').split('\n').filter(Boolean)
    expect(allRoots).toHaveLength(1)
    expect(gitOk(target, 'cat-file', '-e', `${foreign.tip}^{commit}`)).toBe(false)
  })

  test('refuses reuse when the object database is corrupt, and self-heals', async () => {
    const origin = seedOrigin(3)
    const target = targetIn(origin.root)
    seedStaleCheckout(origin.bare, target, origin.shas[0]!, origin.url)

    // Truncate every pack. git writes them 0444, so chmod first.
    const packDir = join(target, '.git', 'objects', 'pack')
    for (const entry of readdirSync(packDir).filter((f) => f.endsWith('.pack'))) {
      chmodSync(join(packDir, entry), 0o644)
      writeFileSync(join(packDir, entry), Buffer.from('CORRUPTED NOT A PACK'))
    }

    await materializeRepo(loadConfig(envFor(target, origin.url, origin.tip)))

    expect(git(target, 'rev-parse', 'HEAD')).toBe(origin.tip)
    expect(gitOk(target, 'fsck', '--no-progress')).toBe(true)
  })

  test('a fresh session starts pristine — untracked and ignored leftovers are removed', async () => {
    const origin = seedOrigin(3)
    const target = targetIn(origin.root)
    seedStaleCheckout(origin.bare, target, origin.shas[0]!, origin.url)
    writeFileSync(join(target, 'untracked-scratch.txt'), 'previous session\n')
    writeFileSync(join(target, '.gitignore'), 'ignored-build/\n')
    mkdirSync(join(target, 'ignored-build'), { recursive: true })
    writeFileSync(join(target, 'ignored-build', 'stale.o'), 'stale\n')

    await materializeRepo(loadConfig(envFor(target, origin.url, origin.tip)))

    expect(git(target, 'rev-parse', 'HEAD')).toBe(origin.tip)
    expect(existsSync(join(target, 'untracked-scratch.txt'))).toBe(false)
    expect(existsSync(join(target, 'ignored-build'))).toBe(false)
    // Still the reuse path, not a wipe.
    expect(gitOk(target, 'cat-file', '-e', `${origin.shas[0]}^{commit}`)).toBe(true)
  })

  test('refuses reuse for a session-branch restore, which needs the remote branch', async () => {
    const origin = seedOrigin(3)
    // The agent's session branch already exists upstream.
    gitQuiet(origin.bare, 'branch', '-f', 'sess-1', origin.tip)
    const target = targetIn(origin.root)
    seedStaleCheckout(origin.bare, target, origin.shas[0]!, origin.url)

    await materializeRepo(loadConfig(
      envFor(target, origin.url, origin.tip, { KORTIX_SESSION_BRANCH_RESTORE: '1' }),
    ))

    expect(git(target, 'rev-parse', 'HEAD')).toBe(origin.tip)
    expect(git(target, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('sess-1')
    // Restore takes the authoritative path, so the starting commit is gone.
    expect(gitOk(target, 'cat-file', '-e', `${origin.shas[0]}^{commit}`)).toBe(false)
  })
})
