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

import { execFileSync, spawnSync } from 'node:child_process'
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
import { buildGitAuthArgs, configureGlobalGitIdentity, materializeRepo, __clearCloneTokenCacheForTests, __clearRepoIdentityMemoForTests } from '../git'

const TEST_TOKEN = 'test-kortix-token-32-chars-1234567890'
const TEST_AGENT_ENV_FILE = join(tmpdir(), `kortix-proxy-agent-env-${process.pid}.sh`)

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
    cloneDepth: 1,
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
    restart: async () => hooks.restart?.(),
    // The env route calls reloadConfig now, which applies config in place via
    // dispose and falls back to restart. Both land here so a test counting
    // "was the new config applied" keeps counting exactly that.
    reloadConfig: async () => {
      hooks.restart?.()
      return 'restarted' as const
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

function startGitSmartHttpServer(projectRoot: string) {
  const calls: Array<{ path: string; service: string | null; authorization: string | null }> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const service = url.searchParams.get('service')
      calls.push({
        path: url.pathname,
        service,
        authorization: req.headers.get('authorization'),
      })
      if (service === 'git-receive-pack' || url.pathname.endsWith('/git-receive-pack')) {
        return new Response('meta push denied', { status: 403 })
      }
      const input = Buffer.from(await req.arrayBuffer())
      const result = spawnSync('git', ['http-backend'], {
        input,
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers.get('content-type') ?? '',
          CONTENT_LENGTH: String(input.length),
          REMOTE_ADDR: '127.0.0.1',
        },
      })
      if (result.status !== 0) {
        return new Response(result.stderr?.toString() || 'git http-backend failed', { status: 500 })
      }
      const output = Buffer.from(result.stdout)
      const separator = output.indexOf(Buffer.from('\r\n\r\n'))
      if (separator < 0) return new Response('invalid git CGI response', { status: 500 })
      const rawHeaders = output.subarray(0, separator).toString('utf8')
      const headers = new Headers()
      let status = 200
      for (const line of rawHeaders.split('\r\n')) {
        const colon = line.indexOf(':')
        if (colon < 0) continue
        const name = line.slice(0, colon)
        const value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10)
        else headers.append(name, value)
      }
      return new Response(output.subarray(separator + 4), { status, headers })
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/remote.git`,
    calls,
    stop: () => server.stop(true),
  }
}

describe('daemon proxy auth gate', () => {
  beforeEach(() => {
    // Process-global caches reset between tests so each one observes its
    // own fetch call count + git-config side effects.
    __clearCloneTokenCacheForTests()
    __clearRepoIdentityMemoForTests()
    rmSync(TEST_AGENT_ENV_FILE, { force: true })
  })

  it('uses KORTIX_SANDBOX_TOKEN as the canonical sandbox auth token', () => {
    const cfg = loadConfig({
      KORTIX_SANDBOX_TOKEN: TEST_TOKEN,
      KORTIX_TOKEN: 'legacy-alias-that-must-not-win',
      KORTIX_CLI_TOKEN: 'legacy-project-pat-that-must-not-shadow',
    } as NodeJS.ProcessEnv)

    expect(cfg.sandboxToken).toBe(TEST_TOKEN)
    expect(cfg.sessionToken).toBe('legacy-project-pat-that-must-not-shadow')
    expect('apiToken' in cfg).toBe(false)
  })

  it('falls back to the legacy KORTIX_TOKEN sandbox auth alias', () => {
    const cfg = loadConfig({
      KORTIX_TOKEN: TEST_TOKEN,
      KORTIX_CLI_TOKEN: 'project-pat-that-must-not-shadow',
    } as NodeJS.ProcessEnv)

    expect(cfg.sandboxToken).toBe(TEST_TOKEN)
    expect(cfg.sessionToken).toBe('project-pat-that-must-not-shadow')
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

  it('uses the clone-credential repo_url for clone, origin, fetch auth, and denied push', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-meta-git-proxy-'))
    const originalFetch = globalThis.fetch
    const remote = join(root, 'remote.git')
    const seed = join(root, 'seed')
    const target = join(root, 'workspace')
    git(['init', '--bare', remote])
    mkdirSync(seed)
    git(['init'], seed)
    git(['checkout', '-b', 'main'], seed)
    writeFileSync(join(seed, 'README.md'), 'through proxy\n')
    git(['add', 'README.md'], seed)
    git(['-c', 'user.email=test@kortix.dev', '-c', 'user.name=Kortix Test', 'commit', '-m', 'seed'], seed)
    git(['remote', 'add', 'origin', remote], seed)
    git(['push', '-u', 'origin', 'main'], seed)
    const proxy = startGitSmartHttpServer(root)
    try {
      globalThis.fetch = (async () => Response.json({
        repo_url: proxy.url,
        auth: { username: 'x-access-token', token: TEST_TOKEN, type: 'basic' },
        source: 'kortix_git_proxy',
      })) as unknown as typeof fetch
      const cfg = baseConfig({
        autoClone: true,
        projectId: 'project-123',
        apiUrl: 'http://api.local/v1',
        projectTarget: target,
        repoUrl: 'https://provider.invalid/acme/private.git',
        defaultBranch: 'main',
      })

      await materializeRepo(cfg)

      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('through proxy\n')
      expect(gitOutput(['-C', target, 'remote', 'get-url', 'origin'])).toBe(proxy.url)
      const cloneAuth = proxy.calls.find((call) => call.authorization)?.authorization
      expect(cloneAuth?.toLowerCase().startsWith('basic ')).toBe(true)
      expect(Buffer.from(cloneAuth!.split(' ', 2)[1]!, 'base64').toString('utf8')).toBe(
        `x-access-token:${TEST_TOKEN}`,
      )

      const push = Bun.spawn([
        'git',
        ...buildGitAuthArgs(proxy.url, TEST_TOKEN),
        '-C', target, 'push', 'origin', 'HEAD:refs/heads/meta-must-not-push',
      ], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      })
      expect(await push.exited).not.toBe(0)
      expect(proxy.calls.some((call) => call.service === 'git-receive-pack')).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      proxy.stop()
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

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

  it('resolves clone credentials before using a baked git checkout', async () => {
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

      // Resolve the API-selected repository URL even when the checkout is already baked.
      const credRequests = requests.filter((r) => r.url.includes('/git/clone-credential'))
      expect(credRequests).toHaveLength(1)
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
    const previousLlmKey = process.env.KORTIX_LLM_API_KEY
    const previousLlmBase = process.env.KORTIX_LLM_BASE_URL
    delete process.env.KORTIX_LLM_API_KEY
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
          opencodeEnv: {
            KORTIX_LLM_API_KEY: 'kortix_pat_refresh',
            KORTIX_LLM_BASE_URL: 'https://api.kortix.test/v1/llm',
          },
        }),
      })

      expect(enable.status).toBe(200)
      expect(await enable.json()).toMatchObject({
        ok: true,
        opencode_env_changed: true,
        opencode_env_names: ['KORTIX_LLM_API_KEY', 'KORTIX_LLM_BASE_URL'],
      })
      expect(process.env.KORTIX_LLM_API_KEY as string | undefined).toBe('kortix_pat_refresh')
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
          opencodeEnv: {
            KORTIX_LLM_API_KEY: null,
            KORTIX_LLM_BASE_URL: null,
          },
        }),
      })

      expect(disable.status).toBe(200)
      expect(await disable.json()).toMatchObject({
        ok: true,
        opencode_env_changed: true,
        opencode_env_names: ['KORTIX_LLM_API_KEY', 'KORTIX_LLM_BASE_URL'],
      })
      expect(process.env.KORTIX_LLM_API_KEY).toBeUndefined()
      expect(process.env.KORTIX_LLM_BASE_URL).toBeUndefined()
      expect(restartCalls).toBe(2)
    } finally {
      if (previousLlmKey === undefined) delete process.env.KORTIX_LLM_API_KEY
      else process.env.KORTIX_LLM_API_KEY = previousLlmKey
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

  it('flips the provider-key deny-list with llm gateway mode (BYOK works when off)', async () => {
    const saved = {
      key: process.env.KORTIX_LLM_API_KEY,
      base: process.env.KORTIX_LLM_BASE_URL,
      deny: process.env.KORTIX_OPENCODE_DENY_ENV,
      exec: process.env.KORTIX_CLI_TOKEN,
    }
    delete process.env.KORTIX_LLM_API_KEY
    delete process.env.KORTIX_LLM_BASE_URL
    delete process.env.KORTIX_OPENCODE_DENY_ENV
    process.env.KORTIX_CLI_TOKEN = 'kortix_pat_exec'

    const store = createProjectEnvStore({} as NodeJS.ProcessEnv)
    const app = buildOpencodeApp(
      baseConfig(),
      fakeOpencode('ok', { restart: () => {} }),
      Date.now(),
      { repoMaterializationError: null, timeline: [] },
      store,
      null,
      undefined,
      TEST_AGENT_ENV_FILE,
    )

    try {
      // GATEWAY on: keys withheld from opencode via the injected deny-list.
      const on = await app.request('/kortix/env', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: 'rev-on',
          env: {},
          names: [],
          refreshModels: true,
          llmGatewayEnabled: true,
          llmGatewayBaseUrl: 'https://api.kortix.test/v1/llm',
          llmGatewayDenyEnv: 'ANTHROPIC_API_KEY,OPENAI_API_KEY',
        }),
      })
      expect(on.status).toBe(200)
      expect(process.env.KORTIX_LLM_API_KEY as string | undefined).toBe('kortix_pat_exec')
      expect(process.env.KORTIX_OPENCODE_DENY_ENV as string | undefined).toBe('ANTHROPIC_API_KEY,OPENAI_API_KEY')

      // DIRECT off: deny-list cleared so opencode sees native BYOK keys again.
      const off = await app.request('/kortix/env', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          revision: 'rev-off',
          env: {},
          names: [],
          refreshModels: true,
          llmGatewayEnabled: false,
          llmGatewayDenyEnv: '',
        }),
      })
      expect(off.status).toBe(200)
      expect(process.env.KORTIX_LLM_API_KEY).toBeUndefined()
      expect(process.env.KORTIX_OPENCODE_DENY_ENV).toBeUndefined()
    } finally {
      for (const [k, v] of Object.entries({
        KORTIX_LLM_API_KEY: saved.key,
        KORTIX_LLM_BASE_URL: saved.base,
        KORTIX_OPENCODE_DENY_ENV: saved.deny,
        KORTIX_CLI_TOKEN: saved.exec,
      })) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
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
