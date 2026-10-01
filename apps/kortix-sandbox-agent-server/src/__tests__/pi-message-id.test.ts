import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  MESSAGE_ID_TIME_MASK,
  MESSAGE_ID,
  MessageIdClock,
  mintRootId,
  mintMessageId,
  messageIdClockDelta,
  messageIdTime,
} from '@/harness/pi/message-id'

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
  describe('mintMessageId', () => {
    for (const vector of wireIdVectors.vectors) {
      test(vector.name, () => {
        const minted = mintMessageId({
          nowMs: vector.nowMs - wireIdVectors.backdateMs,
          newestKnownTime: vector.newestKnownTime === null ? null : BigInt(`0x${vector.newestKnownTime}`),
          random: () => 0,
        })
        expect(clockHex(minted.time)).toBe(vector.expectedTime)
        expect(minted.id).toBe(`msg_${vector.expectedTime}00000000000000`)
        expect(minted.id).toMatch(MESSAGE_ID)
      })
    }
  })

  describe('messageIdClockDelta', () => {
    for (const vector of wireIdVectors.delta) {
      test(vector.name, () => {
        const delta = messageIdClockDelta(BigInt(`0x${vector.clock}`), BigInt(`0x${vector.reference}`))
        expect(delta.toString()).toBe(vector.expected)
      })
    }
  })
})

describe('pi wire ids', () => {
  test('the clock is strictly monotonic and sorts after an observed future id', () => {
    const clock = new MessageIdClock()
    const first = clock.mint(1_700_000_000_000)
    // Same millisecond: still strictly later.
    const second = clock.mint(1_700_000_000_000)
    expect(second > first).toBe(true)
    // An observed client id from the future keeps the next mint ahead of it.
    const client = mintMessageId({ nowMs: 1_700_000_500_000 }).id
    clock.observe(client)
    const third = clock.mint(1_700_000_000_000)
    expect(third > client).toBe(true)
    expect(messageIdTime(third)! > messageIdTime(client)!).toBe(true)
  })

  describe('across a 48-bit clock wrap', () => {
    // 2026-08-14 11:19:55.136 UTC: `ms * 0x1000` crosses a multiple of 2^48.
    const WRAP_MS = 26 * 2 ** 36
    const ZERO = BigInt(0)
    const clockOf = (id: string) => messageIdTime(id)!

    test('a post-wrap user id observed after a pre-wrap reply still places the next reply above it', () => {
      const clock = new MessageIdClock()
      const before = clock.mint(WRAP_MS - 1_000)
      expect(clockOf(before) > MESSAGE_ID_TIME_MASK / BigInt(2)).toBe(true)
      const user = mintMessageId({ nowMs: WRAP_MS + 500 }).id
      expect(clockOf(user) < clockOf(before)).toBe(true)
      clock.observe(user)
      // The box clock lags the client by 400 ms: the lift must still clear it.
      const reply = clock.mint(WRAP_MS + 100)
      expect(messageIdClockDelta(clockOf(reply), clockOf(user))).toBeGreaterThan(ZERO)
      expect(messageIdClockDelta(clockOf(reply), clockOf(before))).toBeGreaterThan(ZERO)
    })

    test('a pre-wrap box clock lifts above a post-wrap floor', () => {
      const floor = messageIdTime(mintMessageId({ nowMs: WRAP_MS + 1_000 }).id)!
      const minted = mintMessageId({ nowMs: WRAP_MS - 1_000, newestKnownTime: floor })
      expect(minted.time).toBe(floor + BigInt(1))
    })

    test('a floor at the last clock value lifts to 0 instead of throwing', () => {
      const minted = mintMessageId({ nowMs: WRAP_MS - 1, newestKnownTime: MESSAGE_ID_TIME_MASK })
      expect(minted.time).toBe(ZERO)
      expect(minted.id).toMatch(/^msg_000000000000/)
      expect(messageIdClockDelta(minted.time, MESSAGE_ID_TIME_MASK)).toBe(BigInt(1))
    })

    test('an older pre-wrap id observed after a post-wrap one does not move the clock back', () => {
      const clock = new MessageIdClock()
      const after = mintMessageId({ nowMs: WRAP_MS + 2_000 }).id
      clock.observe(after)
      clock.observe(mintMessageId({ nowMs: WRAP_MS - 2_000 }).id)
      const reply = clock.mint(WRAP_MS + 1_000)
      expect(messageIdClockDelta(clockOf(reply), clockOf(after))).toBeGreaterThan(ZERO)
    })
  })

  test('the root id is deterministic per session and shaped like an OpenCode session id', () => {
    expect(mintRootId('sess-1')).toBe(mintRootId('sess-1'))
    expect(mintRootId('sess-1')).not.toBe(mintRootId('sess-2'))
    expect(mintRootId('sess-1')).toMatch(/^ses_pi[0-9a-f]{24}$/)
  })
})
