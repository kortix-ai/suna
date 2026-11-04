/**
 * Auth-gate tests for the daemon proxy.
 *
 * Contract (spec §3.5):
 * - `/kortix/health` is always reachable — even unauthenticated, even when
 *   the runtime isn't ready, even when the sandbox token is unset.
 * - Every other path requires a valid `X-Kortix-User-Context` header signed
 *   with the sandbox token. Missing/invalid → 401. Token unset → 503
 *   (daemon misconfigured — never silently bypass).
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { HarnessHealthSchema, healthRuntimePort } from '@kortix/api-contract/runtime-relay'
import type { Config } from '@/lib/config/config'
import type { HarnessService } from '@/harness/harness'
import type { PiBootState } from '@/harness/pi/boot-state'
import { buildDaemonApp } from '@/app/server'
import { loadPiEnvironment } from '@/harness/pi/config'
import { createPiHarnessService } from '@/harness/pi/service'
import {
  fakeHarness,
  signTestUserContext,
  TEST_SANDBOX_TOKEN,
  testConfig,
} from './helpers/daemon-test-app'
import { readHostHealth } from '@/harness/shared/host-health'
import { KORTIX_USER_CONTEXT_HEADER } from '@/lib/kortix-api/kortix-user-context'
import { egressShimPort } from '@/services/egress-shim'

const TEST_TOKEN = TEST_SANDBOX_TOKEN
const baseConfig = testConfig

/**
 * The production pi service, never started: its readiness gate and its abort
 * control answer without a model. Its state lives in a fresh temp dir.
 */
const piDirs: string[] = []
afterAll(() => {
  for (const dir of piDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function piHarness(cfg: Config): HarnessService {
  const dir = mkdtempSync(join(tmpdir(), 'proxy-auth-pi-'))
  piDirs.push(dir)
  const env = {
    KORTIX_HARNESS: 'pi',
    KORTIX_PI_STATE_DIR: join(dir, 'state'),
    KORTIX_PI_AGENT_DIR: join(dir, 'agent'),
    KORTIX_PI_PACKAGES_DIR: join(dir, 'packages'),
  }
  return createPiHarnessService({ ...cfg, ...loadPiEnvironment(env) }, undefined, { env })
}

function buildApp(cfg: Config, harness: HarnessService = fakeHarness(), bootState?: PiBootState) {
  return buildDaemonApp(cfg, harness, Date.now(), bootState)
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
    const app = buildApp(baseConfig())
    const res = await app.request('/kortix/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      daemon: string
      auth: string
    }
    expect(body.daemon).toBe('ok')
    expect(body.auth).toBe('configured')
  })

  it('reports the same host facts as every harness, naming itself', async () => {
    const cfg = baseConfig()
    const harness = fakeHarness({
      diagnostics: {
        ...fakeHarness().diagnostics,
        health: async () => ({
          harness: { id: 'test', version: null, state: 'ok', ready: true, error: null, session: { id: null, required: false }, turn: null, details: { pid: null, port: 4096 } },
        }),
      },
    })
    const app = buildApp(cfg, harness)
    const body = (await (await app.request('/kortix/health')).json()) as Record<string, any>
    expect(body.harness).toMatchObject({ id: 'test', session: { id: null, required: false }, turn: null })
    expect(body.harness.details).toMatchObject({ pid: null, port: 4096 })
    // apps/api reads the runtime port for its PTY proxy with this function.
    expect(HarnessHealthSchema.parse(body.harness).details.port).toBe(4096)
    expect(healthRuntimePort(body)).toBe(4096)
    expect(body.runtime_truth).toBeDefined()
    const host = await readHostHealth({ cfg, bootTime: Date.now(), bootState: { repoMaterializationError: null, timeline: [] }, staticWebPort: null, resources: () => null })
    expect(Object.keys(body)).toEqual(expect.arrayContaining(Object.keys(host)))
  })

  it('reports auth=unconfigured when the sandbox token is unset', async () => {
    const app = buildApp(baseConfig({ sandboxToken: undefined }))
    const res = await app.request('/kortix/health')
    const body = (await res.json()) as { auth: string }
    expect(body.auth).toBe('unconfigured')
  })

  it('reports runtime not ready and blocks the runtime proxy when repo materialization failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-repo-failed-'))
    try {
      const target = join(root, 'workspace')
      mkdirSync(target)
      const cfg = baseConfig({ autoClone: true, projectTarget: target })
      const app = buildApp(cfg, piHarness(cfg), { repoMaterializationError: 'git clone failed: authentication required', timeline: [] })

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

      const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
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
    // A resume that sat through a slow first runtime init was parked as
    // runtime_boot_failed by a fixed 90 s budget. The header lets the API
    // restart its clock on progress instead.
    const root = mkdtempSync(join(tmpdir(), 'kortix-boot-phase-'))
    try {
      const target = join(root, 'workspace')
      mkdirSync(target)
      const cfg = baseConfig({ autoClone: false, projectTarget: target })
      const timeline: { label: string; atMs: number }[] = [{ label: 'config-deps', atMs: 1 }]
      const app = buildApp(cfg, piHarness(cfg), { repoMaterializationError: null, timeline })
      const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
      const first = await app.request('/session?directory=%2Fworkspace', {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect(first.status).toBe(503)
      const firstPhase = first.headers.get('x-kortix-boot-phase') ?? ''
      expect(firstPhase).not.toBe('')
      expect(firstPhase).toContain('config-deps')
      expect(firstPhase).toContain('pi=')
      expect(((await first.json()) as { phase: string }).phase).toBe(firstPhase)

      timeline.push({ label: 'repo-ready', atMs: 2 })
      const second = await app.request('/session?directory=%2Fworkspace', {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect(second.status).toBe(503)
      const secondPhase = second.headers.get('x-kortix-boot-phase')
      expect(secondPhase).not.toBe(firstPhase)

      // A box still waiting on its initial session names that wait.
      const waiting = buildApp(cfg, piHarness(cfg), { repoMaterializationError: null, timeline, initialRuntimeSessionRequired: true, initialRuntimeSessionId: null })
      const third = await waiting.request('/session?directory=%2Fworkspace', {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect(third.status).toBe(503)
      expect(third.headers.get('x-kortix-boot-phase')).toContain('initial_session_pending')
      expect(third.headers.get('x-kortix-boot-phase')).not.toBe(secondPhase)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('holds every caller off until the workspace is complete, then lifts that gate', async () => {
    const cfg = baseConfig()
    const bootState = { repoMaterializationError: null, timeline: [], workspaceReady: false }
    const app = buildApp(cfg, piHarness(cfg), bootState)
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const request = () =>
      app.request('/session?directory=%2Fworkspace', { headers: { [KORTIX_USER_CONTEXT_HEADER]: signed } })

    const held = await request()
    expect(held.status).toBe(503)
    expect(((await held.json()) as { reason: string }).reason).toBe('workspace_not_ready')

    bootState.workspaceReady = true
    // Past the workspace gate: the never-started runtime is the next answer.
    expect(((await (await request()).json()) as { reason: string }).reason).toBe('pi_not_ready')
  })

  it('keeps the runtime proxy disabled when auto-clone is enabled but no repo is present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-empty-workspace-'))
    try {
      const cfg = baseConfig({ autoClone: true, projectTarget: root })
      const app = buildApp(cfg, piHarness(cfg))
      const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
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
    const app = buildApp(baseConfig())
    const res = await app.request('/session/anything')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; reason: string }
    expect(body.error).toBe('unauthorized')
    expect(body.reason).toBe('malformed')
  })

  it('rejects bad-signature header → 401', async () => {
    const app = buildApp(baseConfig())
    const tampered = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, 'wrong-secret')
    const res = await app.request('/session/anything', {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: tampered },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe('bad_signature')
  })

  it('rejects expired token → 401', async () => {
    const app = buildApp(baseConfig())
    const expired = signTestUserContext(
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
    const app = buildApp(baseConfig({ sandboxToken: undefined }))
    const res = await app.request('/session/anything')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('daemon not configured')
    expect(body.detail).toContain('KORTIX_TOKEN')
  })

  it('passes valid token through to the runtime proxy (which then returns 503 because the runtime is not started)', async () => {
    const cfg = baseConfig()
    const app = buildApp(cfg, piHarness(cfg))
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const res = await app.request('/session/anything', {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
    })
    // Auth passed → runtime proxy ran → runtime not ready → 503 with that
    // shape (not the auth-gate's 401/503).
    expect(res.status).toBe(503)
    const body = (await res.json()) as { code: string; reason: string }
    expect(body.code).toBe('runtime_not_ready')
    expect(body.reason).toBe('pi_not_ready')
  })

  it('forwards valid token to the runtime (502 because it is unreachable, proves we got past the gate)', async () => {
    const harness = fakeHarness({
      proxy: {
        blockedPorts: () => [],
        readiness: async () => ({ ready: true }),
        forward: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:1') },
      },
    })
    const app = buildApp(baseConfig(), harness)
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const res = await app.request('/session/anything', {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
    })
    expect(res.status).toBe(502)
    const body = (await res.json()) as { error: string }
    expect(body.error).toBe('upstream unreachable')
  })

  it('the web proxy also refuses the daemon itself and the egress shim', async () => {
    // The composed web proxy rejects private destinations on every port.
    const cfg = baseConfig()
    const app = buildApp(cfg)
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    for (const port of [cfg.servicePort, egressShimPort()]) {
      const res = await app.request(`/web-proxy/http/127.0.0.1:${port}/session`, {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect({ port, status: res.status }).toEqual({ port, status: 403 })
      expect(((await res.json()) as { code: string }).code).toBe('WEB_PROXY_PORT_BLOCKED')
    }
  })

  it('the port proxy refuses the daemon itself and the egress shim', async () => {
    // portProxyRouter's blockedPorts is built the same way, straight from
    // cfg.servicePort + egressShimPort() (proxy.ts:157-164). No test anywhere
    // drove /proxy/{port}/* through the real buildDaemonApp composition to
    // prove that Set actually contains them — this closes that gap.
    const cfg = baseConfig()
    const app = buildApp(cfg)
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    for (const port of [cfg.servicePort, egressShimPort()]) {
      const res = await app.request(`/proxy/${port}/session`, {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect({ port, status: res.status }).toEqual({ port, status: 403 })
      expect(((await res.json()) as { error: string; port: number }).error).toBe('Port is blocked')
    }
  })

  it('rejects /kortix/abort without a signed user context', async () => {
    const app = buildApp(baseConfig())
    const res = await app.request('/kortix/abort', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; reason: string }
    expect(body.error).toBe('unauthorized')
    expect(body.reason).toBe('malformed')
  })

  it('rejects /kortix/abort when the sandbox token is unset', async () => {
    const app = buildApp(baseConfig({ sandboxToken: undefined }))
    const res = await app.request('/kortix/abort', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('daemon not configured')
    expect(body.detail).toContain('KORTIX_TOKEN')
  })

  it('lets signed /kortix/abort reach the abort handler', async () => {
    const cfg = baseConfig()
    const app = buildApp(cfg, piHarness(cfg))
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const res = await app.request('/kortix/abort', {
      method: 'POST',
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toBe('pi runtime is not started')
  })

})
