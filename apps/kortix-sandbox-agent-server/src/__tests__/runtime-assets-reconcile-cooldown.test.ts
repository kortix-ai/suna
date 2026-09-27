// 2026-09-27: `scheduleRuntimeAssetsReconcile`/`ensureLatestKortixAssets` were
// already fire-and-forget on every call site (boot, `/kortix/refresh`, idle),
// but nothing stopped a respawn-heavy box from re-running a FULL pass —
// manifest fetch + local CLI/skill hash — every single time, even seconds
// after a pass that fully converged. `env-sync-skip-decision.ts` (apps/api)
// fixes the respawn frequency itself; `recentlyFullyConverged` is the
// defense-in-depth half here: a converged pass is trusted for
// `RECONCILE_COOLDOWN_MS` so a burst of triggers costs at most one real pass.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  __resetReconcileCooldownForTests,
  __setConvergenceTimestampForTests,
  noteRuntimeConvergence,
  recentlyFullyConverged,
  type RuntimeAssetsResult,
  registerHarnessAssets,
  resetHarnessAssetsForTests,
} from '../services/runtime-assets/runtime-assets'
import { resolveHarness } from '../harness/harness'

// Production registers this lookup in main.ts before anything runs.
beforeAll(() => registerHarnessAssets((cfg) => resolveHarness(cfg).assets))
afterAll(() => resetHarnessAssetsForTests())

function converged(overrides: Partial<RuntimeAssetsResult> = {}): RuntimeAssetsResult {
  return { cli: 'current', skills: 'current', build: 1, ...overrides }
}

// Reset on the way IN and the way OUT — `lastConvergence` is module-level
// state shared with every other file in this bun process (see
// `test-state-reset-tripwire.test.ts`), so leaving it set after the last test
// here would leak into whichever suite runs next.
beforeEach(() => {
  __resetReconcileCooldownForTests()
})

afterEach(() => {
  __resetReconcileCooldownForTests()
})

describe('recentlyFullyConverged', () => {
  test('false before any pass has ever completed', () => {
    expect(recentlyFullyConverged()).toBe(false)
  })

  test('true immediately after a pass where every component converged', () => {
    noteRuntimeConvergence(converged())
    expect(recentlyFullyConverged()).toBe(true)
  })

  test('false when the last pass left a component failed — self-heal must not be suppressed', () => {
    noteRuntimeConvergence(converged({ cli: 'failed' }))
    expect(recentlyFullyConverged()).toBe(false)
  })

  test('true just under the cooldown window', () => {
    noteRuntimeConvergence(converged())
    __setConvergenceTimestampForTests(new Date(Date.now() - 59_000).toISOString())
    expect(recentlyFullyConverged()).toBe(true)
  })

  test('false once the cooldown window has elapsed', () => {
    noteRuntimeConvergence(converged())
    __setConvergenceTimestampForTests(new Date(Date.now() - 61_000).toISOString())
    expect(recentlyFullyConverged()).toBe(false)
  })
})
