import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WIRE_MESSAGE_ID, WireIdClock, mintRootId, mintWireMessageId, wireIdTime } from '../harness/pi/wire-id'

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

  test('the root id is deterministic per session and shaped like an OpenCode session id', () => {
    expect(mintRootId('sess-1')).toBe(mintRootId('sess-1'))
    expect(mintRootId('sess-1')).not.toBe(mintRootId('sess-2'))
    expect(mintRootId('sess-1')).toMatch(/^ses_pi[0-9a-f]{24}$/)
  })
})
