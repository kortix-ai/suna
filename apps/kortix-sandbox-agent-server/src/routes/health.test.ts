import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'

import type { AcpHarnessRegistry } from '../acp/harness-registry'
import { AcpRuntime } from '../acp/runtime'
import { createHealthRouter, type SandboxBootState } from './health'

// Regression coverage for the "Connecting spins forever" class of bug: a
// harness that spawned fine at boot but has since died (crash, OOM, a
// recycle after credential rotation) must not keep reporting `acp_ready:
// true` / `runtimeReady: true` forever. `bootState.acpRuntimeReady` is set
// ONCE at daemon boot (main.ts) and never updated again; `/start`'s polling
// loop (apps/api/src/projects/routes/shared.ts) trusts `runtimeReady`
// verbatim to decide `stage: 'ready'`, and the web app's 90s wall-clock boot
// backstop explicitly stands down once `session.phase === 'ready'` — so a
// stale "ready" here is the exact silent stall the fix closes off: nothing
// downstream ever gets a terminal signal.
describe('kortix/health cross-checks the boot flag against the LIVE acp runtime', () => {
  const cleanups: Array<() => Promise<void> | void> = []
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()?.()
  })

  function mockRegistry(cwd: string): AcpHarnessRegistry {
    const fixture = join(cwd, '..', '__tests__', 'fixtures', 'mock-acp-agent.ts')
    return new Map([
      [
        'opencode',
        {
          id: 'opencode',
          displayName: 'Mock OpenCode',
          adapter: 'test',
          launch: { command: process.execPath, args: [fixture] },
        },
      ],
    ]) as AcpHarnessRegistry
  }

  it('reports ready only while the spawned process is actually registered in the runtime', async () => {
    const cwd = import.meta.dir
    const registry = mockRegistry(cwd)
    const runtime = new AcpRuntime({ registry, cwd })
    cleanups.push(() => runtime.shutdown())

    const bootState: SandboxBootState = {
      repoMaterializationError: null,
      timeline: [],
      acpHarness: 'opencode',
      acpServerId: 'server-1',
      acpRuntimeReady: false,
      acpRuntimeError: null,
    }

    // Before anything spawns: health must NOT claim ready.
    const preSpawnRouter = createHealthRouter({ autoClone: false } as never, Date.now(), bootState, null, runtime)
    const preSpawnRes = await preSpawnRouter.request('/')
    const preSpawnBody = (await preSpawnRes.json()) as Record<string, unknown>
    expect(preSpawnBody.runtimeReady).toBe(false)
    expect(preSpawnBody.acp_ready).toBe(false)

    // Boot-time spawn succeeds — mirrors main.ts's `await runtime.getOrCreate(...)`
    // followed by `bootState.acpRuntimeReady = true`.
    await runtime.getOrCreate('server-1', 'opencode')
    bootState.acpRuntimeReady = true

    const readyRouter = createHealthRouter({ autoClone: false } as never, Date.now(), bootState, null, runtime)
    const readyRes = await readyRouter.request('/')
    const readyBody = (await readyRes.json()) as Record<string, unknown>
    expect(readyBody.runtimeReady).toBe(true)
    expect(readyBody.acp_ready).toBe(true)
    expect(readyBody.status).toBe('ok')
    expect(readyBody.boot_error).toBeNull()

    // The harness process dies later (crash, OOM, recycle) — `runtime.list()`
    // reflects this immediately (AcpProcess.fail -> onUnexpectedExit removes
    // the map entry), but `bootState.acpRuntimeReady` is untouched: it is
    // NEVER written again after boot. Without the health-side liveness
    // cross-check this is exactly the stale "ready" that lets `/start` report
    // `stage: 'ready'` for a harness that is not running.
    await runtime.delete('server-1')
    expect(runtime.list()).toEqual([])
    expect(bootState.acpRuntimeReady).toBe(true) // the stale flag itself never changes

    const postDeathRouter = createHealthRouter({ autoClone: false } as never, Date.now(), bootState, null, runtime)
    const postDeathRes = await postDeathRouter.request('/')
    const postDeathBody = (await postDeathRes.json()) as Record<string, unknown>
    expect(postDeathBody.runtimeReady).toBe(false)
    expect(postDeathBody.acp_ready).toBe(false)
    expect(postDeathBody.status).toBe('error')
    expect(typeof postDeathBody.boot_error).toBe('string')
    expect(postDeathBody.boot_error).toContain('not currently running')

    // The daemon is still alive and will transparently respawn the harness on
    // the next `/acp` request — prove the honest post-death report doesn't
    // wedge anything by respawning and confirming health flips back to ready.
    await runtime.getOrCreate('server-1', 'opencode')
    const respawnedRouter = createHealthRouter({ autoClone: false } as never, Date.now(), bootState, null, runtime)
    const respawnedRes = await respawnedRouter.request('/')
    const respawnedBody = (await respawnedRes.json()) as Record<string, unknown>
    expect(respawnedBody.runtimeReady).toBe(true)
    expect(respawnedBody.acp_ready).toBe(true)
  })

  it('a boot-time spawn failure (e.g. the harness executable missing) is never masked by a stale true flag', async () => {
    const cwd = import.meta.dir
    // Deliberately unresolvable command — mirrors "Executable not found in
    // $PATH" for a harness whose child never starts at all.
    const registry: AcpHarnessRegistry = new Map([
      [
        'opencode',
        {
          id: 'opencode',
          displayName: 'Mock OpenCode (broken)',
          adapter: 'test',
          launch: { command: '/nonexistent/kortix-test-binary-does-not-exist', args: [] },
        },
      ],
    ]) as AcpHarnessRegistry
    const runtime = new AcpRuntime({ registry, cwd })
    cleanups.push(() => runtime.shutdown())

    const bootState: SandboxBootState = {
      repoMaterializationError: null,
      timeline: [],
      acpHarness: 'opencode',
      acpServerId: 'server-broken',
      acpRuntimeReady: false,
      acpRuntimeError: null,
    }

    // getOrCreate's underlying spawn() never throws synchronously for ENOENT
    // — this resolves as if "success", exactly like the real boot path.
    await runtime.getOrCreate('server-broken', 'opencode')
    bootState.acpRuntimeReady = true

    // Give the child process's async 'error' event a tick to fire and remove
    // itself from the runtime map (AcpProcess.fail -> onUnexpectedExit).
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(runtime.list()).toEqual([])

    const router = createHealthRouter({ autoClone: false } as never, Date.now(), bootState, null, runtime)
    const res = await router.request('/')
    const body = (await res.json()) as Record<string, unknown>
    expect(body.runtimeReady).toBe(false)
    expect(body.acp_ready).toBe(false)
    expect(body.status).toBe('error')
  })
})
