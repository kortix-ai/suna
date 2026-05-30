import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'bun:test'

import type { Config } from '../config'
import {
  __clearCloneTokenCacheForTests,
  configureGitCredentialHelper,
  configureRepoCredentialHelper,
  resolveGitCredentialOutput,
} from '../git'

const execFileAsync = promisify(execFile)

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    staticPort: 3211,
    workspace: '/workspace',
    projectTarget: '/workspace',
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    projectId: 'proj-1',
    apiUrl: undefined,
    repoUrl: 'https://git.freestyle.sh/repo-abc',
    branchName: 'session-xyz',
    kortixToken: 'kortix_sb_secret',
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    ...over,
  }
}

/** Mock control plane that mimics GET /v1/projects/:id/git/clone-credential. */
function startCloneCredentialServer(opts: {
  expectToken: string
  pushToken: string | null
}) {
  const calls: { auth: string | null; path: string }[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      calls.push({ auth: req.headers.get('authorization'), path: url.pathname })
      if (!url.pathname.endsWith('/git/clone-credential')) {
        return new Response('not found', { status: 404 })
      }
      if (req.headers.get('authorization') !== `Bearer ${opts.expectToken}`) {
        return Response.json({ error: 'bad token' }, { status: 401 })
      }
      return Response.json({
        repo_url: 'https://git.freestyle.sh/repo-abc',
        auth: opts.pushToken
          ? { username: 'x-access-token', token: opts.pushToken, type: 'basic' }
          : null,
        source: 'managed',
      })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    calls,
    stop: () => server.stop(true),
  }
}

afterEach(() => {
  __clearCloneTokenCacheForTests()
})

describe('git credential helper', () => {
  it('resolves a push-capable credential from the control plane', async () => {
    const srv = startCloneCredentialServer({
      expectToken: 'kortix_sb_secret',
      pushToken: 'push-token-123',
    })
    try {
      const cfg = baseConfig({ apiUrl: srv.url })
      const out = await resolveGitCredentialOutput(cfg)
      expect(out).toBe('username=x-access-token\npassword=push-token-123\n')
      // It authenticated with the sandbox KORTIX_TOKEN, not anything else.
      expect(srv.calls.at(-1)?.auth).toBe('Bearer kortix_sb_secret')
      expect(srv.calls.at(-1)?.path).toBe('/v1/projects/proj-1/git/clone-credential')
    } finally {
      srv.stop()
    }
  })

  it('returns null (no credential) when the project has no managed git auth', async () => {
    const srv = startCloneCredentialServer({
      expectToken: 'kortix_sb_secret',
      pushToken: null,
    })
    try {
      const out = await resolveGitCredentialOutput(baseConfig({ apiUrl: srv.url }))
      expect(out).toBeNull()
    } finally {
      srv.stop()
    }
  })

  it('returns null when token/project/api are not all present', async () => {
    expect(await resolveGitCredentialOutput(baseConfig({ apiUrl: undefined }))).toBeNull()
    expect(await resolveGitCredentialOutput(baseConfig({ projectId: undefined }))).toBeNull()
    expect(await resolveGitCredentialOutput(baseConfig({ kortixToken: undefined }))).toBeNull()
  })

  it('configures git with a host-scoped credential helper pointing at this binary', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kortix-cred-home-'))
    try {
      await configureGitCredentialHelper(baseConfig(), home)
      const env = { ...process.env, HOME: home }
      const { stdout: helper } = await execFileAsync(
        'git',
        ['config', '--global', '--get', 'credential.https://git.freestyle.sh.helper'],
        { env, encoding: 'utf8' },
      )
      expect(helper.trim()).toContain('git-credential')
      expect(helper.trim().startsWith('!')).toBe(true)
      const { stdout: user } = await execFileAsync(
        'git',
        ['config', '--global', '--get', 'credential.https://git.freestyle.sh.username'],
        { env, encoding: 'utf8' },
      )
      expect(user.trim()).toBe('x-access-token')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('is idempotent across reboots (no duplicate helper lines)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kortix-cred-home-'))
    try {
      const cfg = baseConfig()
      await configureGitCredentialHelper(cfg, home)
      await configureGitCredentialHelper(cfg, home)
      const env = { ...process.env, HOME: home }
      const { stdout } = await execFileAsync(
        'git',
        ['config', '--global', '--get-all', 'credential.https://git.freestyle.sh.helper'],
        { env, encoding: 'utf8' },
      )
      expect(stdout.trim().split('\n').filter(Boolean)).toHaveLength(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('configures the helper repo-locally (HOME-independent) on the materialized repo', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-cred-repo-'))
    try {
      await execFileAsync('git', ['init', '-q', dir], { encoding: 'utf8' })
      await configureRepoCredentialHelper(baseConfig(), dir)
      // Read with an UNRELATED HOME to prove the config lives in the repo, not
      // in any global ~/.gitconfig.
      const env = { ...process.env, HOME: '/nonexistent-home-for-test' }
      const { stdout } = await execFileAsync(
        'git',
        ['-C', dir, 'config', '--local', '--get', 'credential.https://git.freestyle.sh.helper'],
        { env, encoding: 'utf8' },
      )
      expect(stdout.trim()).toContain('git-credential')
      const { stdout: user } = await execFileAsync(
        'git',
        ['-C', dir, 'config', '--local', '--get', 'credential.https://git.freestyle.sh.username'],
        { env, encoding: 'utf8' },
      )
      expect(user.trim()).toBe('x-access-token')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('repo-local config is a no-op when the repo is not materialized', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kortix-cred-norepo-'))
    try {
      // No `git init` — there's no .git here.
      await configureRepoCredentialHelper(baseConfig(), dir)
      const res = await execFileAsync('git', ['-C', dir, 'config', '--local', '--get', 'credential.https://git.freestyle.sh.helper'], { encoding: 'utf8' })
        .then(() => ({ ok: true }))
        .catch(() => ({ ok: false }))
      expect(res.ok).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('skips configuration for a non-managed (no repo) sandbox', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kortix-cred-home-'))
    try {
      await configureGitCredentialHelper(baseConfig({ repoUrl: undefined }), home)
      const env = { ...process.env, HOME: home }
      const res = await execFileAsync(
        'git',
        ['config', '--global', '--get', 'credential.https://git.freestyle.sh.helper'],
        { env, encoding: 'utf8' },
      ).catch((err: { code?: number }) => ({ code: err.code }))
      // `git config --get` exits 1 when the key is absent.
      expect('code' in res ? res.code : 0).toBe(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
