/**
 * The daemon must not advertise a transient "starting" OpenCode REST runtime
 * that no code path can ever make ready.
 *
 * Under managed ACP `main()` never calls `opencode.start()`, so `markReady()`
 * (the only writer of `state='ok'`) is unreachable and `getState()` stays at
 * its initial `'starting'` forever. `/kortix/health` already relabels that to
 * `opencode: 'down'` + `runtime: 'acp'`; the proxy catch-all did not, and the
 * `"starting"` shape made every client retry path treat it as a boot signal and
 * burn its whole boot window against a process that will never exist.
 */

import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'bun:test'
import type { Config } from '../config'
import type { Opencode } from '../opencode'
import { buildOpencodeApp } from '../proxy'
import type { SandboxBootState } from '../routes/health'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'

const TEST_TOKEN = 'test-kortix-token-32-chars-1234567890'

// The SDK's boot-signal matcher, copied verbatim from
// packages/sdk/src/react/use-opencode-sessions/messages.ts:67. A daemon body
// that matches this is retried across the full ~29s boot window.
const SDK_BOOT_SIGNAL_RE =
  /opencode not ready|not ready|not yet ready|waking|booting|still booting|provision/i

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

function fakeOpencode(state: 'ok' | 'starting' | 'down' = 'starting'): Opencode {
  return {
    getState: () => state,
    getPid: () => null,
    getInternalUrl: () => 'http://127.0.0.1:1',
    restart: async () => {},
  } as unknown as Opencode
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signCtx(secret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const body = {
    userId: 'u',
    sandboxId: 's',
    sandboxRole: 'owner',
    scopes: [],
    iat: now,
    exp: now + 60,
  }
  const payloadB64 = base64url(Buffer.from(JSON.stringify(body), 'utf8'))
  const sig = base64url(createHmac('sha256', secret).update(payloadB64).digest())
  return `${payloadB64}.${sig}`
}

function managedAcpBootState(over: Partial<SandboxBootState> = {}): SandboxBootState {
  return {
    repoMaterializationError: null,
    timeline: [],
    acpHarness: 'pi',
    acpServerId: 'session-abc',
    acpRuntimeReady: true,
    acpRuntimeError: null,
    ...over,
  }
}

function restBootState(over: Partial<SandboxBootState> = {}): SandboxBootState {
  return { repoMaterializationError: null, timeline: [], ...over }
}

const signed = { [KORTIX_USER_CONTEXT_HEADER]: signCtx(TEST_TOKEN) }

describe('daemon proxy catch-all under managed ACP', () => {
  it('answers OpenCode REST paths with a permanent 404, never a transient state', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('starting'), Date.now(), managedAcpBootState())

    const res = await app.request('/agent', { headers: signed })

    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({
      error: 'opencode rest is not served for this runtime',
      runtime: 'acp',
      harness: 'pi',
    })
  })

  it('never leaks the unreachable "starting" opencode state into the response', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('starting'), Date.now(), managedAcpBootState())

    const res = await app.request('/session/anything', { headers: signed })
    const raw = await res.text()

    expect(raw).not.toContain('starting')
    expect(raw).not.toContain('opencode not ready')
  })

  it('agrees with /kortix/health instead of contradicting it', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('starting'), Date.now(), managedAcpBootState())

    const health = (await (await app.request('/kortix/health')).json()) as {
      opencode: string
      runtime: string
    }
    const proxied = (await (await app.request('/agent', { headers: signed })).json()) as {
      runtime: string
    }

    expect(health.opencode).toBe('down')
    expect(health.runtime).toBe('acp')
    expect(proxied.runtime).toBe(health.runtime)
  })

  it('returns a status and body every client retry path treats as terminal', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('starting'), Date.now(), managedAcpBootState())

    const res = await app.request('/app/agents', { headers: signed })
    const body = (await res.json()) as { error: string }

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(res.status).not.toBe(408)
    expect(res.status).not.toBe(429)
    expect(SDK_BOOT_SIGNAL_RE.test(body.error)).toBe(false)
  })

  it('short-circuits before the repo gates so a doomed request never waits on the filesystem', async () => {
    const app = buildOpencodeApp(
      baseConfig({ autoClone: true, projectTarget: '/nonexistent-workspace' }),
      fakeOpencode('starting'),
      Date.now(),
      managedAcpBootState(),
    )

    const res = await app.request('/agent', { headers: signed })

    expect(res.status).toBe(404)
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'opencode rest is not served for this runtime',
    })
  })

  it('still answers the daemon-owned file API under managed ACP', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('starting'), Date.now(), managedAcpBootState())

    const res = await app.request('/kortix/health')

    expect(res.status).toBe(200)
  })
})

describe('daemon proxy catch-all under real OpenCode REST', () => {
  it('keeps the retryable 503 boot signal while the binary is still binding its port', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('starting'), Date.now(), restBootState())

    const res = await app.request('/agent', { headers: signed })

    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'opencode not ready', opencode: 'starting' })
  })

  it('keeps the boot signal when an ACP harness is named but no process is bound', async () => {
    const app = buildOpencodeApp(
      baseConfig(),
      fakeOpencode('starting'),
      Date.now(),
      restBootState({ acpHarness: 'opencode', acpServerId: null }),
    )

    const res = await app.request('/agent', { headers: signed })

    expect(res.status).toBe(503)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'opencode not ready' })
  })

  it('proxies upstream once opencode is ready', async () => {
    const app = buildOpencodeApp(baseConfig(), fakeOpencode('ok'), Date.now(), restBootState())

    const res = await app.request('/agent', { headers: signed })

    expect(res.status).toBe(502)
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'upstream unreachable' })
  })
})
