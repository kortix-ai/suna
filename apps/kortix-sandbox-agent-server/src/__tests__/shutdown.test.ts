/**
 * `isDaemonShuttingDown()` — the signal DEF-A needs.
 *
 * A candidate OpenCode that `harness.stop()` kills mid-verify is
 * indistinguishable, from inside `reloadVerified`, from one that genuinely
 * never started: both come back `cause: null`. The daemon knows the
 * difference — it is the thing calling `stop()` — so this module states it
 * instead of `config-release.ts` guessing from a symptom.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { installShutdownHandlers } from '../app/shutdown'
import { isDaemonShuttingDown, resetDaemonShutdownStateForTests } from '../lib/shutdown-state'

function fakeProxy() {
  return {
    port: 0,
    reload: () => {},
    stop: async () => {},
  }
}

function fakeHarness(onStop?: () => void) {
  return {
    stop: async (_signal?: NodeJS.Signals) => {
      onStop?.()
    },
  }
}

beforeEach(() => {
  resetDaemonShutdownStateForTests()
})

afterEach(() => {
  resetDaemonShutdownStateForTests()
})

describe('isDaemonShuttingDown', () => {
  test('false before any shutdown was requested', () => {
    expect(isDaemonShuttingDown()).toBe(false)
  })

  test('true the instant a shutdown starts — before harness.stop() resolves', async () => {
    let sawItDuringStop = false
    const harness = fakeHarness(() => {
      sawItDuringStop = isDaemonShuttingDown()
    })
    const exits: number[] = []
    const shutdown = installShutdownHandlers(harness, fakeProxy(), undefined, {
      exit: (code) => exits.push(code),
    })
    expect(isDaemonShuttingDown()).toBe(false)
    shutdown({ reason: 'agent-swap', exitCode: 75 })
    // harness.stop() is awaited inside the async IIFE; give it a tick.
    await new Promise((r) => setTimeout(r, 10))
    expect(sawItDuringStop).toBe(true)
    expect(isDaemonShuttingDown()).toBe(true)
    expect(exits).toEqual([75])
  })

  test('a second shutdown call is a no-op — the flag does not un-set', async () => {
    const harness = fakeHarness()
    const exits: number[] = []
    const shutdown = installShutdownHandlers(harness, fakeProxy(), undefined, {
      exit: (code) => exits.push(code),
    })
    shutdown({ reason: 'agent-swap', exitCode: 75 })
    shutdown({ reason: 'SIGTERM', exitCode: 0 })
    await new Promise((r) => setTimeout(r, 10))
    expect(isDaemonShuttingDown()).toBe(true)
    expect(exits).toEqual([75])
  })
})
