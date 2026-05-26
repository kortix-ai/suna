/**
 * Auth-gate tests for the daemon proxy.
 *
 * Contract (spec §3.5):
 * - `/kortix/health` is always reachable — even unauthenticated, even when
 *   opencode isn't ready, even when KORTIX_TOKEN is unset.
 * - Every other path requires a valid `X-Kortix-User-Context` header signed
 *   with `KORTIX_TOKEN`. Missing/invalid → 401. KORTIX_TOKEN unset → 503
 *   (daemon misconfigured — never silently bypass).
 */

import { execFileSync } from 'node:child_process'
import { createHmac } from 'crypto'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { loadConfig, type Config } from '../config'
import type { Opencode } from '../opencode'
import { buildOpencodeApp } from '../proxy'
import { createProjectEnvStore, mergeProjectEnv } from '../project-env'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'
import { buildGitAuthArgs, configureGlobalGitIdentity, materializeRepo } from '../git'

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
    kortixToken: TEST_TOKEN,
    gitUserName: 'Kortix Agent',
    gitUserEmail: 'agent@kortix.ai',
    cloneFilter: '',
    ...over,
  }
}

function fakeOpencode(
  state: 'ok' | 'starting' | 'down' = 'starting',
  hooks: { restart?: () => void } = {},
): Opencode {
  // Loose cast — buildOpencodeApp only touches these three methods.
  return {
    getState: () => state,
    getPid: () => null,
    getInternalUrl: () => 'http://127.0.0.1:1', // unreachable on purpose
    restart: async () => hooks.restart?.(),
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

describe('daemon proxy auth gate', () => {
  it('uses KORTIX_TOKEN as the only sandbox auth token', () => {
    const cfg = loadConfig({
      KORTIX_TOKEN: TEST_TOKEN,
      KORTIX_CLI_TOKEN: 'legacy-project-pat-that-must-not-shadow',
    } as NodeJS.ProcessEnv)

    expect(cfg.kortixToken).toBe(TEST_TOKEN)
    expect('apiToken' in cfg).toBe(false)
  })

  it('scopes git auth headers to the project repo host', () => {
    const encoded = Buffer.from('x-access-token:secret-token').toString('base64')

    expect(buildGitAuthArgs(undefined, undefined)).toEqual([])
    expect(buildGitAuthArgs('https://git.freestyle.sh/repo-id', 'secret-token')).toEqual([
      '-c',
      `http.https://git.freestyle.sh/.extraheader=AUTHORIZATION: basic ${encoded}`,
    ])
    expect(buildGitAuthArgs('https://github.com/kortix/suna.git', 'secret-token')).toEqual([
      '-c',
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${encoded}`,
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

      expect(requests).toHaveLength(1)
      expect(requests[0]!.url).toBe('http://api.local/v1/projects/project-123/git/clone-credential')
      expect((requests[0]!.init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TEST_TOKEN}`)
      expect(readFileSync(join(target, 'README.md'), 'utf8')).toBe('v1\n')
      expect(gitOutput(['-C', target, 'config', 'user.name'])).toBe('Kortix Agent')
      expect(gitOutput(['-C', target, 'config', 'user.email'])).toBe('agent@kortix.ai')
    } finally {
      globalThis.fetch = originalFetch
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
      }))

      expect(requests).toHaveLength(0)
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

  it('reports auth=unconfigured when KORTIX_TOKEN is unset', async () => {
    const app = buildOpencodeApp(baseConfig({ kortixToken: undefined }), fakeOpencode(), Date.now())
    const res = await app.request('/kortix/health')
    const body = (await res.json()) as { auth: string }
    expect(body.auth).toBe('unconfigured')
  })

  it('reports runtime not ready and blocks OpenCode proxy when repo materialization failed', async () => {
    const app = buildOpencodeApp(
      baseConfig({ autoClone: true }),
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

  it('refuses to proxy when KORTIX_TOKEN is unset → 503 (never silently bypass)', async () => {
    const app = buildOpencodeApp(baseConfig({ kortixToken: undefined }), fakeOpencode('ok'), Date.now())
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

  it('rejects /kortix/refresh without a signed user context', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const res = await app.request('/kortix/refresh', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; reason: string }
    expect(body.error).toBe('unauthorized')
    expect(body.reason).toBe('malformed')
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

  it('syncs project env through /kortix/env and restarts opencode only on changes', async () => {
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
    })
    expect(restartCalls).toBe(1)
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
    expect(restartCalls).toBe(1)
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
