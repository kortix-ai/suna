import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * the runtime-convergence contract (PR #7785), Rule 3: "any call that materializes
 * runtime state must be reachable from the tick, not only from boot." A box
 * that only ever ran that call at boot is exactly the shape of failure #1
 * (the runtime-convergence contract (PR #7785) §1) and failure #5 (a resumed box never
 * re-runs boot at all).
 *
 * `src/services/runtime-assets/runtime-truth.ts` is host code and must not
 * import a concrete adapter directly (the boundary lint, eslint.config.mjs), so it drives every component through
 * injected closures (`RuntimeTruthDeps`) instead of calling the real
 * materializing functions itself. The check: `runtime-truth.ts`'s
 * `runReconcileTick` calls every one of those closures (a hook nobody calls is
 * dead wiring), and pi's boot wires the tick and its real reconcile calls.
 *
 * In the shape of this package's other tripwires (`boot-path-tripwire.test.ts`,
 * `test-state-reset-tripwire.test.ts`): a small reusable checker, tested with
 * both a passing fixture and a NEGATIVE PROBE (a fixture the checker must
 * catch), then applied to the real files.
 */

const runtimeTruthSource = readFileSync(resolve(import.meta.dir, '..', 'services', 'runtime-assets', 'runtime-truth.ts'), 'utf8')

/**
 * Every `name` in `names` must be called (`name(`, or `name?.(` for a hook a
 * runtime may leave out) somewhere in `source`. Returns the ones that are not.
 */
export function callsMissingFrom(source: string, names: readonly string[]): string[] {
  return names.filter((name) => !new RegExp(`\\b${name}\\s*(?:\\?\\.)?\\s*\\(`).test(source))
}

/** The tick's own hooks — one per component `runtime-truth.ts` owns. */
const TICK_HOOKS = ['reconcileAssets', 'reconcileConfigRelease', 'reconcileCatalog', 'readConfigRelease', 'readCatalog'] as const

describe('runtime-truth tick tripwire (Rule 3: no new boot-only convergence)', () => {
  test('the checker catches a name that is missing (negative probe)', () => {
    const fixture = "export function runReconcileTick() {\n  deps.reconcileAssets()\n}\n"
    expect(callsMissingFrom(fixture, ['reconcileAssets', 'reconcileConfigRelease'])).toEqual(['reconcileConfigRelease'])
  })

  test('the checker accepts a fixture that calls everything', () => {
    expect(callsMissingFrom('foo(); bar()\n', ['foo', 'bar'])).toEqual([])
    // An optional hook is still called: pi has no model catalog, so `readCatalog` is optional.
    expect(callsMissingFrom('deps.readCatalog?.()\n', ['readCatalog'])).toEqual([])
  })

  test('runReconcileTick calls every hook RuntimeTruthDeps defines — no dead wiring', () => {
    // Anti-vacuous: a scanner reading an empty/missing file would pass while
    // checking nothing.
    expect(runtimeTruthSource.length).toBeGreaterThan(2000)
    expect(runtimeTruthSource).toContain('export async function runReconcileTick')

    const missing = callsMissingFrom(runtimeTruthSource, TICK_HOOKS)
    expect(missing).toEqual([])
  })

  test('pi wires the tick from its runtime-ready path: config releases and runtime assets are reconciled every tick', () => {
    const piBoot = readFileSync(resolve(import.meta.dir, '..', 'harness', 'pi', 'boot.ts'), 'utf8')
    expect(callsMissingFrom(piBoot, ['configureRuntimeTruth', 'startRuntimeTruthTicker', 'scheduleRuntimeAssetsReconcile'])).toEqual([])
    expect(piBoot).toMatch(/reconcileConfigRelease:[\s\S]{0,120}harness\.releases\s*\.converge\(/)
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
