/**
 * Repository materialization (`git.ts#materializeRepo` and the session-branch
 * checkout) against real `git` and bare `file://` remotes.
 *
 * Every session boots through this code. The rows below guard data loss (a
 * restart must keep committed and dirty session work; a failed clone must not
 * delete a workspace), branch restore on a replacement image, scaffold and
 * baked-checkout adoption, and the clone depth the boot latency depends on.
 */
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import {
  __setScaffoldRepoPathForTests,
  checkoutSessionBranch,
  isShallowRepo,
  materializeRepo,
  scheduleHistoryBackfill,
} from '../git'
import { testOpenCodeConfig as baseConfig } from './helpers/open-code-harness'

function git(args: string[], cwd?: string) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  })
}

function gitOutput(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync('git', args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...opts.env,
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim()
}

function createDetachedWarmCheckout(prefix: string): {
  root: string
  remote: string
  seed: string
  target: string
  baseSha: string
} {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const remote = join(root, 'remote.git')
  const seed = join(root, 'seed')
  const target = join(root, 'workspace')
  git(['init', '--bare', remote])
  mkdirSync(seed)
  git(['init', '-b', 'main'], seed)
  writeFileSync(join(seed, 'README.md'), 'base\n')
  git(['add', 'README.md'], seed)
  git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'base'], seed)
  git(['remote', 'add', 'origin', remote], seed)
  git(['push', '-u', 'origin', 'main'], seed)
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
  const baseSha = gitOutput(['-C', seed, 'rev-parse', 'HEAD'])
  mkdirSync(target)
  git(['init'], target)
  git(['fetch', '--depth', '1', remote, baseSha], target)
  git(['checkout', '--detach', 'FETCH_HEAD'], target)
  git(['remote', 'add', 'origin', remote], target)
  return { root, remote, seed, target, baseSha }
}

const tempDirs: string[] = []

beforeEach(() => {
  __setScaffoldRepoPathForTests()
})

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('materializeRepo', () => {
  it('materializes inside a writable target when its parent is read-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-readonly-parent-'))
    const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
    try {
      const remote = join(root, 'remote.git')
      const seed = join(root, 'seed')
      const target = join(root, 'workspace')
      const globalGitConfig = join(root, 'gitconfig')
      git(['init', '--bare', remote])
      mkdirSync(seed)
      git(['init'], seed)
      git(['checkout', '-b', 'main'], seed)
      writeFileSync(join(seed, 'README.md'), 'read-only parent\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'seed'], seed)
      git(['remote', 'add', 'origin', remote], seed)
      git(['push', '-u', 'origin', 'main'], seed)
      mkdirSync(target)
      writeFileSync(globalGitConfig, '')
      process.env.GIT_CONFIG_GLOBAL = globalGitConfig

      chmodSync(root, 0o555)
      await materializeRepo(baseConfig({
        autoClone: true,
        projectTarget: target,
        repoUrl: remote,
        defaultBranch: 'main',
      }))

      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('read-only parent\n')
      expect(readdirSync(root).filter((entry) => entry.startsWith('.kortix-'))).toEqual([])
      expect(readdirSync(target).filter((entry) => entry.startsWith('.kortix-'))).toEqual([])
    } finally {
      chmodSync(root, 0o755)
      if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal
      rmSync(root, { recursive: true, force: true })
    }
  })


  it('boots from an EMPTY upstream by initializing a fresh local repo', async () => {
    // A managed repo that was provisioned but never seeded: it exists upstream
    // but has no `main` branch. A cold clone would fail with "Remote branch main
    // not found in upstream origin" — materializeRepo must NOT hard-fail; it
    // should init a local repo at base + fork the session branch off it so the
    // session still boots (100% local). resolveCloneToken short-circuits to
    // undefined here (no apiUrl), so no network is touched.
    const root = mkdtempSync(join(tmpdir(), 'kortix-clone-empty-'))
    try {
      const remote = join(root, 'remote.git')
      const target = join(root, 'workspace')
      git(['init', '--bare', remote]) // empty: no branches, no commits

      await materializeRepo(baseConfig({
        autoClone: true,
        projectTarget: target,
        repoUrl: remote,
        defaultBranch: 'main',
        branchName: 'session-abc',
      }))

      // Repo materialized locally with a HEAD to work from.
      expect(existsSync(join(target, '.git'))).toBe(true)
      expect(gitOutput(['-C', target, 'log', '-1', '--format=%s'])).toBe('chore: initialize Kortix project')
      // Checked out on the session branch (forked from the empty base commit).
      expect(gitOutput(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('session-abc')
      // Origin still wired up so the background publish / agent push can seed it.
      expect(gitOutput(['-C', target, 'remote', 'get-url', 'origin'])).toBe(remote)
      // Identity configured so the agent's commits are attributed.
      expect(gitOutput(['-C', target, 'config', 'user.name'])).toBe('Kortix Agent')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })


  it('adopts a baked git checkout onto the session branch and trusts it for git', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-baked-checkout-'))
    const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
    try {
      const remote = join(root, 'remote.git')
      const seed = join(root, 'seed')
      const target = join(root, 'workspace')
      const globalGitConfig = join(root, 'gitconfig')
      git(['init', '--bare', remote])
      mkdirSync(seed)
      git(['init'], seed)
      git(['checkout', '-b', 'main'], seed)
      writeFileSync(join(seed, 'README.md'), 'v1\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'v1'], seed)
      git(['remote', 'add', 'origin', remote], seed)
      git(['push', '-u', 'origin', 'main'], seed)
      git(['clone', '--branch', 'main', remote, target])

      process.env.GIT_CONFIG_GLOBAL = globalGitConfig

      await materializeRepo(baseConfig({
        autoClone: true,
        projectId: 'project-123',
        apiUrl: 'http://api.local/v1/router',
        projectTarget: target,
        repoUrl: remote,
        defaultBranch: 'main',
        branchName: 'session-branch',
        sessionFresh: false,
        baseSha: undefined,
      }))
      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('v1\n')
      expect(gitOutput(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('session-branch')
      expect(gitOutput(['-C', target, 'remote', 'get-url', 'origin'])).toBe(remote)
      expect(gitOutput(['-C', target, 'config', 'user.name'])).toBe('Kortix Agent')
      expect(gitOutput(['-C', target, 'config', 'user.email'])).toBe('agent@kortix.ai')
      expect(readFileSync(globalGitConfig, 'utf8')).toContain(`directory = ${target}`)
    } finally {
      if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal
      rmSync(root, { recursive: true, force: true })
    }
  })


  it('materializes a matching fresh scaffold at base_sha on the session branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-matching-scaffold-'))
    try {
      const remote = join(root, 'remote.git')
      const seed = join(root, 'seed')
      const target = join(root, 'workspace')
      git(['init', '--bare', remote])
      mkdirSync(seed)
      git(['init'], seed)
      git(['checkout', '-b', 'main'], seed)
      writeFileSync(join(seed, 'README.md'), 'shared scaffold\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'seed'], seed)
      git(['remote', 'add', 'origin', remote], seed)
      git(['push', '-u', 'origin', 'main'], seed)
      git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
      const baseSha = gitOutput(['-C', seed, 'rev-parse', 'HEAD'])

      __setScaffoldRepoPathForTests(remote)

      await materializeRepo(baseConfig({
        autoClone: true,
        projectId: 'project-123',
        apiUrl: 'http://api.local/v1',
        projectTarget: target,
        repoUrl: remote,
        defaultBranch: 'main',
        branchName: 'session-fresh',
        sessionFresh: true,
        baseSha,
      }))

      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('shared scaffold\n')
      expect(gitOutput(['-C', target, 'rev-parse', 'HEAD'])).toBe(baseSha)
      expect(gitOutput(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('session-fresh')
    } finally {
      __setScaffoldRepoPathForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })


  it('establishes base refs and tracking from the validated baked HEAD on first adoption', async () => {
    const fixture = createDetachedWarmCheckout('kortix-first-adoption-refs-')
    try {
      await materializeRepo(baseConfig({
        autoClone: true,
        projectTarget: fixture.target,
        repoUrl: fixture.remote,
        defaultBranch: 'main',
        branchName: 'session-first',
        sessionFresh: true,
        baseSha: fixture.baseSha,
      }))

      expect(gitOutput(['-C', fixture.target, 'rev-parse', 'refs/heads/main'])).toBe(fixture.baseSha)
      expect(gitOutput(['-C', fixture.target, 'rev-parse', 'refs/remotes/origin/main'])).toBe(fixture.baseSha)
      expect(gitOutput(['-C', fixture.target, 'symbolic-ref', 'refs/remotes/origin/HEAD'])).toBe(
        'refs/remotes/origin/main',
      )
      expect(gitOutput(['-C', fixture.target, 'config', '--local', '--get', 'branch.main.remote'])).toBe(
        'origin',
      )
      expect(gitOutput(['-C', fixture.target, 'config', '--local', '--get', 'branch.main.merge'])).toBe(
        'refs/heads/main',
      )
      expect(gitOutput(['-C', fixture.target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('session-first')
      expect(gitOutput(['-C', fixture.target, 'diff', '--name-only', 'main'])).toBe('')
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })


  it('does not rewrite base refs or tracking on a marker-backed restart', async () => {
    const fixture = createDetachedWarmCheckout('kortix-restart-base-refs-')
    const cfg = baseConfig({
      autoClone: true,
      projectTarget: fixture.target,
      repoUrl: fixture.remote,
      defaultBranch: 'main',
      branchName: 'session-restart',
      sessionFresh: true,
      baseSha: fixture.baseSha,
    })
    try {
      await materializeRepo(cfg)
      writeFileSync(join(fixture.target, 'agent.txt'), 'session work\n')
      git(['-C', fixture.target, 'add', 'agent.txt'])
      git(['-C', fixture.target, 'commit', '-m', 'session work'])
      const sessionTip = gitOutput(['-C', fixture.target, 'rev-parse', 'HEAD'])

      writeFileSync(join(fixture.seed, 'advanced.txt'), 'advanced base\n')
      git(['add', 'advanced.txt'], fixture.seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'advance'], fixture.seed)
      const advancedSha = gitOutput(['-C', fixture.seed, 'rev-parse', 'HEAD'])
      git(['push', 'origin', 'main'], fixture.seed)
      git(['-C', fixture.target, 'fetch', 'origin', 'main'])
      git(['-C', fixture.target, 'update-ref', 'refs/heads/main', advancedSha])
      git(['-C', fixture.target, 'update-ref', 'refs/remotes/origin/main', advancedSha])
      git(['-C', fixture.target, 'update-ref', 'refs/remotes/origin/other', advancedSha])
      git(['-C', fixture.target, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/other'])
      git(['-C', fixture.target, 'config', '--local', 'branch.main.remote', 'custom-origin'])
      git(['-C', fixture.target, 'config', '--local', 'branch.main.merge', 'refs/heads/trunk'])

      await materializeRepo(cfg)

      expect(gitOutput(['-C', fixture.target, 'rev-parse', 'HEAD'])).toBe(sessionTip)
      expect(gitOutput(['-C', fixture.target, 'rev-parse', 'refs/heads/main'])).toBe(advancedSha)
      expect(gitOutput(['-C', fixture.target, 'rev-parse', 'refs/remotes/origin/main'])).toBe(advancedSha)
      expect(gitOutput(['-C', fixture.target, 'symbolic-ref', 'refs/remotes/origin/HEAD'])).toBe(
        'refs/remotes/origin/other',
      )
      expect(gitOutput(['-C', fixture.target, 'config', '--local', '--get', 'branch.main.remote'])).toBe(
        'custom-origin',
      )
      expect(gitOutput(['-C', fixture.target, 'config', '--local', '--get', 'branch.main.merge'])).toBe(
        'refs/heads/trunk',
      )
    } finally {
      rmSync(fixture.root, { recursive: true, force: true })
    }
  })


  it('preserves committed and dirty session work when a fresh-image daemon restarts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-fresh-image-restart-'))
    try {
      const remote = join(root, 'remote.git')
      const seed = join(root, 'seed')
      const target = join(root, 'workspace')
      git(['init', '--bare', remote])
      mkdirSync(seed)
      git(['init', '-b', 'main'], seed)
      writeFileSync(join(seed, 'README.md'), 'base\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'base'], seed)
      git(['remote', 'add', 'origin', remote], seed)
      git(['push', '-u', 'origin', 'main'], seed)
      git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
      git(['clone', '--branch', 'main', remote, target])
      const baseSha = gitOutput(['-C', seed, 'rev-parse', 'HEAD'])
      const cfg = baseConfig({
        autoClone: true,
        projectId: 'project-123',
        apiUrl: 'http://api.local/v1',
        projectTarget: target,
        repoUrl: remote,
        defaultBranch: 'main',
        branchName: 'session-fresh',
        sessionFresh: true,
        baseSha,
      })

      await materializeRepo(cfg)
      expect(gitOutput(['-C', target, 'config', '--local', '--get', 'kortix.adopted-session'])).toBe(
        'session-fresh',
      )
      writeFileSync(join(target, 'committed.txt'), 'keep committed\n')
      git(['-C', target, 'add', 'committed.txt'])
      git(['-C', target, 'commit', '-m', 'agent work'])
      const sessionTip = gitOutput(['-C', target, 'rev-parse', 'HEAD'])
      git(['-C', target, 'checkout', '-b', 'scratch'])
      git(['-C', target, 'branch', '-D', 'session-fresh'])
      writeFileSync(join(target, 'dirty.txt'), 'keep dirty\n')

      await materializeRepo(cfg)

      expect(gitOutput(['-C', target, 'rev-parse', 'HEAD'])).toBe(sessionTip)
      expect(readFileSync(join(target, 'committed.txt'), 'utf8')).toBe('keep committed\n')
      expect(readFileSync(join(target, 'dirty.txt'), 'utf8')).toBe('keep dirty\n')
      expect(gitOutput(['-C', target, 'status', '--short'])).toContain('?? dirty.txt')

      // A session created before this fix has the local session ref but no
      // marker. The rollout must preserve it and backfill the marker.
      git(['-C', target, 'config', '--local', '--unset', 'kortix.adopted-session'])
      writeFileSync(join(target, 'legacy-committed.txt'), 'keep legacy commit\n')
      git(['-C', target, 'add', 'legacy-committed.txt'])
      git(['-C', target, 'commit', '-m', 'legacy agent work'])
      const legacySessionTip = gitOutput(['-C', target, 'rev-parse', 'HEAD'])

      await materializeRepo(cfg)

      expect(gitOutput(['-C', target, 'rev-parse', 'HEAD'])).toBe(legacySessionTip)
      expect(readFileSync(join(target, 'legacy-committed.txt'), 'utf8')).toBe('keep legacy commit\n')
      expect(readFileSync(join(target, 'dirty.txt'), 'utf8')).toBe('keep dirty\n')
      expect(gitOutput(['-C', target, 'config', '--local', '--get', 'kortix.adopted-session'])).toBe(
        'session-fresh',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })


  it('restores the remote session branch once on a replacement project image', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-project-image-restore-'))
    try {
      const remote = join(root, 'remote.git')
      const seed = join(root, 'seed')
      const target = join(root, 'workspace')
      git(['init', '--bare', remote])
      mkdirSync(seed)
      git(['init', '-b', 'main'], seed)
      writeFileSync(join(seed, 'README.md'), 'base\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'base'], seed)
      git(['remote', 'add', 'origin', remote], seed)
      git(['push', '-u', 'origin', 'main'], seed)
      git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
      git(['checkout', '-b', 'session-existing'], seed)
      writeFileSync(join(seed, 'session-only.txt'), 'remote session state\n')
      git(['add', 'session-only.txt'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'session work'], seed)
      const sessionTip = gitOutput(['-C', seed, 'rev-parse', 'HEAD'])
      git(['push', '-u', 'origin', 'session-existing'], seed)
      git(['clone', '--branch', 'main', remote, target])

      const cfg = baseConfig({
        autoClone: true,
        projectId: 'project-123',
        apiUrl: 'http://api.local/v1',
        projectTarget: target,
        repoUrl: remote,
        defaultBranch: 'main',
        branchName: 'session-existing',
        sessionFresh: false,
        sessionBranchRestore: true,
      })

      await materializeRepo(cfg)

      expect(gitOutput(['-C', target, 'rev-parse', 'HEAD'])).toBe(sessionTip)
      expect(gitOutput(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe(
        'session-existing',
      )
      expect(readFileSync(join(target, 'session-only.txt'), 'utf8')).toBe('remote session state\n')
      expect(gitOutput(['-C', target, 'config', '--local', '--get', 'kortix.adopted-session'])).toBe(
        'session-existing',
      )

      writeFileSync(join(target, 'dirty-after-restore.txt'), 'keep after daemon restart\n')
      await materializeRepo(cfg)

      expect(gitOutput(['-C', target, 'rev-parse', 'HEAD'])).toBe(sessionTip)
      expect(readFileSync(join(target, 'dirty-after-restore.txt'), 'utf8')).toBe(
        'keep after daemon restart\n',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })


  it('a reboot with the session ref present while HEAD is elsewhere returns to it without resetting it', async () => {
    // `git checkout -B` on an existing session branch orphans every commit the
    // session made. The reboot must switch to the ref, never recreate it.
    const fixture = createDetachedWarmCheckout('kortix-reboot-existing-ref-')
    tempDirs.push(fixture.root)
    const cfg = baseConfig({
      autoClone: true,
      projectTarget: fixture.target,
      repoUrl: fixture.remote,
      defaultBranch: 'main',
      branchName: 'session-reboot',
      sessionFresh: true,
      baseSha: fixture.baseSha,
    })
    await materializeRepo(cfg)
    writeFileSync(join(fixture.target, 'agent-work.txt'), 'work\n')
    git(['-C', fixture.target, 'add', 'agent-work.txt'])
    git(['-C', fixture.target, '-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'agent work'])
    const sessionTip = gitOutput(['-C', fixture.target, 'rev-parse', 'HEAD'])
    git(['-C', fixture.target, 'checkout', '-q', 'main'])

    await materializeRepo(cfg)

    expect(gitOutput(['-C', fixture.target, 'rev-parse', 'session-reboot'])).toBe(sessionTip)
    expect(gitOutput(['-C', fixture.target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('session-reboot')
    expect(readFileSync(join(fixture.target, 'agent-work.txt'), 'utf8')).toBe('work\n')
  })

  it('fails closed when replacement branch restore cannot reach the remote', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-project-image-restore-failure-'))
    try {
      const remote = join(root, 'remote.git')
      const unavailableRemote = join(root, 'remote-unavailable.git')
      const seed = join(root, 'seed')
      const target = join(root, 'workspace')
      git(['init', '--bare', remote])
      mkdirSync(seed)
      git(['init', '-b', 'main'], seed)
      writeFileSync(join(seed, 'README.md'), 'base\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'base'], seed)
      git(['remote', 'add', 'origin', remote], seed)
      git(['push', '-u', 'origin', 'main'], seed)
      git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
      git(['clone', '--branch', 'main', remote, target])
      git(['-C', target, 'remote', 'set-url', 'origin', unavailableRemote])

      const cfg = baseConfig({
        projectTarget: target,
        repoUrl: unavailableRemote,
        branchName: 'session-existing',
        sessionBranchRestore: true,
      })

      await expect(checkoutSessionBranch(cfg, target, 'session-existing', undefined)).rejects.toThrow(
        'failed to restore remote session branch session-existing',
      )
      expect(gitOutput(['-C', target, 'branch', '--list', 'session-existing'])).toBe('')
      expect(gitOutput(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })


  it('creates a replacement session branch locally when the remote ref does not exist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-project-image-restore-missing-ref-'))
    try {
      const remote = join(root, 'remote.git')
      const seed = join(root, 'seed')
      const target = join(root, 'workspace')
      git(['init', '--bare', remote])
      mkdirSync(seed)
      git(['init', '-b', 'main'], seed)
      writeFileSync(join(seed, 'README.md'), 'base\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'base'], seed)
      git(['remote', 'add', 'origin', remote], seed)
      git(['push', '-u', 'origin', 'main'], seed)
      git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote)
      git(['clone', '--branch', 'main', remote, target])

      const cfg = baseConfig({
        projectTarget: target,
        repoUrl: remote,
        branchName: 'session-new',
        sessionBranchRestore: true,
      })

      await checkoutSessionBranch(cfg, target, 'session-new', undefined)

      expect(gitOutput(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('session-new')
      expect(gitOutput(['-C', target, 'rev-parse', 'session-new'])).toBe(
        gitOutput(['-C', target, 'rev-parse', 'main']),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })


  it('keeps the legacy local fallback for ordinary resume fetch failures', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-session-resume-fetch-failure-'))
    try {
      const source = join(root, 'source')
      const remote = join(root, 'remote.git')
      const unavailableRemote = join(root, 'remote-unavailable.git')
      const target = join(root, 'workspace')
      mkdirSync(source)
      git(['init', '-b', 'main'], source)
      writeFileSync(join(source, 'README.md'), 'base\n')
      git(['add', 'README.md'], source)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'base'], source)
      git(['clone', '--bare', source, remote])
      git(['clone', '--branch', 'main', remote, target])
      git(['-C', target, 'remote', 'set-url', 'origin', unavailableRemote])

      const cfg = baseConfig({
        projectTarget: target,
        repoUrl: unavailableRemote,
        branchName: 'session-resume',
        sessionBranchRestore: false,
      })

      await checkoutSessionBranch(cfg, target, 'session-resume', undefined)

      expect(gitOutput(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('session-resume')
      expect(gitOutput(['-C', target, 'rev-parse', 'session-resume'])).toBe(
        gitOutput(['-C', target, 'rev-parse', 'main']),
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })


  it('discards a baked scaffold for a fresh session when the base SHA is unavailable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-fresh-without-base-sha-'))
    try {
      const scaffoldSource = join(root, 'scaffold-source')
      const scaffold = join(root, 'scaffold.git')
      const importedSource = join(root, 'imported-source')
      const importedRemote = join(root, 'imported.git')
      const target = join(root, 'workspace')

      mkdirSync(scaffoldSource)
      git(['init', '-b', 'main'], scaffoldSource)
      writeFileSync(join(scaffoldSource, 'README.md'), 'generic scaffold\n')
      git(['add', 'README.md'], scaffoldSource)
      git(['-c', 'user.email=noreply@kortix.ai', '-c', 'user.name=Kortix', 'commit', '-m', 'scaffold'], scaffoldSource)
      git(['clone', '--bare', scaffoldSource, scaffold])
      git(['clone', scaffold, target])

      mkdirSync(importedSource)
      git(['init', '-b', 'main'], importedSource)
      writeFileSync(join(importedSource, 'README.md'), 'imported repository\n')
      git(['add', 'README.md'], importedSource)
      git(['-c', 'user.email=owner@example.com', '-c', 'user.name=Owner', 'commit', '-m', 'imported'], importedSource)
      const importedSha = gitOutput(['-C', importedSource, 'rev-parse', 'HEAD'])
      git(['clone', '--bare', importedSource, importedRemote])

      __setScaffoldRepoPathForTests(scaffold)

      await materializeRepo(baseConfig({
        autoClone: true,
        projectId: 'project-123',
        apiUrl: 'http://api.local/v1',
        projectTarget: target,
        repoUrl: importedRemote,
        defaultBranch: 'main',
        branchName: 'session-fresh',
        sessionFresh: true,
        baseSha: undefined,
      }))

      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('imported repository\n')
      expect(gitOutput(['-C', target, 'rev-parse', 'HEAD'])).toBe(importedSha)
    } finally {
      __setScaffoldRepoPathForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })


  it('does not delete an existing workspace when the initial clone fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-clone-fail-'))
    try {
      const target = join(root, 'workspace')
      mkdirSync(target)
      const marker = join(target, 'keep.txt')
      writeFileSync(marker, 'do not delete\n')

      let error: Error | null = null
      try {
        await materializeRepo(baseConfig({
          autoClone: true,
          projectTarget: target,
          repoUrl: join(root, 'missing.git'),
          defaultBranch: 'main',
        }))
      } catch (err) {
        error = err as Error
      }

      expect(error?.message).toContain('git clone failed')
      expect(readFileSync(marker, 'utf8')).toBe('do not delete\n')
      expect(existsSync(join(target, '.git'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/** A bare `file://` origin whose `main` carries three commits. */
function threeCommitOrigin(): string {
  const root = mkdtempSync(join(tmpdir(), 'kortix-origin-'))
  tempDirs.push(root)
  const seed = join(root, 'seed')
  const remote = join(root, 'remote.git')
  mkdirSync(seed)
  git(['init', '-b', 'main'], seed)
  for (let i = 0; i < 3; i++) {
    writeFileSync(join(seed, `f${i}.txt`), `v${i}\n`)
    git(['add', '-A'], seed)
    git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', `c${i}`], seed)
  }
  git(['clone', '--bare', seed, remote])
  return remote
}

describe('clone depth', () => {
  // Boot latency: a depth-1 clone is the default; history is restored off the
  // critical path by scheduleHistoryBackfill.
  it.each([
    [1, '1', true],
    [0, '3', false],
  ] as const)('cloneDepth %i materializes %s commit(s), shallow=%p', async (cloneDepth, commits, shallow) => {
    const remote = threeCommitOrigin()
    const target = join(mkdtempSync(join(tmpdir(), 'kortix-depth-')), 'workspace')
    tempDirs.push(join(target, '..'))

    await materializeRepo(baseConfig({
      autoClone: true,
      projectTarget: target,
      repoUrl: `file://${remote}`,
      defaultBranch: 'main',
      cloneDepth,
    }))

    expect(gitOutput(['-C', target, 'rev-list', '--count', 'HEAD'])).toBe(commits)
    expect(await isShallowRepo(target)).toBe(shallow)
  })

  it('isShallowRepo reports a depth-limited clone, and false once unshallowed', async () => {
    // It gates the session branch `--depth` and the backfill; an always-false
    // probe would re-truncate a complete repo on resume.
    const remote = threeCommitOrigin()
    const target = join(mkdtempSync(join(tmpdir(), 'kortix-shallow-')), 'repo')
    tempDirs.push(join(target, '..'))
    git(['clone', '--depth', '1', '--branch', 'main', `file://${remote}`, target])
    expect(await isShallowRepo(target)).toBe(true)

    git(['fetch', '--unshallow', 'origin'], target)
    expect(await isShallowRepo(target)).toBe(false)
  })

  it('scheduleHistoryBackfill restores full history without blocking the caller', async () => {
    const remote = threeCommitOrigin()
    const target = join(mkdtempSync(join(tmpdir(), 'kortix-backfill-')), 'repo')
    tempDirs.push(join(target, '..'))
    git(['clone', '--depth', '1', '--branch', 'main', `file://${remote}`, target])

    scheduleHistoryBackfill(baseConfig({ repoUrl: `file://${remote}` }), target)

    const deadline = Date.now() + 20_000
    while (Date.now() < deadline && (await isShallowRepo(target))) await Bun.sleep(50)
    expect(await isShallowRepo(target)).toBe(false)
    expect(gitOutput(['-C', target, 'rev-list', '--count', 'HEAD'])).toBe('3')
  }, 25_000)
})
