/**
 * Warm forks CoW-inherit one snapshot's pinned opencode root id, so without
 * rotation every session of a project resolves the SAME id and their chats bleed
 * together client-side. isSharedSeedBakedRoot decides when a fork must rotate off
 * the shared seed root onto its own — see opencode-fork-root.ts.
 */
import { describe, expect, test } from 'bun:test'
import { isSharedSeedBakedRoot } from '../opencode-fork-root'

describe('isSharedSeedBakedRoot', () => {
  test('rotates when the resolved root IS the shared seed-baked root', () => {
    expect(isSharedSeedBakedRoot('ses_seed', 'ses_seed')).toBe(true)
  })

  test("reuses when the resolved root is the fork's own (differs from seed)", () => {
    expect(isSharedSeedBakedRoot('ses_fork', 'ses_seed')).toBe(false)
  })

  test('reuses when there is no seed marker (cold session, or already rotated)', () => {
    expect(isSharedSeedBakedRoot('ses_fork', null)).toBe(false)
    expect(isSharedSeedBakedRoot('ses_fork', undefined)).toBe(false)
  })

  test('does not trigger when there is no resolved root (caller creates one)', () => {
    expect(isSharedSeedBakedRoot(null, 'ses_seed')).toBe(false)
    expect(isSharedSeedBakedRoot(undefined, 'ses_seed')).toBe(false)
  })

  test('treats empty strings as absent', () => {
    expect(isSharedSeedBakedRoot('', '')).toBe(false)
    expect(isSharedSeedBakedRoot('ses_seed', '')).toBe(false)
  })
})
