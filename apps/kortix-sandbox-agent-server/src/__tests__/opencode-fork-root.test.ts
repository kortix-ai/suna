/**
 * Warm forks CoW-inherit one snapshot's pinned opencode root id, so without
 * rotation every session of a project resolves the SAME id and their chats bleed
 * together client-side. isSharedSeedBakedRoot decides when a fork must rotate off
 * the shared seed root onto its own — see opencode-fork-root.ts.
 */
import { describe, expect, test } from 'bun:test'
import { isSharedSeedBakedRoot } from '../harness/open-code/opencode-fork-root'

describe('isSharedSeedBakedRoot', () => {
  test.each([
    ['the resolved root IS the shared seed-baked root: rotate', 'ses_seed', 'ses_seed', true],
    ["the resolved root is the fork's own: reuse", 'ses_fork', 'ses_seed', false],
    ['no seed marker (cold session, or already rotated): reuse', 'ses_fork', null, false],
    ['no seed marker (undefined): reuse', 'ses_fork', undefined, false],
    ['no resolved root (the caller creates one)', null, 'ses_seed', false],
    ['no resolved root (undefined)', undefined, 'ses_seed', false],
    ['empty strings are absent', '', '', false],
    ['an empty seed marker is absent', 'ses_seed', '', false],
  ] as const)('%s', (_name, root, seed, rotate) => {
    expect(isSharedSeedBakedRoot(root, seed)).toBe(rotate)
  })
})
