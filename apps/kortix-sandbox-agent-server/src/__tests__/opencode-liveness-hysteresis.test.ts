/**
 * Liveness-probe hysteresis: a BUSY but healthy opencode must not be declared
 * "not ready" by a single slow probe.
 *
 * Root cause (Essentia, running sessions showing "opencode not ready"): the
 * readiness loop downgraded `ok -> starting` on ONE failed 2 s liveness probe,
 * and proxy.ts then 503s every opencode-bound request (message list included)
 * while state !== 'ok'. A busy opencode mid-heavy-turn can miss one `/session`
 * probe and get gated off while it is actively serving. `nextLivenessState`
 * tolerates transient blips and only downgrades after N consecutive failures
 * (a real wedge), converging fast on recovery.
 */
import { describe, expect, test } from 'bun:test'
import { nextLivenessState } from '../opencode'

const T = 3 // threshold used in these tests

describe('nextLivenessState', () => {
  test('a ready probe is always ok and clears the failure count', () => {
    expect(nextLivenessState({ state: 'starting', ready: true, consecutiveFailures: 0, threshold: T }))
      .toEqual({ state: 'ok', consecutiveFailures: 0, downgraded: false })
    expect(nextLivenessState({ state: 'ok', ready: true, consecutiveFailures: 2, threshold: T }))
      .toEqual({ state: 'ok', consecutiveFailures: 0, downgraded: false })
  })

  test('an ok session TOLERATES failures below the threshold (stays ok, counts up)', () => {
    expect(nextLivenessState({ state: 'ok', ready: false, consecutiveFailures: 0, threshold: T }))
      .toEqual({ state: 'ok', consecutiveFailures: 1, downgraded: false })
    expect(nextLivenessState({ state: 'ok', ready: false, consecutiveFailures: 1, threshold: T }))
      .toEqual({ state: 'ok', consecutiveFailures: 2, downgraded: false })
  })

  test('an ok session downgrades to starting only ON the Nth consecutive failure', () => {
    expect(nextLivenessState({ state: 'ok', ready: false, consecutiveFailures: 2, threshold: T }))
      .toEqual({ state: 'starting', consecutiveFailures: 3, downgraded: true })
  })

  test('threshold of 1 = no hysteresis (immediate downgrade, matches old behaviour)', () => {
    expect(nextLivenessState({ state: 'ok', ready: false, consecutiveFailures: 0, threshold: 1 }))
      .toEqual({ state: 'starting', consecutiveFailures: 1, downgraded: true })
  })

  test('a non-ok, non-starting state (down) on a failed probe becomes starting (unchanged behaviour)', () => {
    expect(nextLivenessState({ state: 'down', ready: false, consecutiveFailures: 0, threshold: T }))
      .toEqual({ state: 'starting', consecutiveFailures: 0, downgraded: false })
  })

  test('already starting + failed probe stays starting, no spurious downgrade flag', () => {
    expect(nextLivenessState({ state: 'starting', ready: false, consecutiveFailures: 0, threshold: T }))
      .toEqual({ state: 'starting', consecutiveFailures: 0, downgraded: false })
  })

  test('scenario: 2 blips then recover keeps a running session OK the whole time', () => {
    let s: { state: import('../opencode').OpencodeState; consecutiveFailures: number } = { state: 'ok', consecutiveFailures: 0 }
    const seq = [false, false, true] // miss, miss, answer
    const states: string[] = []
    for (const ready of seq) {
      const r = nextLivenessState({ state: s.state, ready, consecutiveFailures: s.consecutiveFailures, threshold: T })
      s = { state: r.state, consecutiveFailures: r.consecutiveFailures }
      states.push(r.state)
    }
    expect(states).toEqual(['ok', 'ok', 'ok']) // never gated off — this is the bug it fixes
  })

  test('scenario: 3 consecutive failures = genuine wedge -> starting', () => {
    let s: { state: import('../opencode').OpencodeState; consecutiveFailures: number } = { state: 'ok', consecutiveFailures: 0 }
    let downgradedAt = -1
    ;[false, false, false].forEach((ready, i) => {
      const r = nextLivenessState({ state: s.state, ready, consecutiveFailures: s.consecutiveFailures, threshold: T })
      s = { state: r.state, consecutiveFailures: r.consecutiveFailures }
      if (r.downgraded && downgradedAt < 0) downgradedAt = i
    })
    expect(s.state).toBe('starting')
    expect(downgradedAt).toBe(2) // on the 3rd, not the 1st
  })
})
