import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  WIRE_ID_TIME_MASK,
  WIRE_MESSAGE_ID,
  WireIdClock,
  mintRootId,
  mintWireMessageId,
  wireIdClockDelta,
  wireIdTime,
} from '../harness/pi/wire-id'

/**
 * The platform's regex (`@kortix/sdk/wire-message-id`, which apps/api
 * re-exports), read off disk so the two codecs cannot drift silently.
 */
function apiWireIdRegex(): RegExp {
  const source = readFileSync(
    resolve(import.meta.dir, '../../../../packages/sdk/src/core/session/wire-message-id.ts'),
    'utf8',
  )
  const match = /\/\^msg_[^/]+\/[a-z]*/.exec(source)
  if (!match) throw new Error('@kortix/sdk wire-message-id regex not found')
  return new Function(`return ${match[0]}`)() as RegExp
}

interface WireIdVectors {
  backdateMs: number
  vectors: { name: string; nowMs: number; newestKnownTime: string | null; expectedTime: string }[]
  delta: { name: string; clock: string; reference: string; expected: string }[]
}

/** The platform's golden vectors, the contract the SDK and apps/api run too. */
const wireIdVectors = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../../../../tests/spec/wire-message-id.vectors.json'), 'utf8'),
) as WireIdVectors

const clockHex = (clock: bigint) => clock.toString(16).padStart(12, '0')

describe('golden vectors — tests/spec/wire-message-id.vectors.json', () => {
  // The pi minter dates an id at the box clock with no backdate, so it mints
  // at `nowMs - backdateMs` what the platform mints at `nowMs`.
  describe('mintWireMessageId', () => {
    for (const vector of wireIdVectors.vectors) {
      test(vector.name, () => {
        const minted = mintWireMessageId({
          nowMs: vector.nowMs - wireIdVectors.backdateMs,
          newestKnownTime: vector.newestKnownTime === null ? null : BigInt(`0x${vector.newestKnownTime}`),
          random: () => 0,
        })
        expect(clockHex(minted.time)).toBe(vector.expectedTime)
        expect(minted.id).toBe(`msg_${vector.expectedTime}00000000000000`)
      })
    }
  })

  describe('wireIdClockDelta', () => {
    for (const vector of wireIdVectors.delta) {
      test(vector.name, () => {
        const delta = wireIdClockDelta(BigInt(`0x${vector.clock}`), BigInt(`0x${vector.reference}`))
        expect(delta.toString()).toBe(vector.expected)
      })
    }
  })
})

describe('pi wire ids', () => {
  test('every minted id satisfies the API regex and sorts after what it saw', () => {
    const api = apiWireIdRegex()
    const clock = new WireIdClock()
    const first = clock.mint(1_700_000_000_000)
    expect(first).toMatch(api)
    expect(first).toMatch(WIRE_MESSAGE_ID)
    // Same millisecond: still strictly later.
    const second = clock.mint(1_700_000_000_000)
    expect(second > first).toBe(true)
    // An observed client id from the future keeps the next mint ahead of it.
    const client = mintWireMessageId({ nowMs: 1_700_000_500_000 }).id
    clock.observe(client)
    const third = clock.mint(1_700_000_000_000)
    expect(third > client).toBe(true)
    expect(wireIdTime(third)! > wireIdTime(client)!).toBe(true)
  })

  describe('across a 48-bit clock wrap', () => {
    // 2026-08-14 11:19:55.136 UTC: `ms * 0x1000` crosses a multiple of 2^48.
    const WRAP_MS = 26 * 2 ** 36
    const ZERO = BigInt(0)
    const clockOf = (id: string) => wireIdTime(id)!

    test('a post-wrap user id observed after a pre-wrap reply still places the next reply above it', () => {
      const clock = new WireIdClock()
      const before = clock.mint(WRAP_MS - 1_000)
      expect(clockOf(before) > WIRE_ID_TIME_MASK / BigInt(2)).toBe(true)
      const user = mintWireMessageId({ nowMs: WRAP_MS + 500 }).id
      expect(clockOf(user) < clockOf(before)).toBe(true)
      clock.observe(user)
      // The box clock lags the client by 400 ms: the lift must still clear it.
      const reply = clock.mint(WRAP_MS + 100)
      expect(wireIdClockDelta(clockOf(reply), clockOf(user))).toBeGreaterThan(ZERO)
      expect(wireIdClockDelta(clockOf(reply), clockOf(before))).toBeGreaterThan(ZERO)
    })

    test('a pre-wrap box clock lifts above a post-wrap floor', () => {
      const floor = wireIdTime(mintWireMessageId({ nowMs: WRAP_MS + 1_000 }).id)!
      const minted = mintWireMessageId({ nowMs: WRAP_MS - 1_000, newestKnownTime: floor })
      expect(minted.time).toBe(floor + BigInt(1))
    })

    test('a floor at the last clock value lifts to 0 instead of throwing', () => {
      const minted = mintWireMessageId({ nowMs: WRAP_MS - 1, newestKnownTime: WIRE_ID_TIME_MASK })
      expect(minted.time).toBe(ZERO)
      expect(minted.id).toMatch(/^msg_000000000000/)
      expect(wireIdClockDelta(minted.time, WIRE_ID_TIME_MASK)).toBe(BigInt(1))
    })

    test('an older pre-wrap id observed after a post-wrap one does not move the clock back', () => {
      const clock = new WireIdClock()
      const after = mintWireMessageId({ nowMs: WRAP_MS + 2_000 }).id
      clock.observe(after)
      clock.observe(mintWireMessageId({ nowMs: WRAP_MS - 2_000 }).id)
      const reply = clock.mint(WRAP_MS + 1_000)
      expect(wireIdClockDelta(clockOf(reply), clockOf(after))).toBeGreaterThan(ZERO)
    })
  })

  test('the root id is deterministic per session and shaped like an OpenCode session id', () => {
    expect(mintRootId('sess-1')).toBe(mintRootId('sess-1'))
    expect(mintRootId('sess-1')).not.toBe(mintRootId('sess-2'))
    expect(mintRootId('sess-1')).toMatch(/^ses_pi[0-9a-f]{24}$/)
  })
})
