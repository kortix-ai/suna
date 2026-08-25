/**
 * Auth-gate tests for the daemon proxy.
 *
 * Contract (spec §3.5):
 * - `/kortix/health` is always reachable — even unauthenticated, even when
 *   opencode isn't ready, even when the sandbox token is unset.
 * - Every other path requires a valid `X-Kortix-User-Context` header signed
 *   with the sandbox token. Missing/invalid → 401. Token unset → 503
 *   (daemon misconfigured — never silently bypass).
 */

import { execFileSync } from 'node:child_process'
import { createHmac } from 'crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'bun:test'
import { loadConfig, type Config } from '../config'
import type { Opencode } from '../opencode'
import { buildOpencodeApp } from '../proxy'
import { createProjectEnvStore, mergeProjectEnv } from '../project-env'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import {
  __clearRepoIdentityMemoForTests,
  __setScaffoldRepoPathForTests,
  buildGitAuthArgs,
  checkoutSessionBranch,
  configureGlobalGitIdentity,
  materializeRepo,
} from '../git'

const TEST_TOKEN = 'test-kortix-token-32-chars-1234567890'
const TEST_AGENT_ENV_FILE = join(tmpdir(), `kortix-proxy-agent-env-${process.pid}.sh`)

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    opencodeStandbyPort: 4097,
    staticPort: 3211,
    workspace: '/workspace',
    projectTarget: '/workspace',
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: undefined,
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    gitDeltaBundleBase64: undefined,
    gitDeltaParentSha: undefined,
    gitDeltaParentCommitBase64: undefined,
    sandboxToken: TEST_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    cloneDepth: 1,
    workload: '',
    monitorsJson: '',
    monitorBoxEpoch: '',
    ...over,
  }
}

function fakeOpencode(
  state: 'ok' | 'starting' | 'down' = 'starting',
  hooks: { restart?: () => void; internalUrl?: string } = {},
): Opencode {
  // Loose cast — buildOpencodeApp only touches these three methods.
  return {
    getState: () => state,
    getPid: () => null,
    getInternalUrl: () => hooks.internalUrl ?? 'http://127.0.0.1:1', // unreachable by default
    // Health reports this so the API's PTY proxy can follow opencode across a
    // reload swap. Omitting it made every /kortix/health assertion 500.
    getActivePort: () => 4096,
    restart: async () => hooks.restart?.(),
    // The env route calls reloadConfig now, which applies config in place via
    // dispose and falls back to restart. Both land here so a test counting
    // "was the new config applied" keeps counting exactly that.
    reloadConfig: async () => {
      hooks.restart?.()
      return 'restarted' as const
    },
    // The refresh route now performs a VERIFIED swap: boot the new opencode,
    // prove it serves, then retire the old one. Lands on the same hook so a
    // test counting "was opencode replaced" keeps counting exactly that.
    reloadVerified: async () => {
      hooks.restart?.()
      return { outcome: 'swapped' as const, port: 4097, pid: null }
    },
  } as unknown as Opencode
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signCtx(
  payload: { userId: string; sandboxId: string; sandboxRole: string; scopes?: string[]; ttl?: number },
  secret: string,
): string {
  const now = Math.floor(Date.now() / 1000)
  const body = {
    userId: payload.userId,
    sandboxId: payload.sandboxId,
    sandboxRole: payload.sandboxRole,
    scopes: payload.scopes ?? [],
    iat: now,
    exp: now + (payload.ttl ?? 60),
  }
  const payloadB64 = base64url(Buffer.from(JSON.stringify(body), 'utf8'))
  const sig = base64url(createHmac('sha256', secret).update(payloadB64).digest())
  return `${payloadB64}.${sig}`
}

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

describe('daemon proxy auth gate', () => {
  beforeEach(() => {
    // Process-global state resets between tests so each one observes its own
    // git-config side effects.
    __clearRepoIdentityMemoForTests()
    __setScaffoldRepoPathForTests()
    rmSync(TEST_AGENT_ENV_FILE, { force: true })
  })

  it('uses KORTIX_TOKEN as the session auth token', () => {
    const cfg = loadConfig({ KORTIX_TOKEN: TEST_TOKEN } as NodeJS.ProcessEnv)

    expect(cfg.sandboxToken).toBe(TEST_TOKEN)
    expect('apiToken' in cfg).toBe(false)
  })

  it('parses the one-time replacement branch restore signal', () => {
    expect(loadConfig({ KORTIX_SESSION_BRANCH_RESTORE: '1' }).sessionBranchRestore).toBe(true)
    expect(loadConfig({}).sessionBranchRestore).toBe(false)
  })

  it('builds auth headers only for the Kortix Git proxy', () => {
    const encoded = Buffer.from('x-access-token:secret-token').toString('base64')

    expect(buildGitAuthArgs(undefined, undefined)).toEqual([])
    expect(buildGitAuthArgs('https://git.example.test/repo-id', 'secret-token')).toEqual([])
    expect(buildGitAuthArgs('https://github.com/kortix/suna.git', 'secret-token')).toEqual([])
    expect(buildGitAuthArgs('https://api.kortix.test/v1/git/project-123.git', 'secret-token')).toEqual([
      '-c',
      `http.https://api.kortix.test/.extraheader=AUTHORIZATION: basic ${encoded}`,
      '-c',
      `http.extraheader=AUTHORIZATION: basic ${encoded}`,
    ])
  })

  it('does not fetch a provider credential for a local repository fixture', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-clone-credential-'))
    const originalFetch = globalThis.fetch
    const requests: Array<{ url: string; init?: RequestInit }> = []
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

      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url
        requests.push({ url: href, init })
        return new Response(JSON.stringify({ auth: { token: 'clone-token' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

      await materializeRepo(baseConfig({
        autoClone: true,
        projectId: 'project-123',
        apiUrl: 'http://api.local/v1/router',
        projectTarget: target,
        repoUrl: remote,
        defaultBranch: 'main',
      }))

      // Local repository fixtures need no network credential.
      const credRequests = requests.filter((r) => r.url.includes('/git/clone-credential'))
      expect(credRequests).toHaveLength(0)
      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('v1\n')
      expect(gitOutput(['-C', target, 'config', 'user.name'])).toBe('Kortix Agent')
      expect(gitOutput(['-C', target, 'config', 'user.email'])).toBe('agent@kortix.ai')
    } finally {
      globalThis.fetch = originalFetch
      rmSync(root, { recursive: true, force: true })
    }
  })

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
      process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal
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

  it('uses a baked git checkout without fetching clone credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-baked-checkout-'))
    const originalFetch = globalThis.fetch
    const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
    const requests: Array<{ url: string; init?: RequestInit }> = []
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
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url
        requests.push({ url: href, init })
        return new Response(JSON.stringify({ auth: { token: 'clone-token' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

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

      // Baked checkout means no clone-credential fetch should happen.
      const credRequests = requests.filter((r) => r.url.includes('/git/clone-credential'))
      expect(credRequests).toHaveLength(0)
      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('v1\n')
      expect(gitOutput(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('session-branch')
      expect(gitOutput(['-C', target, 'remote', 'get-url', 'origin'])).toBe(remote)
      expect(gitOutput(['-C', target, 'config', 'user.name'])).toBe('Kortix Agent')
      expect(gitOutput(['-C', target, 'config', 'user.email'])).toBe('agent@kortix.ai')
      expect(readFileSync(globalGitConfig, 'utf8')).toContain(`directory = ${target}`)
    } finally {
      globalThis.fetch = originalFetch
      process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('materializes a matching fresh scaffold without fetching clone credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-matching-scaffold-'))
    const originalFetch = globalThis.fetch
    const requests: string[] = []
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
      globalThis.fetch = (async (url: string | URL | Request) => {
        const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url
        requests.push(href)
        return new Response(JSON.stringify({ auth: { token: 'clone-token' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

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

      expect(requests.filter((url) => url.includes('/git/clone-credential'))).toHaveLength(0)
      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('shared scaffold\n')
      expect(gitOutput(['-C', target, 'rev-parse', 'HEAD'])).toBe(baseSha)
      expect(gitOutput(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('session-fresh')
    } finally {
      globalThis.fetch = originalFetch
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
    const originalFetch = globalThis.fetch
    const requests: string[] = []
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

      globalThis.fetch = (async (url: string | URL | Request) => {
        const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url
        requests.push(href)
        return new Response(JSON.stringify({ auth: { token: 'clone-token' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

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
      expect(requests.filter((url) => url.includes('/git/clone-credential'))).toHaveLength(0)

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
      globalThis.fetch = originalFetch
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('restores the remote session branch once on a replacement project image', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-project-image-restore-'))
    const originalFetch = globalThis.fetch
    const requests: string[] = []
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

      globalThis.fetch = (async (url: string | URL | Request) => {
        const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url
        requests.push(href)
        return new Response(JSON.stringify({ auth: { token: 'clone-token' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

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
      const credentialRequests = requests.filter((url) => url.includes('/git/clone-credential'))
      expect(credentialRequests).toHaveLength(0)

      writeFileSync(join(target, 'dirty-after-restore.txt'), 'keep after daemon restart\n')
      await materializeRepo(cfg)

      expect(gitOutput(['-C', target, 'rev-parse', 'HEAD'])).toBe(sessionTip)
      expect(readFileSync(join(target, 'dirty-after-restore.txt'), 'utf8')).toBe(
        'keep after daemon restart\n',
      )
      expect(requests.filter((url) => url.includes('/git/clone-credential'))).toHaveLength(0)
    } finally {
      globalThis.fetch = originalFetch
      rmSync(root, { recursive: true, force: true })
    }
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
    const originalFetch = globalThis.fetch
    const requests: string[] = []
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
      globalThis.fetch = (async (url: string | URL | Request) => {
        const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url
        requests.push(href)
        return new Response(JSON.stringify({ auth: { token: 'clone-token' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

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

      expect(requests.filter((url) => url.includes('/git/clone-credential'))).toHaveLength(0)
      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('imported repository\n')
      expect(gitOutput(['-C', target, 'rev-parse', 'HEAD'])).toBe(importedSha)
    } finally {
      globalThis.fetch = originalFetch
      __setScaffoldRepoPathForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('materializes an exact fresh-project delta bundle without fetching clone credentials', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-delta-bundle-scaffold-'))
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    try {
      const source = join(root, 'source')
      const scaffold = join(root, 'scaffold.git')
      const target = join(root, 'workspace')
      const bundlePath = join(root, 'delta.bundle')
      mkdirSync(source)
      git(['init', '-b', 'main'], source)
      writeFileSync(join(source, 'README.md'), 'generic scaffold\n')
      git(['add', 'README.md'], source)
      git(['-c', 'user.email=noreply@kortix.ai', '-c', 'user.name=Kortix', 'commit', '-m', 'scaffold'], source)
      const scaffoldSha = gitOutput(['-C', source, 'rev-parse', 'HEAD'])
      git(['clone', '--bare', source, scaffold])

      gitOutput([
        '-c', 'user.email=noreply@kortix.ai',
        '-c', 'user.name=Kortix',
        'commit', '--amend', '--no-edit',
      ], {
        cwd: source,
        env: {
          GIT_AUTHOR_DATE: '2026-01-02T00:00:00Z',
          GIT_COMMITTER_DATE: '2026-01-02T00:00:00Z',
        },
      })
      const providerParentSha = gitOutput(['-C', source, 'rev-parse', 'HEAD'])
      expect(providerParentSha).not.toBe(scaffoldSha)
      const providerParentCommitBase64 = Buffer.from(execFileSync(
        'git',
        ['cat-file', 'commit', providerParentSha],
        { cwd: source },
      )).toString('base64')

      writeFileSync(join(source, 'README.md'), 'customer project\n')
      git(['add', 'README.md'], source)
      git(['-c', 'user.email=noreply@kortix.ai', '-c', 'user.name=Kortix', 'commit', '-m', 'project setup'], source)
      const baseSha = gitOutput(['-C', source, 'rev-parse', 'HEAD'])
      git(['bundle', 'create', bundlePath, 'refs/heads/main', `^${providerParentSha}`], source)

      __setScaffoldRepoPathForTests(scaffold)
      globalThis.fetch = (async (url: string | URL | Request) => {
        const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url
        requests.push(href)
        return new Response(JSON.stringify({ auth: { token: 'clone-token' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

      await materializeRepo(baseConfig({
        autoClone: true,
        projectId: 'project-123',
        apiUrl: 'http://api.local/v1',
        projectTarget: target,
        repoUrl: source,
        defaultBranch: 'main',
        branchName: 'session-fresh',
        sessionFresh: true,
        baseSha,
        gitDeltaBundleBase64: readFileSync(bundlePath).toString('base64'),
        gitDeltaParentSha: providerParentSha,
        gitDeltaParentCommitBase64: providerParentCommitBase64,
      }))

      expect(requests.filter((url) => url.includes('/git/clone-credential'))).toHaveLength(0)
      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('customer project\n')
      expect(gitOutput(['-C', target, 'rev-parse', 'HEAD'])).toBe(baseSha)
      expect(gitOutput(['-C', target, 'rev-parse', '--abbrev-ref', 'HEAD'])).toBe('session-fresh')
    } finally {
      globalThis.fetch = originalFetch
      __setScaffoldRepoPathForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the authenticated fetch when the parent commit payload is forged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-invalid-delta-bundle-'))
    const originalFetch = globalThis.fetch
    const requests: string[] = []
    try {
      const source = join(root, 'source')
      const scaffold = join(root, 'scaffold.git')
      const target = join(root, 'workspace')
      const bundlePath = join(root, 'delta.bundle')
      mkdirSync(source)
      git(['init', '-b', 'main'], source)
      writeFileSync(join(source, 'README.md'), 'generic scaffold\n')
      git(['add', 'README.md'], source)
      git(['-c', 'user.email=noreply@kortix.ai', '-c', 'user.name=Kortix', 'commit', '-m', 'scaffold'], source)
      const scaffoldSha = gitOutput(['-C', source, 'rev-parse', 'HEAD'])
      git(['clone', '--bare', source, scaffold])
      writeFileSync(join(source, 'README.md'), 'remote truth\n')
      git(['add', 'README.md'], source)
      git(['-c', 'user.email=noreply@kortix.ai', '-c', 'user.name=Kortix', 'commit', '-m', 'project setup'], source)
      const baseSha = gitOutput(['-C', source, 'rev-parse', 'HEAD'])
      git(['bundle', 'create', bundlePath, 'refs/heads/main', `^${scaffoldSha}`], source)

      __setScaffoldRepoPathForTests(scaffold)
      globalThis.fetch = (async (url: string | URL | Request) => {
        const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url
        requests.push(href)
        return new Response(JSON.stringify({ auth: { token: 'clone-token' } }), {
          headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch

      await materializeRepo(baseConfig({
        autoClone: true,
        projectId: 'project-123',
        apiUrl: 'http://api.local/v1',
        projectTarget: target,
        repoUrl: source,
        defaultBranch: 'main',
        branchName: 'session-fresh',
        sessionFresh: true,
        baseSha,
        gitDeltaBundleBase64: readFileSync(bundlePath).toString('base64'),
        gitDeltaParentSha: scaffoldSha,
        gitDeltaParentCommitBase64: Buffer.from('forged parent commit').toString('base64'),
      }))

      expect(requests.filter((url) => url.includes('/git/clone-credential'))).toHaveLength(0)
      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('remote truth\n')
      expect(gitOutput(['-C', target, 'rev-parse', 'HEAD'])).toBe(baseSha)
    } finally {
      globalThis.fetch = originalFetch
      __setScaffoldRepoPathForTests()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('configures the default git identity in the OpenCode home', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-git-home-'))
    try {
      await configureGlobalGitIdentity(baseConfig(), root)
      expect(gitOutput(['config', '--global', 'user.name'], { env: { HOME: root } })).toBe('Kortix Agent')
      expect(gitOutput(['config', '--global', 'user.email'], { env: { HOME: root } })).toBe('agent@kortix.ai')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('lets /kortix/health through with no header', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode(), Date.now())
    const res = await app.request('/kortix/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { daemon: string; auth: string }
    expect(body.daemon).toBe('ok')
    expect(body.auth).toBe('configured')
  })

  it('reports auth=unconfigured when the sandbox token is unset', async () => {
    const app = buildOpencodeApp(baseConfig({ sandboxToken: undefined }), fakeOpencode(), Date.now())
    const res = await app.request('/kortix/health')
    const body = (await res.json()) as { auth: string }
    expect(body.auth).toBe('unconfigured')
  })

  it('reports runtime not ready and blocks OpenCode proxy when repo materialization failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-repo-failed-'))
    try {
      const target = join(root, 'workspace')
      mkdirSync(target)
      const app = buildOpencodeApp(
        baseConfig({ autoClone: true, projectTarget: target }),
        fakeOpencode('ok'),
        Date.now(),
        { repoMaterializationError: 'git clone failed: authentication required', timeline: [] },
      )

      const health = await app.request('/kortix/health')
      expect(health.status).toBe(200)
      const healthBody = (await health.json()) as {
        status: string
        runtimeReady: boolean
        repo_ready: boolean
        boot_error: string
      }
      expect(healthBody.status).toBe('error')
      expect(healthBody.runtimeReady).toBe(false)
      expect(healthBody.repo_ready).toBe(false)
      expect(healthBody.boot_error).toContain('git clone failed')

      const signed = signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
      const res = await app.request('/session?directory=%2Fworkspace', {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { error: string; reason: string }
      expect(body.error).toBe('sandbox runtime not ready')
      expect(body.reason).toBe('repo_materialization_failed')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('names the boot phase on every not-ready answer so the API can measure progress', async () => {
    // Essentia 2026-08-25 17:23: a resume that converged OpenCode 1.18.19 →
    // 1.18.23 and sat through the new version's 53 s first init was parked as
    // runtime_boot_failed by a fixed 90 s budget. The header lets the API
    // restart its clock on progress instead.
    const root = mkdtempSync(join(tmpdir(), 'kortix-boot-phase-'))
    try {
      const target = join(root, 'workspace')
      mkdirSync(target)
      const timeline: { label: string; atMs: number }[] = [{ label: 'config-deps', atMs: 1 }]
      const app = buildOpencodeApp(
        baseConfig({ autoClone: false, projectTarget: target }),
        fakeOpencode('starting'),
        Date.now(),
        { repoMaterializationError: null, timeline },
      )
      const signed = signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
      const first = await app.request('/session?directory=%2Fworkspace', {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect(first.status).toBe(503)
      const firstPhase = first.headers.get('x-kortix-boot-phase')
      expect(firstPhase).toContain('config-deps')
      expect(firstPhase).toContain('opencode=starting')
      expect(((await first.json()) as { phase: string }).phase).toBe(firstPhase)

      timeline.push({ label: 'opencode-spawned', atMs: 2 })
      const second = await app.request('/session?directory=%2Fworkspace', {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect(second.status).toBe(503)
      expect(second.headers.get('x-kortix-boot-phase')).not.toBe(firstPhase)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps runtime not ready until the boot OpenCode session is pinned', async () => {
    const app = buildOpencodeApp(
      baseConfig(),
      fakeOpencode('ok'),
      Date.now(),
      {
        repoMaterializationError: null,
        timeline: [],
        initialOpenCodeSessionRequired: true,
        initialOpenCodeSessionId: null,
      },
    )

    const health = await app.request('/kortix/health')
    expect(health.status).toBe(200)
    const healthBody = (await health.json()) as {
      status: string
      runtimeReady: boolean
      opencode_session_required: boolean
      opencode_session_id: string | null
    }
    expect(healthBody.status).toBe('ok')
    expect(healthBody.runtimeReady).toBe(false)
    expect(healthBody.opencode_session_required).toBe(true)
    expect(healthBody.opencode_session_id).toBeNull()

    const signed = signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const res = await app.request('/session?directory=%2Fworkspace', {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe('initial_opencode_session_pending')
  })

  it('keeps OpenCode proxy disabled when auto-clone is enabled but no repo is present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-empty-workspace-'))
    try {
      const app = buildOpencodeApp(
        baseConfig({ autoClone: true, projectTarget: root }),
        fakeOpencode('ok'),
        Date.now(),
      )
      const signed = signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
      const res = await app.request('/session?directory=%2Fworkspace', {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect(res.status).toBe(503)
      const body = (await res.json()) as { reason: string }
      expect(body.reason).toBe('repo_not_materialized')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects proxied request without X-Kortix-User-Context → 401', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const res = await app.request('/session/anything')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; reason: string }
    expect(body.error).toBe('unauthorized')
    expect(body.reason).toBe('malformed')
  })

  it('rejects bad-signature header → 401', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const tampered = signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, 'wrong-secret')
    const res = await app.request('/session/anything', {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: tampered },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe('bad_signature')
  })

  it('rejects expired token → 401', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const expired = signCtx(
      { userId: 'u', sandboxId: 's', sandboxRole: 'owner', ttl: -10 },
      TEST_TOKEN,
    )
    const res = await app.request('/session/anything', {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: expired },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe('expired')
  })

  it('refuses to proxy when the sandbox token is unset → 503 (never silently bypass)', async () => {
    const app = buildOpencodeApp(baseConfig({ sandboxToken: undefined }), fakeOpencode('ok'), Date.now())
    const res = await app.request('/session/anything')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('daemon not configured')
    expect(body.detail).toContain('KORTIX_TOKEN')
  })

  it('passes valid token through to the reverse-proxy (which then returns 503 because opencode is starting)', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('starting'), Date.now())
    const signed = signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const res = await app.request('/session/anything', {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
    })
    // Auth passed → reverse proxy ran → opencode not ready → 503 with that
    // shape (not the auth-gate's 401/503).
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; opencode?: string }
    expect(body.error).toBe('opencode not ready')
    expect(body.opencode).toBe('starting')
  })

  it('forwards valid token to upstream (502 because upstream unreachable, proves we got past the gate)', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const signed = signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const res = await app.request('/session/anything', {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
    })
    // Auth passed AND opencode state == 'ok' → we attempted upstream fetch
    // → connect refused (127.0.0.1:1 is unbound) → 502 from the catch-all.
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('upstream unreachable')
  })

  it(
    'fails fast with 502 instead of hanging forever when opencode accepts the connection but never responds',
    async () => {
      // Simulates a wedged opencode: the TCP connection is accepted (unlike the
      // "connect refused" case above) but the handler never resolves — the
      // failure mode that left real sessions stuck at "Starting the agent" with
      // no error surfaced until this fix.
      const hungUpstream = Bun.serve({
        port: 0,
        fetch: () => new Promise<Response>(() => {}),
      })
      try {
        const app = buildOpencodeApp(
          baseConfig(),
          fakeOpencode('ok', { internalUrl: `http://127.0.0.1:${hungUpstream.port}` }),
          Date.now(),
        )
        const signed = signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
        const startedAt = Date.now()
        const res = await app.request('/global/event', {
          headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
        })
        const elapsedMs = Date.now() - startedAt

        expect(res.status).toBe(502)
        // Well under the old unbounded hang (and under the ALB's 60s idle cap) —
        // proves the internal fetch actually aborts instead of waiting forever.
        expect(elapsedMs).toBeLessThan(15_000)
        const body = (await res.json()) as { error: string }
        expect(body.error).toBe('upstream unreachable')
      } finally {
        hungUpstream.stop(true)
      }
    },
    20_000,
  )

  it('rejects /kortix/refresh without a signed user context', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const res = await app.request('/kortix/refresh', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; reason: string }
    expect(body.error).toBe('unauthorized')
    expect(body.reason).toBe('malformed')
  })

  // `base=1` needs the DIRECT-call header as well as the bearer. The bearer
  // alone proves nothing about the hop: the preview proxy authenticates the
  // user traffic it relays with this very token. See KORTIX_SERVICE_CALL_HEADER.
  it('lets a direct API call reach /kortix/refresh?base=1', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const res = await app.request('/kortix/refresh?base=1&restart=0', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'X-Kortix-Service-Call': '1' },
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: string; message: string }
    expect(body.error).toBe('refresh failed')
    expect(body.message).toContain('not materialized')
  })

  it('rejects an invalid base_sha before Git execution', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const res = await app.request('/kortix/refresh?base=1&base_sha=main', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'X-Kortix-Service-Call': '1' },
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({
      error: 'invalid base_sha',
    })
  })

  it('rejects /kortix/abort without a signed user context', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const res = await app.request('/kortix/abort', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; reason: string }
    expect(body.error).toBe('unauthorized')
    expect(body.reason).toBe('malformed')
  })

  it('rejects /kortix/abort when the sandbox token is unset', async () => {
    const app = buildOpencodeApp(baseConfig({ sandboxToken: undefined }), fakeOpencode('ok'), Date.now())
    const res = await app.request('/kortix/abort', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('daemon not configured')
    expect(body.detail).toContain('KORTIX_TOKEN')
  })

  it('lets signed /kortix/abort reach the abort handler', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const signed = signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const res = await app.request('/kortix/abort', {
      method: 'POST',
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('No opencode session pinned')
  })

  it('refreshes the project repo and restarts opencode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-refresh-'))
    try {
      const remote = join(root, 'remote.git')
      const seed = join(root, 'seed')
      const worktree = join(root, 'worktree')
      git(['init', '--bare', remote])
      mkdirSync(seed)
      git(['init'], seed)
      git(['checkout', '-b', 'main'], seed)
      writeFileSync(join(seed, 'README.md'), 'v1\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'v1'], seed)
      git(['remote', 'add', 'origin', remote], seed)
      git(['push', '-u', 'origin', 'main'], seed)
      git(['clone', remote, worktree])

      writeFileSync(join(seed, 'README.md'), 'v2\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'v2'], seed)
      git(['push', 'origin', 'main'], seed)

      let restartCalls = 0
      const app = buildOpencodeApp(
        baseConfig({
          projectTarget: worktree,
          repoUrl: remote,
          defaultBranch: 'main',
          branchName: 'main',
          sessionFresh: false,
    baseSha: undefined,
        }),
        fakeOpencode('ok', { restart: () => { restartCalls += 1 } }),
        Date.now(),
      )
      const signed = signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
      const res = await app.request('/kortix/refresh', {
        method: 'POST',
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })

      expect(res.status).toBe(200)
      expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('v2\n')
      expect(restartCalls).toBe(1)
      const body = (await res.json()) as { ok: boolean; repo: { before: { commit: string }; after: { commit: string } } }
      expect(body.ok).toBe(true)
      expect(body.repo.before.commit).not.toBe(body.repo.after.commit)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips the base fetch when the workspace already matches base_sha', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-refresh-unchanged-'))
    try {
      const worktree = join(root, 'worktree')
      mkdirSync(worktree)
      git(['init'], worktree)
      git(['checkout', '-b', 'session-branch'], worktree)
      writeFileSync(join(worktree, 'README.md'), 'current\n')
      git(['add', 'README.md'], worktree)
      git(
        ['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'current'],
        worktree,
      )
      const baseSha = gitOutput(['rev-parse', 'HEAD'], { cwd: worktree })

      const app = buildOpencodeApp(
        baseConfig({
          projectTarget: worktree,
          repoUrl: join(root, 'missing-remote.git'),
          defaultBranch: 'main',
          branchName: 'session-branch',
        }),
        fakeOpencode('ok'),
        Date.now(),
      )
      const res = await app.request(
        `/kortix/refresh?base=1&base_sha=${baseSha}&restart=0`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'X-Kortix-Service-Call': '1' },
        },
      )

      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({
        ok: true,
        repo: {
          before: { commit: baseSha },
          after: { commit: baseSha },
        },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('checks out the requested base_sha without restarting opencode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-refresh-base-sha-'))
    try {
      const remote = join(root, 'remote.git')
      const seed = join(root, 'seed')
      const worktree = join(root, 'worktree')
      git(['init', '--bare', remote])
      mkdirSync(seed)
      git(['init'], seed)
      git(['checkout', '-b', 'main'], seed)
      writeFileSync(join(seed, 'README.md'), 'v1\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'v1'], seed)
      git(['remote', 'add', 'origin', remote], seed)
      git(['push', '-u', 'origin', 'main'], seed)
      git(['clone', remote, worktree])

      writeFileSync(join(seed, 'README.md'), 'v2\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'v2'], seed)
      git(['push', 'origin', 'main'], seed)
      const baseSha = gitOutput(['rev-parse', 'HEAD'], { cwd: seed })

      writeFileSync(join(seed, 'README.md'), 'v3\n')
      git(['add', 'README.md'], seed)
      git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'v3'], seed)
      git(['push', 'origin', 'main'], seed)

      let restartCalls = 0
      const app = buildOpencodeApp(
        baseConfig({
          projectTarget: worktree,
          repoUrl: remote,
          defaultBranch: 'main',
          branchName: 'session-branch',
        }),
        fakeOpencode('ok', { restart: () => { restartCalls += 1 } }),
        Date.now(),
      )
      const res = await app.request(
        `/kortix/refresh?base=1&base_sha=${baseSha}&restart=0`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'X-Kortix-Service-Call': '1' },
        },
      )

      expect(res.status).toBe(200)
      expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('v2\n')
      expect(gitOutput(['rev-parse', 'HEAD'], { cwd: worktree })).toBe(baseSha)
      expect(restartCalls).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('syncs project env through /kortix/env without restarting opencode', async () => {
    let restartCalls = 0
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRET_NAMES: 'OLD_SECRET,REMOVED_SECRET',
      OLD_SECRET: 'old',
      REMOVED_SECRET: 'gone',
    } as NodeJS.ProcessEnv)
    const app = buildOpencodeApp(
      baseConfig(),
      fakeOpencode('ok', { restart: () => { restartCalls += 1 } }),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
      store,
      null,
      undefined,
      TEST_AGENT_ENV_FILE,
    )

    const res = await app.request('/kortix/env', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        revision: 'rev-1',
        env: { OLD_SECRET: 'new', NEW_SECRET: 'fresh', KORTIX_TOKEN: 'blocked' },
        names: ['OLD_SECRET', 'NEW_SECRET', 'REMOVED_SECRET'],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      changed: true,
      revision: 'rev-1',
      names: ['NEW_SECRET', 'OLD_SECRET', 'REMOVED_SECRET'],
      exported: 2,
      agent_env_written: true,
    })
    expect(restartCalls).toBe(0)
    expect(mergeProjectEnv({
      OLD_SECRET: 'old-process',
      REMOVED_SECRET: 'gone-process',
      KEEP: 'yes',
    } as NodeJS.ProcessEnv, store)).toEqual({
      OLD_SECRET: 'new',
      NEW_SECRET: 'fresh',
      KEEP: 'yes',
    })

    const replay = await app.request('/kortix/env', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        revision: 'rev-1',
        env: { OLD_SECRET: 'new', NEW_SECRET: 'fresh' },
        names: ['OLD_SECRET', 'NEW_SECRET', 'REMOVED_SECRET'],
      }),
    })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ ok: true, changed: false })
    expect(restartCalls).toBe(0)
  })

  it('restarts opencode for model-affecting env sync and applies gateway runtime env', async () => {
    let restartCalls = 0
    const previousLlmKey = process.env.KORTIX_TOKEN
    const previousLlmBase = process.env.KORTIX_LLM_BASE_URL
    delete process.env.KORTIX_TOKEN
    delete process.env.KORTIX_LLM_BASE_URL

    const store = createProjectEnvStore({} as NodeJS.ProcessEnv)
    const app = buildOpencodeApp(
      baseConfig(),
      fakeOpencode('ok', { restart: () => { restartCalls += 1 } }),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
      store,
      null,
      undefined,
      TEST_AGENT_ENV_FILE,
    )

    try {
      const enable = await app.request('/kortix/env', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          revision: 'rev-gateway-on',
          env: {},
          names: [],
          refreshModels: true,
          opencodeEnv: { KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm' },
        }),
      })

      expect(enable.status).toBe(200)
      expect(await enable.json()).toMatchObject({
        ok: true,
        opencode_env_changed: true,
        opencode_env_names: ['KORTIX_LLM_BASE_URL'],
      })
      expect(process.env.KORTIX_LLM_BASE_URL as string | undefined).toBe('https://api.kortix.test/v1/llm')
      expect(restartCalls).toBe(1)

      const disable = await app.request('/kortix/env', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          revision: 'rev-gateway-off',
          env: {},
          names: [],
          refreshModels: true,
          opencodeEnv: { KORTIX_LLM_BASE_URL: null },
        }),
      })

      expect(disable.status).toBe(200)
      expect(await disable.json()).toMatchObject({
        ok: true,
        opencode_env_changed: true,
        opencode_env_names: ['KORTIX_LLM_BASE_URL'],
      })
      expect(process.env.KORTIX_LLM_BASE_URL).toBeUndefined()
      expect(restartCalls).toBe(2)
    } finally {
      if (previousLlmKey === undefined) delete process.env.KORTIX_TOKEN
      else process.env.KORTIX_TOKEN = previousLlmKey
      if (previousLlmBase === undefined) delete process.env.KORTIX_LLM_BASE_URL
      else process.env.KORTIX_LLM_BASE_URL = previousLlmBase
    }
  })

  it('enables Connector MCP in a running session and restarts opencode once', async () => {
    let restartCalls = 0
    const previous = process.env.KORTIX_CONNECTORS_MCP_ENABLED
    delete process.env.KORTIX_CONNECTORS_MCP_ENABLED
    const store = createProjectEnvStore({} as NodeJS.ProcessEnv)
    const app = buildOpencodeApp(
      baseConfig(),
      fakeOpencode('ok', { restart: () => { restartCalls += 1 } }),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
      store,
      null,
      undefined,
      TEST_AGENT_ENV_FILE,
    )

    const request = () =>
      app.request('/kortix/env', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${TEST_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          revision: 'rev-email-mcp',
          env: {},
          names: [],
          refreshModels: true,
          opencodeEnv: { KORTIX_CONNECTORS_MCP_ENABLED: '1' },
        }),
      })

    try {
      const enabled = await request()
      expect(enabled.status).toBe(200)
      expect(await enabled.json()).toMatchObject({
        ok: true,
        opencode_env_changed: true,
        opencode_env_names: ['KORTIX_CONNECTORS_MCP_ENABLED'],
      })
      expect(process.env.KORTIX_CONNECTORS_MCP_ENABLED as string | undefined).toBe('1')
      expect(restartCalls).toBe(1)

      const replay = await request()
      expect(replay.status).toBe(200)
      expect(await replay.json()).toMatchObject({
        ok: true,
        opencode_env_changed: false,
        opencode_env_names: [],
      })
      expect(restartCalls).toBe(1)
    } finally {
      if (previous === undefined) delete process.env.KORTIX_CONNECTORS_MCP_ENABLED
      else process.env.KORTIX_CONNECTORS_MCP_ENABLED = previous
    }
  })

  it('does not restart opencode when env sync matches the boot revision and values', async () => {
    let restartCalls = 0
    const store = createProjectEnvStore({
      KORTIX_PROJECT_SECRETS_REVISION: 'rev-boot',
      KORTIX_PROJECT_SECRET_NAMES: 'BOOT_SECRET',
      BOOT_SECRET: 'already-loaded',
    } as NodeJS.ProcessEnv)
    const app = buildOpencodeApp(
      baseConfig(),
      fakeOpencode('ok', { restart: () => { restartCalls += 1 } }),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
      store,
      null,
      undefined,
      TEST_AGENT_ENV_FILE,
    )

    const res = await app.request('/kortix/env', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TEST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        revision: 'rev-boot',
        env: { BOOT_SECRET: 'already-loaded' },
        names: ['BOOT_SECRET'],
      }),
    })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, changed: false, revision: 'rev-boot' })
    expect(restartCalls).toBe(0)
  })

  it('rejects /kortix/env without sandbox service bearer token', async () => {
    const app = buildOpencodeApp(
      baseConfig(),
      fakeOpencode('ok'),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
      createProjectEnvStore(),
    )

    const res = await app.request('/kortix/env', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: 'rev', env: {} }),
    })
    expect(res.status).toBe(401)
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
