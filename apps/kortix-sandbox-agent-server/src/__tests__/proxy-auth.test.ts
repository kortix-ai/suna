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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { Opencode } from '../harness/open-code/lifecycle'
import {
  buildOpenCodeTestApp,
  signTestUserContext,
  TEST_SANDBOX_TOKEN,
  testOpenCodeConfig,
} from './helpers/open-code-harness'
import { finalizeInitialSession } from '../harness/open-code/boot'
import { KORTIX_USER_CONTEXT_HEADER } from '../kortix-user-context'

const TEST_TOKEN = TEST_SANDBOX_TOKEN
const baseConfig = testOpenCodeConfig

function fakeOpencode(
  state: 'ok' | 'starting' | 'down' = 'starting',
  hooks: { internalUrl?: string } = {},
): Opencode {
  // Loose cast: the gate, health and proxy rows read only these.
  return {
    getState: () => state,
    getPid: () => null,
    getInternalUrl: () => hooks.internalUrl ?? 'http://127.0.0.1:1', // unreachable by default
    // Health reports this so the API's PTY proxy can follow opencode across a
    // reload swap. Omitting it made every /kortix/health assertion 500.
    getActivePort: () => 4096,
  } as unknown as Opencode
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
    const app = buildOpenCodeTestApp(baseConfig(), fakeOpencode(), Date.now())
    const res = await app.request('/kortix/health')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      daemon: string
      auth: string
      compiled_boot_mode: string
      compiled_checkout: boolean
      compiled_runtime: boolean
    }
    expect(body.daemon).toBe('ok')
    expect(body.auth).toBe('configured')
    expect(body.compiled_boot_mode).toBe('off')
    expect(body.compiled_checkout).toBe(false)
    expect(body.compiled_runtime).toBe(false)
  })

  it('reports when the workspace came from a compiled checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-compiled-health-'))
    try {
      const target = join(root, 'workspace')
      git(['init', '-b', 'main', target])
      writeFileSync(join(target, '.git', 'kortix-compiled-checkout.json'), '{}')
      const app = buildOpenCodeTestApp(
        baseConfig({ projectTarget: target, compiledBootMode: 'prefer' }),
        fakeOpencode(),
        Date.now(),
      )

      const res = await app.request('/kortix/health')
      const body = (await res.json()) as {
        compiled_boot_mode: string
        compiled_checkout: boolean
      }
      expect(body.compiled_boot_mode).toBe('prefer')
      expect(body.compiled_checkout).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('reports auth=unconfigured when the sandbox token is unset', async () => {
    const app = buildOpenCodeTestApp(baseConfig({ sandboxToken: undefined }), fakeOpencode(), Date.now())
    const res = await app.request('/kortix/health')
    const body = (await res.json()) as { auth: string }
    expect(body.auth).toBe('unconfigured')
  })

  it('reports runtime not ready and blocks OpenCode proxy when repo materialization failed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-repo-failed-'))
    try {
      const target = join(root, 'workspace')
      mkdirSync(target)
      const app = buildOpenCodeTestApp(
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
    // SampleCo 2026-08-25 17:23: a resume that converged OpenCode 1.18.19 →
    // 1.18.23 and sat through the new version's 53 s first init was parked as
    // runtime_boot_failed by a fixed 90 s budget. The header lets the API
    // restart its clock on progress instead.
    const root = mkdtempSync(join(tmpdir(), 'kortix-boot-phase-'))
    try {
      const target = join(root, 'workspace')
      mkdirSync(target)
      const timeline: { label: string; atMs: number }[] = [{ label: 'config-deps', atMs: 1 }]
      const app = buildOpenCodeTestApp(
        baseConfig({ autoClone: false, projectTarget: target }),
        fakeOpencode('starting'),
        Date.now(),
        { repoMaterializationError: null, timeline },
      )
      const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
      const first = await app.request('/session?directory=%2Fworkspace', {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect(first.status).toBe(503)
      const firstPhase = first.headers.get('x-kortix-boot-phase') ?? ''
      expect(firstPhase).not.toBe('')
      expect(firstPhase).toContain('config-deps')
      expect(firstPhase).toContain('opencode=starting')
      expect(((await first.json()) as { phase: string }).phase).toBe(firstPhase)

      timeline.push({ label: 'opencode-spawned', atMs: 2 })
      const second = await app.request('/session?directory=%2Fworkspace', {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect(second.status).toBe(503)
      const secondPhase = second.headers.get('x-kortix-boot-phase')
      expect(secondPhase).not.toBe(firstPhase)

      // OpenCode answering is progress too, even while the box still waits on
      // its initial session.
      const answering = buildOpenCodeTestApp(
        baseConfig({ autoClone: false, projectTarget: target }),
        fakeOpencode('ok'),
        Date.now(),
        { repoMaterializationError: null, timeline, initialOpenCodeSessionRequired: true, initialOpenCodeSessionId: null },
      )
      const third = await answering.request('/session?directory=%2Fworkspace', {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect(third.status).toBe(503)
      expect(third.headers.get('x-kortix-boot-phase')).toContain('opencode=ok')
      expect(third.headers.get('x-kortix-boot-phase')).not.toBe(secondPhase)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps runtime not ready until the boot OpenCode session is pinned', async () => {
    const app = buildOpenCodeTestApp(
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

    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const res = await app.request('/session?directory=%2Fworkspace', {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe('initial_opencode_session_pending')
  })

  it('holds every caller off until the workspace is complete, then lets them through', async () => {
    // A directory-scoped request before the config-dir dependencies land makes
    // OpenCode cache a tool registry whose imports failed, for the life of the
    // process.
    const bootState = { repoMaterializationError: null, timeline: [], workspaceReady: false }
    const app = buildOpenCodeTestApp(baseConfig(), fakeOpencode('ok'), Date.now(), bootState)
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const request = () =>
      app.request('/session?directory=%2Fworkspace', { headers: { [KORTIX_USER_CONTEXT_HEADER]: signed } })

    const held = await request()
    expect(held.status).toBe(503)
    expect(((await held.json()) as { reason: string }).reason).toBe('workspace_not_ready')

    bootState.workspaceReady = true
    // Past the gate: the unreachable fake upstream answers 502.
    expect((await request()).status).toBe(502)
  })

  it('a failed initial-session attempt blocks callers only until a later attempt succeeds', async () => {
    // The flag was written on a caught throw and cleared nowhere, so one
    // failed rung of the retry ladder wedged the box until a manual Restart.
    const bootState = {
      repoMaterializationError: null,
      timeline: [],
      initialOpenCodeSessionRequired: true,
      initialOpenCodeSessionId: null as string | null,
      initialOpenCodeSessionError: 'ECONNREFUSED on attempt 1' as string | null,
    }
    const app = buildOpenCodeTestApp(baseConfig(), fakeOpencode('ok'), Date.now(), bootState)
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const request = () =>
      app.request('/session?directory=%2Fworkspace', { headers: { [KORTIX_USER_CONTEXT_HEADER]: signed } })

    const failed = await request()
    expect(failed.status).toBe(503)
    expect(((await failed.json()) as { reason: string }).reason).toBe('initial_opencode_session_failed')

    finalizeInitialSession(bootState, 'ses_root_abc')

    // The gate lets the caller through to OpenCode (unreachable here: 502).
    expect((await request()).status).toBe(502)
  })

  it('keeps OpenCode proxy disabled when auto-clone is enabled but no repo is present', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-empty-workspace-'))
    try {
      const app = buildOpenCodeTestApp(
        baseConfig({ autoClone: true, projectTarget: root }),
        fakeOpencode('ok'),
        Date.now(),
      )
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
    const app = buildOpenCodeTestApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const res = await app.request('/session/anything')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; reason: string }
    expect(body.error).toBe('unauthorized')
    expect(body.reason).toBe('malformed')
  })

  it('rejects bad-signature header → 401', async () => {
    const app = buildOpenCodeTestApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const tampered = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, 'wrong-secret')
    const res = await app.request('/session/anything', {
      headers: { [KORTIX_USER_CONTEXT_HEADER]: tampered },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { reason: string }
    expect(body.reason).toBe('bad_signature')
  })

  it('rejects expired token → 401', async () => {
    const app = buildOpenCodeTestApp(baseConfig(), fakeOpencode('ok'), Date.now())
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
    const app = buildOpenCodeTestApp(baseConfig({ sandboxToken: undefined }), fakeOpencode('ok'), Date.now())
    const res = await app.request('/session/anything')
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('daemon not configured')
    expect(body.detail).toContain('KORTIX_TOKEN')
  })

  it('passes valid token through to the reverse-proxy (which then returns 503 because opencode is starting)', async () => {
    const app = buildOpenCodeTestApp(baseConfig(), fakeOpencode('starting'), Date.now())
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
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
    const app = buildOpenCodeTestApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
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
        const app = buildOpenCodeTestApp(
          baseConfig(),
          fakeOpencode('ok', { internalUrl: `http://127.0.0.1:${hungUpstream.port}` }),
          Date.now(),
        )
        const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
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

  it('the web proxy refuses both OpenCode ports, the standby half included', async () => {
    // A verified reload promotes the standby port; an unguarded half would be a
    // route from the sandbox to its own OpenCode that skips every control
    // apps/api applies on the way in.
    const app = buildOpenCodeTestApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    for (const port of [4096, 4097]) {
      const res = await app.request(`/web-proxy/http/127.0.0.1:${port}/session`, {
        headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
      })
      expect({ port, status: res.status }).toEqual({ port, status: 403 })
      expect(((await res.json()) as { code: string }).code).toBe('WEB_PROXY_PORT_BLOCKED')
    }
  })

  it('rejects /kortix/abort without a signed user context', async () => {
    const app = buildOpenCodeTestApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const res = await app.request('/kortix/abort', { method: 'POST' })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: string; reason: string }
    expect(body.error).toBe('unauthorized')
    expect(body.reason).toBe('malformed')
  })

  it('rejects /kortix/abort when the sandbox token is unset', async () => {
    const app = buildOpenCodeTestApp(baseConfig({ sandboxToken: undefined }), fakeOpencode('ok'), Date.now())
    const res = await app.request('/kortix/abort', { method: 'POST' })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: string; detail: string }
    expect(body.error).toBe('daemon not configured')
    expect(body.detail).toContain('KORTIX_TOKEN')
  })

  it('lets signed /kortix/abort reach the abort handler', async () => {
    const app = buildOpenCodeTestApp(baseConfig(), fakeOpencode('ok'), Date.now())
    const signed = signTestUserContext({ userId: 'u', sandboxId: 's', sandboxRole: 'owner' }, TEST_TOKEN)
    const res = await app.request('/kortix/abort', {
      method: 'POST',
      headers: { [KORTIX_USER_CONTEXT_HEADER]: signed },
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { ok: boolean; error: string }
    expect(body.ok).toBe(false)
    expect(body.error).toContain('No opencode session pinned')
  })

})
