/**
 * Liveness-probe hysteresis: a BUSY but healthy opencode must not be declared
 * "not ready" by a single slow probe.
 *
 * Root cause (SampleCo, running sessions showing "opencode not ready"): the
 * readiness loop downgraded `ok -> starting` on ONE failed 2 s liveness probe,
 * and proxy.ts then 503s every opencode-bound request (message list included)
 * while state !== 'ok'. A busy opencode mid-heavy-turn can miss one `/session`
 * probe and get gated off while it is actively serving. `nextLivenessState`
 * tolerates transient blips and only downgrades after N consecutive failures
 * (a real wedge), converging fast on recovery.
 */
import { describe, expect, test } from 'bun:test'
import { nextLivenessState, type OpencodeState } from '../harness/open-code/lifecycle'

// Production passes READY_LIVENESS_DOWNGRADE_THRESHOLD = 3.
const T = 3

describe('nextLivenessState', () => {
  test.each([
    ['a ready probe from starting is ok', 'starting', true, 0, { state: 'ok', consecutiveFailures: 0, downgraded: false }],
    ['a ready probe clears the failure count', 'ok', true, 2, { state: 'ok', consecutiveFailures: 0, downgraded: false }],
    ['ok tolerates the first failure', 'ok', false, 0, { state: 'ok', consecutiveFailures: 1, downgraded: false }],
    ['ok tolerates the second failure', 'ok', false, 1, { state: 'ok', consecutiveFailures: 2, downgraded: false }],
    ['ok downgrades ON the third consecutive failure', 'ok', false, 2, { state: 'starting', consecutiveFailures: 3, downgraded: true }],
    ['down + a failed probe becomes starting', 'down', false, 0, { state: 'starting', consecutiveFailures: 0, downgraded: false }],
    ['starting + a failed probe stays starting, no downgrade flag', 'starting', false, 0, { state: 'starting', consecutiveFailures: 0, downgraded: false }],
  ] as const)('%s', (_name, state, ready, consecutiveFailures, expected) => {
    expect(nextLivenessState({ state: state as OpencodeState, ready, consecutiveFailures, threshold: T })).toEqual(expected)
  })
})
