/**
 * Boot order for config releases (docs/specs/config-releases.md, "Boot").
 *
 * `runOpenCode` spawns real processes and clones a real repository, so the
 * order is pinned on its source, as `opencode-boot-order.test.ts` does. The
 * functions it calls are covered with real repositories in
 * config-release-boot.test.ts and config-release-converge.test.ts.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const BOOT = readFileSync(join(import.meta.dir, '..', 'harness', 'open-code', 'boot.ts'), 'utf8')

describe('boot from a config release', () => {
  test('a proven release is read before the lifecycle is created, and gates the directory probe', () => {
    const pointer = BOOT.indexOf('const earlyPointer = cfg.autoClone ? await provenReleaseForEarlySpawn()')
    const harness = BOOT.indexOf('const harness = createOpenCodeHarnessService(')
    expect(pointer).toBeGreaterThan(-1)
    expect(pointer).toBeLessThan(harness)
    expect(BOOT).toContain(
      'deferDirectoryProbe: cfg.autoClone && (hintedConfigDir !== null || earlyPointer !== null || releaseApi !== null)',
    )
  })

  test('the desired release is fetched in parallel with the clone, not after it', () => {
    const clone = BOOT.indexOf('const repoMaterializePromise')
    const fetch = BOOT.indexOf('const bootReleasePromise')
    const wait = BOOT.indexOf('await repoMaterializePromise')
    expect(clone).toBeGreaterThan(-1)
    expect(fetch).toBeGreaterThan(clone)
    expect(fetch).toBeLessThan(wait)
    expect(BOOT.slice(fetch, wait)).toContain('fetchBootRelease({')
  })

  test('the early spawn races the release against the clone and starts OpenCode before the checkout wait', () => {
    const early = BOOT.indexOf('const earlyOpencodeStartPromise')
    const wait = BOOT.indexOf('await repoMaterializePromise')
    const body = BOOT.slice(early, wait)
    expect(body).toContain('let dir = earlyPointer?.dir ?? null')
    expect(body).toContain('Promise.race([')
    expect(body).toContain('bootReleasePromise,')
    expect(body).toContain("repoMaterializePromise.then(() => 'checkout' as const)")
    // The release's governance reaches the spawn.
    expect(body.indexOf('deliverGovernance(')).toBeLessThan(body.indexOf('await opencode.start()'))
  })

  test('a fetched release runs unproven; the pointer is not trusted for it', () => {
    expect(BOOT).toContain("proven: activeConfig.source === 'release' && !bootRelease")
  })

  test('no dependency or overlay writes into the workspace while a release runs', () => {
    const branch = BOOT.indexOf('if (runsRelease) {')
    const deps = BOOT.indexOf('await ensureOpencodeConfigDeps(opencodeConfigDir)')
    expect(branch).toBeGreaterThan(-1)
    expect(deps).toBeGreaterThan(branch)
    expect(BOOT.slice(branch, deps)).toContain('} else if (!opencodeStartedFromCompiledConfig) {')
  })

  test('one convergence runs after ready, at both readiness exits', () => {
    const exits = BOOT.split("bootMark('opencode-ready')").slice(1)
    const sessionExits = exits.filter((after) => after.includes('scheduleRuntimeAssetsReconcile(cfg)'))
    expect(sessionExits.length).toBe(2)
    for (const after of sessionExits) {
      const reconcile = after.indexOf('scheduleRuntimeAssetsReconcile(cfg)')
      expect(after.slice(reconcile, reconcile + 200)).toContain('scheduleConvergenceAfterReady(opencode, cfg, bootMark)')
    }
    // Seed adoption reaches the same exits through startSessionRuntime.
    const adopt = BOOT.slice(BOOT.indexOf('function armSeedAdoption('))
    expect(adopt.slice(0, adopt.indexOf("process.on('SIGHUP'"))).toContain('await startSessionRuntime(harness, cfg2')
  })

  test('the convergence after ready waits for a running turn and marks a proven release', () => {
    const fn = BOOT.slice(BOOT.indexOf('function scheduleConvergenceAfterReady('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toContain('turnInFlight: () => opencodeTurnInFlight(opencode.getInternalUrl(), cfg.workspace)')
    expect(body).toContain("bootMark('config-release-proven')")
  })

  test('DEF-4: a fetched release is proven before the session runtime starts, after the workspace gate opens', () => {
    const gate = BOOT.indexOf('opencode.markWorkspaceReady()', BOOT.indexOf('const runsRelease'))
    const proof = BOOT.indexOf('await proveBootConfig({')
    const runtime = BOOT.indexOf('void startSessionRuntime(harness, cfg, bootState, bootMark)')
    expect(gate).toBeGreaterThan(-1)
    expect(proof).toBeGreaterThan(gate)
    expect(runtime).toBeGreaterThan(proof)
    const call = BOOT.slice(proof, BOOT.indexOf('})', BOOT.indexOf('spawnOn:', proof)))
    expect(call).toContain('restoreGovernance: restoreBootGovernance')
    expect(call).toContain('await opencode.restart()')
    // A compiled-config process never runs the fetched release.
    expect(BOOT).toContain('const bootRelease: BootRelease | null = opencodeStartedFromCompiledConfig')
  })
})
