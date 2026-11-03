import { describe, expect, test } from 'bun:test'
import { afterFirstTurn, type GateTimers } from './after-first-turn'

function fakeTimers() {
  const scheduled: Array<{ fn: () => void; ms: number; cleared: boolean }> = []
  const timers: GateTimers = {
    setTimeout: (fn, ms) => {
      const entry = { fn, ms, cleared: false }
      scheduled.push(entry)
      return entry
    },
    clearTimeout: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
  }
  const fire = () => scheduled.filter((entry) => !entry.cleared).forEach((entry) => entry.fn())
  return { timers, scheduled, fire }
}

describe('afterFirstTurn', () => {
  test('requests before the first turn ends collapse into one run when it ends', () => {
    const clock = fakeTimers()
    let runs = 0
    const gate = afterFirstTurn(() => (runs += 1), 15_000, clock.timers)
    gate.start()
    gate.request()
    gate.request()
    expect(runs).toBe(0)
    gate.turnEnded()
    expect(runs).toBe(1)
    expect(clock.scheduled[0]?.cleared).toBe(true)
    // Later turns change nothing; later requests run at once.
    gate.turnEnded()
    gate.request()
    expect(runs).toBe(2)
  })

  test('with no turn, the clock opens the gate and runs the deferred work once', () => {
    const clock = fakeTimers()
    let runs = 0
    const gate = afterFirstTurn(() => (runs += 1), 15_000, clock.timers)
    gate.request()
    gate.start()
    gate.start()
    expect(clock.scheduled).toHaveLength(1)
    expect(clock.scheduled[0]?.ms).toBe(15_000)
    clock.fire()
    expect(gate.open).toBe(true)
    expect(runs).toBe(1)
  })

  test('opening with nothing requested runs nothing', () => {
    const clock = fakeTimers()
    let runs = 0
    const gate = afterFirstTurn(() => (runs += 1), 15_000, clock.timers)
    gate.start()
    gate.turnEnded()
    expect(runs).toBe(0)
    gate.request()
    expect(runs).toBe(1)
  })

  test('a turn that ends before start leaves no clock behind', () => {
    const clock = fakeTimers()
    const gate = afterFirstTurn(() => {}, 15_000, clock.timers)
    gate.turnEnded()
    gate.start()
    expect(clock.scheduled).toHaveLength(0)
  })
})
