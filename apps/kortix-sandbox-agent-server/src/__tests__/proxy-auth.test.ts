import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'bun:test'
import { buildGitAuthArgs, configureGlobalGitIdentity, materializeRepo, __clearCloneTokenCacheForTests, __clearRepoIdentityMemoForTests } from '../git'

import { loadConfig, type Config } from '../config'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { buildAcpApp } from '../proxy'

const TEST_TOKEN = 'test-kortix-token-32-chars-1234567890'

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
    projectId: undefined,
    apiUrl: undefined,
    repoUrl: undefined,
    branchName: undefined,
    sessionFresh: false,
    baseSha: undefined,
    sandboxToken: TEST_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    ...over,
  }
}

function base64url(value: Buffer): string {
  return value.toString('base64url')
}

function signCtx(
  payload: { userId: string; sandboxId: string; sandboxRole: string; scopes?: string[]; ttl?: number },
  secret: string = TEST_TOKEN,
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

describe('ACP daemon auth gate', () => {
  it('uses KORTIX_SANDBOX_TOKEN as the canonical sandbox auth token', () => {
    const cfg = loadConfig({
      KORTIX_SANDBOX_TOKEN: TEST_TOKEN,
      KORTIX_TOKEN: 'legacy-alias-that-must-not-win',
      KORTIX_CLI_TOKEN: 'legacy-project-pat-that-must-not-shadow',
    } as NodeJS.ProcessEnv)

    expect(cfg.sandboxToken).toBe(TEST_TOKEN)
    expect('apiToken' in cfg).toBe(false)
  })

  it('falls back to the legacy KORTIX_TOKEN sandbox auth alias', () => {
    const cfg = loadConfig({
      KORTIX_TOKEN: TEST_TOKEN,
      KORTIX_CLI_TOKEN: 'project-pat-that-must-not-shadow',
    } as NodeJS.ProcessEnv)

    expect(cfg.sandboxToken).toBe(TEST_TOKEN)
  })

  it('lets /kortix/health through with no signed context', async () => {
    const app = buildAcpApp(baseConfig(), Date.now())
    const res = await app.request('/kortix/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { daemon: string; auth: string }
    expect(body.daemon).toBe('ok')
    expect(body.auth).toBe('configured')
  })

  it('reports auth=unconfigured when the sandbox token is unset', async () => {
    const app = buildAcpApp(baseConfig({ sandboxToken: undefined }), Date.now())
    const res = await app.request('/kortix/health')
    const body = (await res.json()) as { auth: string }
    expect(body.auth).toBe('unconfigured')
  })

  it('rejects unsigned /acp requests', async () => {
    const app = buildAcpApp(baseConfig(), Date.now())
    const res = await app.request('/acp')
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized', reason: 'malformed' })
  })

  it('rejects /acp when the sandbox token is unset', async () => {
    const app = buildAcpApp(baseConfig({ sandboxToken: undefined }), Date.now())
    const res = await app.request('/acp')
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ error: 'daemon not configured' })
  })

  it('rejects bad-signature /acp requests', async () => {
    const app = buildAcpApp(baseConfig(), Date.now())
    const res = await app.request('/acp', {
      headers: {
        [KORTIX_USER_CONTEXT_HEADER]: signCtx(
          { userId: 'u', sandboxId: 's', sandboxRole: 'owner' },
          'wrong-secret',
        ),
      },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized', reason: 'bad_signature' })
  })

  it('rejects expired /acp requests', async () => {
    const app = buildAcpApp(baseConfig(), Date.now())
    const res = await app.request('/acp', {
      headers: {
        [KORTIX_USER_CONTEXT_HEADER]: signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner', ttl: -10 }),
      },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized', reason: 'expired' })
  })

  it('accepts signed /acp requests', async () => {
    const app = buildAcpApp(baseConfig(), Date.now())
    const res = await app.request('/acp', {
      headers: {
        [KORTIX_USER_CONTEXT_HEADER]: signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }),
      },
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ servers: [] })
  })

  it('returns 404 for signed native OpenCode-style unknown paths', async () => {
    const app = buildAcpApp(baseConfig(), Date.now())
    const res = await app.request('/session/anything', {
      headers: {
        [KORTIX_USER_CONTEXT_HEADER]: signCtx({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }),
      },
    })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not found' })
  })

  // Gate 2 (WS3-P4-a): the HMAC gate is a single `app.use('*', ...)` middleware
  // mounted before every non-/kortix route, so proving it on the collection
  // route above is structurally representative — but the hard gate calls out
  // "every /acp route" by name. Assert each verb/shape explicitly so a future
  // per-route auth bypass (e.g. a route registered before the middleware)
  // fails loudly here instead of only in the collection-route test above.
  it('rejects an unsigned POST to a specific ACP server id', async () => {
    const app = buildAcpApp(baseConfig(), Date.now())
    const res = await app.request('/acp/session-1?agent=codex', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized', reason: 'malformed' })
  })

  it('rejects an unsigned GET (SSE) to a specific ACP server id', async () => {
    const app = buildAcpApp(baseConfig(), Date.now())
    const res = await app.request('/acp/session-1', { headers: { Accept: 'text/event-stream' } })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized', reason: 'malformed' })
  })

  it('rejects an unsigned DELETE to a specific ACP server id', async () => {
    const app = buildAcpApp(baseConfig(), Date.now())
    const res = await app.request('/acp/session-1', { method: 'DELETE' })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized', reason: 'malformed' })
  })

  it('rejects a bad-signature DELETE to a specific ACP server id', async () => {
    const app = buildAcpApp(baseConfig(), Date.now())
    const res = await app.request('/acp/session-1', {
      method: 'DELETE',
      headers: {
        [KORTIX_USER_CONTEXT_HEADER]: signCtx(
          { userId: 'u', sandboxId: 's', sandboxRole: 'owner' },
          'wrong-secret',
        ),
      },
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: 'unauthorized', reason: 'bad_signature' })
  })

  it('keeps /kortix/health open even when a garbage auth header is sent', async () => {
    const app = buildAcpApp(baseConfig(), Date.now())
    const res = await app.request('/kortix/health', {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: 'not-a-real-token' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { daemon: string }
    expect(body.daemon).toBe('ok')
  })
})

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

describe('daemon repo materialization', () => {
  beforeEach(() => {
    __clearCloneTokenCacheForTests()
    __clearRepoIdentityMemoForTests()
  })

  it('scopes git auth headers to the project repo host', () => {
    const encoded = Buffer.from('x-access-token:secret-token').toString('base64')

    expect(buildGitAuthArgs(undefined, undefined)).toEqual([])
    expect(buildGitAuthArgs('https://git.example.test/repo-id', 'secret-token')).toEqual([
      '-c',
      `http.https://git.example.test/.extraheader=AUTHORIZATION: basic ${encoded}`,
    ])
    expect(buildGitAuthArgs('https://github.com/kortix/suna.git', 'secret-token')).toEqual([
      '-c',
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${encoded}`,
    ])
    expect(buildGitAuthArgs('https://api.kortix.test/v1/git/project-123.git', 'secret-token')).toEqual([
      '-c',
      `http.https://api.kortix.test/.extraheader=AUTHORIZATION: basic ${encoded}`,
      '-c',
      `http.extraheader=AUTHORIZATION: basic ${encoded}`,
    ])
  })

  it('uses the provider-selected username for direct-upstream auth', () => {
    const encoded = Buffer.from('t:code-storage-jwt').toString('base64')

    expect(buildGitAuthArgs(
      'https://kortix.code.storage/project-123.git',
      'code-storage-jwt',
      't',
    )).toEqual([
      '-c',
      `http.https://kortix.code.storage/.extraheader=AUTHORIZATION: basic ${encoded}`,
    ])
  })

  it('fetches clone credentials from the API v1 project endpoint', async () => {
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

      // Filter to the clone-credential endpoint — other fetches (env loads,
      // health probes from supervisors that may have been spawned in earlier
      // tests in the same process) are unrelated noise.
      const credRequests = requests.filter((r) => r.url.includes('/git/clone-credential'))
      expect(credRequests).toHaveLength(1)
      expect(credRequests[0]!.url).toBe('http://api.local/v1/projects/project-123/git/clone-credential')
      // Assert auth on the credential request itself — not requests[0], which
      // can be unrelated background-fetch noise (health probes from a daemon
      // supervisor booted by another test in the same process).
      expect((credRequests[0]!.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_TOKEN}`)
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
})
