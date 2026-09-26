import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WIRE_MESSAGE_ID, WireIdClock, mintRootId, mintWireMessageId } from '../harness/pi/wire-id'

/**
 * The frozen cross-codec contract every wire-id minter satisfies (apps/api and
 * packages/sdk assert the same file). pi's minter is the third copy: a
 * divergence silently drops turns, because OpenCode decides "has this prompt
 * already been answered?" by id order.
 */
const VECTORS = JSON.parse(
  readFileSync(resolve(import.meta.dir, '../../../../tests/spec/wire-message-id.vectors.json'), 'utf8'),
) as {
  backdateMs: number
  vectors: Array<{ name: string; nowMs: number; newestKnownTime: string | null; expectedTime: string }>
}

describe('pi wire ids', () => {
  test.each(VECTORS.vectors.map((v) => [v.name, v] as const))('shared vector: %s', (_name, vector) => {
    const minted = mintWireMessageId({
      nowMs: vector.nowMs - VECTORS.backdateMs,
      newestKnownTime: vector.newestKnownTime === null ? null : BigInt(`0x${vector.newestKnownTime}`),
    })
    expect(minted.time.toString(16).padStart(12, '0')).toBe(vector.expectedTime)
    expect(minted.id).toMatch(WIRE_MESSAGE_ID)
    expect(minted.id.slice(4, 16)).toBe(vector.expectedTime)
  })

  test('an exhausted ordering clock refuses to mint rather than wrap', () => {
    expect(() => mintWireMessageId({ nowMs: 1, newestKnownTime: BigInt(0xffffffffffff) })).toThrow(
      'wire message id ordering clock is exhausted',
    )
  })

  test('the clock is strictly monotonic and sorts after an observed future id', () => {
    const clock = new WireIdClock()
    const first = clock.mint(1_700_000_000_000)
    // Same millisecond: still strictly later.
    const second = clock.mint(1_700_000_000_000)
    expect(second > first).toBe(true)
    // An observed client id from the future keeps the next mint ahead of it.
    const client = mintWireMessageId({ nowMs: 1_700_000_500_000 }).id
    clock.observe(client)
    const third = clock.mint(1_700_000_000_000)
    expect(third > client).toBe(true)
  })

  test('the root id is deterministic per session and shaped like an OpenCode session id', () => {
    expect(mintRootId('sess-1')).toBe(mintRootId('sess-1'))
    expect(mintRootId('sess-1')).not.toBe(mintRootId('sess-2'))
    expect(mintRootId('sess-1')).toMatch(/^ses_pi[0-9a-f]{24}$/)
  })
})
