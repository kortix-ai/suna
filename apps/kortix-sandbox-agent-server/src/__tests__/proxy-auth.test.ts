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
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { buildOpencodeApp } from '../proxy'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'

const TEST_TOKEN = 'test-kortix-token-32-chars-1234567890'

function baseConfig(over: Partial<Config> = {}): Config {
  return {
    servicePort: 8000,
    opencodeInternalPort: 4096,
    workspace: '/workspace',
    projectTarget: '/workspace',
    defaultBranch: 'main',
    branchFetchAttempts: 60,
    branchFetchDelaySec: 0.25,
    defaultOpencodeConfigDir: '/ephemeral/opencode',
    autoClone: false,
    repoUrl: undefined,
    branchName: undefined,
    githubToken: undefined,
    kortixToken: TEST_TOKEN,
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

describe('daemon proxy auth gate', () => {
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
})
