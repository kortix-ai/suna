/**
 * `installShutdownHandlers` runs one shutdown per process: the first request
 * stops the harness and exits with its code; a later one (a SIGTERM during an
 * agent swap) is a no-op.
 */
import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import { installShutdownHandlers, SHUTDOWN_HARNESS_STOP_MS } from '@/app/shutdown'
import { resetDaemonShutdownStateForTests } from '@/lib/shutdown-state'

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

describe('installShutdownHandlers', () => {
  test('a shutdown stops the harness, then exits with its code', async () => {
    let stopped = 0
    const exits: number[] = []
    const shutdown = installShutdownHandlers(fakeHarness(() => stopped++), fakeProxy(), undefined, {
      exit: (code) => exits.push(code),
    })
    shutdown({ reason: 'agent-swap', exitCode: 75 })
    // harness.stop() is awaited inside the async IIFE; give it a tick.
    await new Promise((r) => setTimeout(r, 10))
    expect(stopped).toBe(1)
    expect(exits).toEqual([75])
  })

  test('a second shutdown call is a no-op', async () => {
    let stopped = 0
    const exits: number[] = []
    const shutdown = installShutdownHandlers(fakeHarness(() => stopped++), fakeProxy(), undefined, {
      exit: (code) => exits.push(code),
    })
    shutdown({ reason: 'agent-swap', exitCode: 75 })
    shutdown({ reason: 'SIGTERM', exitCode: 0 })
    await new Promise((r) => setTimeout(r, 10))
    expect(stopped).toBe(1)
    expect(exits).toEqual([75])
  })

  test('a harness stop that never settles still exits at the deadline', async () => {
    jest.useFakeTimers()
    try {
      const exits: number[] = []
      const shutdown = installShutdownHandlers({ stop: () => new Promise<void>(() => {}) }, fakeProxy(), undefined, {
        exit: (code) => exits.push(code),
      })
      shutdown({ reason: 'SIGTERM', exitCode: 0 })
      for (let i = 0; i < 20; i += 1) await Promise.resolve()
      expect(exits).toEqual([])
      jest.advanceTimersByTime(SHUTDOWN_HARNESS_STOP_MS)
      for (let i = 0; i < 20 && exits.length === 0; i += 1) await Promise.resolve()
      expect(exits).toEqual([0])
    } finally {
      jest.useRealTimers()
    }
  })
})
