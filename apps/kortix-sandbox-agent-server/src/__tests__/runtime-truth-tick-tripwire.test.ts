import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * docs/specs/runtime-convergence.md, Rule 3: "any call that materializes
 * runtime state must be reachable from the tick, not only from boot." A box
 * that only ever ran that call at boot is exactly the shape of failure #1
 * (docs/specs/runtime-convergence.md §1) and failure #5 (a resumed box never
 * re-runs boot at all).
 *
 * `src/runtime-truth.ts` is host code and must not import a concrete adapter
 * directly (harness-boundary.test.ts), so it drives every component through
 * injected closures (`RuntimeTruthDeps`) instead of calling the real
 * materializing functions itself. The check therefore has two halves:
 *
 *  1. `runtime-truth.ts`'s `runReconcileTick` calls every one of those
 *     closures — a hook nobody calls is dead wiring.
 *  2. `harness/open-code/runtime-truth-glue.ts` — the ONE place those
 *     closures are built — actually calls the real state-materializing
 *     function behind each one, not a no-op.
 *
 * Together they prove the same thing `boot.ts`'s one-shot calls used to leave
 * unproven: every component the daemon owns is reachable from the recurring
 * tick, not only from boot.
 *
 * In the shape of this package's other tripwires (`harness-boundary.test.ts`,
 * `test-state-reset-tripwire.test.ts`): a small reusable checker, tested with
 * both a passing fixture and a NEGATIVE PROBE (a fixture the checker must
 * catch), then applied to the real files.
 */

const runtimeTruthSource = readFileSync(resolve(import.meta.dir, '..', 'runtime-truth.ts'), 'utf8')
const glueSource = readFileSync(resolve(import.meta.dir, '..', 'harness', 'open-code', 'runtime-truth-glue.ts'), 'utf8')

/** Every `name` in `names` must be called (`name(`) somewhere in `source`. Returns the ones that are not. */
export function callsMissingFrom(source: string, names: readonly string[]): string[] {
  return names.filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(source))
}

/** The tick's own hooks — one per component `runtime-truth.ts` owns. */
const TICK_HOOKS = ['reconcileAssets', 'reconcileConfigRelease', 'reconcileCatalog', 'readConfigRelease', 'readCatalog'] as const

/** The real functions each hook must resolve to, on a real box (via the glue file). */
const MATERIALIZING_ENTRY_POINTS = [
  // cli / managed_skills / daemon(agent) — runtime-assets.ts's manifest pass.
  'scheduleRuntimeAssetsReconcile',
  // config_release — downloads and proves a release candidate.
  'convergeConfigRelease',
  // catalog — the live managed-lineup fetch this spec's failure #1 is about.
  'startManagedModelsPrefetch',
  // catalog's repair half — writes the overlay and restarts opencode onto it.
  'writeManagedOverlayCatalogFile',
] as const

describe('runtime-truth tick tripwire (Rule 3: no new boot-only convergence)', () => {
  test('the checker catches a name that is missing (negative probe)', () => {
    const fixture = "export function runReconcileTick() {\n  deps.reconcileAssets()\n}\n"
    expect(callsMissingFrom(fixture, ['reconcileAssets', 'reconcileConfigRelease'])).toEqual(['reconcileConfigRelease'])
  })

  test('the checker accepts a fixture that calls everything', () => {
    expect(callsMissingFrom('foo(); bar()\n', ['foo', 'bar'])).toEqual([])
  })

  test('runReconcileTick calls every hook RuntimeTruthDeps defines — no dead wiring', () => {
    // Anti-vacuous: a scanner reading an empty/missing file would pass while
    // checking nothing.
    expect(runtimeTruthSource.length).toBeGreaterThan(2000)
    expect(runtimeTruthSource).toContain('export async function runReconcileTick')

    const missing = callsMissingFrom(runtimeTruthSource, TICK_HOOKS)
    expect(missing).toEqual([])
  })

  test('the glue file resolves every hook to a REAL materializing call, not a no-op', () => {
    expect(glueSource.length).toBeGreaterThan(500)
    expect(glueSource).toContain('export function wireRuntimeTruth')

    const missing = callsMissingFrom(glueSource, MATERIALIZING_ENTRY_POINTS)
    expect(missing).toEqual([])
  })

  test('the glue file is wired from a runtime-ready exit, not a one-shot boot script that could stop being called', () => {
    const bootSource = readFileSync(resolve(import.meta.dir, '..', 'harness', 'open-code', 'boot.ts'), 'utf8')
    expect(bootSource).toContain('wireRuntimeTruth(')
  })

  test('boot is not the only caller: runtime-truth.ts itself starts the periodic floor, not just a one-shot boot pass', () => {
    expect(runtimeTruthSource).toContain('export function startRuntimeTruthTicker')
    expect(runtimeTruthSource).toMatch(/setInterval\(/)
    // The boot-only failure mode this guards: a `runReconcileTick('boot')`
    // that is never called again. `startRuntimeTruthTicker` must schedule a
    // RECURRING tick, not only the immediate one.
    expect(runtimeTruthSource).toMatch(/runReconcileTick\('periodic'\)/)
  })
})
