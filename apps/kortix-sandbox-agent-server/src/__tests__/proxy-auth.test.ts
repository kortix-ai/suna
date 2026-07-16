import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'bun:test'

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
