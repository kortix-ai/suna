/**
 * The shim's BLOCKED_REQUEST_HEADERS is a hand-copied mirror of the broker's
 * list (apps/api/src/secrets/http-broker.ts) — the daemon must not import
 * apps/api. A copy can drift, and one already did: `accept-encoding` was added
 * to the broker's list while the shim still SENT it, so every relay 400'd and
 * every deployed daemon broke (2026-08-19, spec §4 "old daemons keep working").
 *
 * This test is the tripwire that comment always claimed existed and never did.
 * It reads the broker's real list off disk and asserts the two agree — so a
 * future edit to either side that breaks the contract fails here instead of in
 * a guest.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { BLOCKED_REQUEST_HEADERS } from './shim'

function brokerBlockedHeaders(): Set<string> {
  const src = readFileSync(
    join(import.meta.dir, '../../../api/src/secrets/http-broker.ts'),
    'utf8',
  )
  const block = src.match(/BLOCKED_REQUEST_HEADERS = new Set\(\[([\s\S]*?)\]\)/)
  const body = block?.[1]
  if (!body) throw new Error('could not find BLOCKED_REQUEST_HEADERS in http-broker.ts')
  const names: string[] = []
  for (const m of body.matchAll(/'([^']+)'/g)) if (m[1]) names.push(m[1])
  return new Set(names)
}

describe('shim/broker blocked-header agreement', () => {
  test('the two lists are identical', () => {
    const broker = brokerBlockedHeaders()
    expect([...BLOCKED_REQUEST_HEADERS].sort()).toEqual([...broker].sort())
  })

  // The regression that motivated this file: the broker must NOT block
  // accept-encoding, because the shim (and every deployed daemon) forces
  // `accept-encoding: identity` on every relay. The broker drops+forces it
  // server-side instead.
  test('neither list blocks accept-encoding', () => {
    expect(BLOCKED_REQUEST_HEADERS.has('accept-encoding')).toBe(false)
    expect(brokerBlockedHeaders().has('accept-encoding')).toBe(false)
  })

  // The credential-carrying headers must NOT be blocked: they are the
  // substitution surfaces (`Authorization: Bearer <handle>`, `Cookie: …=<handle>`).
  // Blocking them left the substitution-only default with no working Bearer path.
  test('neither list blocks authorization or cookie', () => {
    for (const header of ['authorization', 'cookie']) {
      expect(BLOCKED_REQUEST_HEADERS.has(header)).toBe(false)
      expect(brokerBlockedHeaders().has(header)).toBe(false)
    }
  })
})
