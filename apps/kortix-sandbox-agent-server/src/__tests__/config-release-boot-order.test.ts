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

  test('OpenCode spawns at once on the boot link; nothing before the spawn waits for the release', () => {
    const early = BOOT.indexOf('const earlyOpencodeStartPromise')
    const end = BOOT.indexOf('const compiledOpencodeConfigDir', early)
    const body = BOOT.slice(early, end)
    // Verification 2026-09-21: waiting for the descriptor and the extraction
    // before the spawn cost +1,609 ms to opencode-spawned.
    expect(body).not.toContain('bootReleasePromise,')
    expect(body).not.toContain('await bootReleasePromise')
    expect(body).toContain('await pointBootLink(earlyPointer?.dir ?? cfg.defaultOpencodeConfigDir)')
    expect(body.indexOf('pointBootLink(')).toBeLessThan(body.indexOf('await opencode.start()'))
  })

  test('the boot link is repointed to the chosen config before the workspace gate opens', () => {
    const repoint = BOOT.indexOf('await pointBootLink(opencodeConfigDir)')
    const decided = BOOT.indexOf('const opencodeConfigDir = activeConfig.dir')
    const gate = BOOT.indexOf('opencode.markWorkspaceReady()', repoint)
    const reload = BOOT.indexOf('harness.configuration.reloadForWorkspace()', gate)
    expect(decided).toBeGreaterThan(-1)
    expect(repoint).toBeGreaterThan(decided)
    expect(gate).toBeGreaterThan(repoint)
    expect(reload).toBeGreaterThan(gate)
    // The release governance is delivered before the composed config is rewritten.
    expect(BOOT.indexOf('restoreBootGovernance = deliverGovernance(')).toBeLessThan(reload)
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
    expect(call).toContain('await opencode.restart({ finalizeTurn: false')
    // A compiled-config process never runs the fetched release.
    expect(BOOT).toContain('opencodeStartedFromCompiledConfig || !bootReleasePromise || bootState.repoMaterializationError')
  })

  test('DEF-4b: a workspace boot is proven too, with the quarantined release as its prior reason', () => {
    const proof = BOOT.indexOf('await proveBootFallback({')
    const runtime = BOOT.indexOf('void startSessionRuntime(harness, cfg, bootState, bootMark)')
    expect(proof).toBeGreaterThan(BOOT.indexOf('await proveBootConfig({'))
    expect(runtime).toBeGreaterThan(proof)
    expect(BOOT).toContain("activeConfig.source === 'workspace'")
    expect(BOOT).toContain('quarantinedAtBoot = { releaseId, reason }')
  })

  test('DEF-4c: a fallback step never waits 60 s for a config that cannot become ready', () => {
    // Verification 2026-09-22: a fresh session on a broken main spent exactly
    // 60.0 s on the workspace step (spawn 07:39:33.006 -> next step
    // 07:40:33.027). restart() waited RESPAWN_FINALIZE_TIMEOUT_MS for readiness
    // to finalize an orphaned turn; a broken config never becomes ready, and at
    // boot there is no turn to finalize. Every boot spawnOn skips that wait.
    const spawnOns = BOOT.split('spawnOn: async (dir) => {').slice(1).map((s) => s.slice(0, s.indexOf('},')))
    expect(spawnOns.length).toBe(2)
    for (const body of spawnOns) {
      expect(body).toContain('await opencode.restart({ finalizeTurn: false })')
      expect(body).not.toContain('await opencode.restart()')
    }
  })
})
