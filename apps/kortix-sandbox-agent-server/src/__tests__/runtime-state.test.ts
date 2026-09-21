import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_KORTIX_RUNTIME_STATE_DIRECTORY,
  isValidOpenCodeSessionId,
  OPENCODE_SEED_BAKED_PIN_PATH,
  OPENCODE_SESSION_PIN_PATH,
  resolveKortixRuntimeStateDirectory,
  resolveOpenCodeAuditSpoolPath,
  writeOpenCodeSeedBakedPin,
  writeOpenCodeSessionPin,
} from '../harness/open-code/runtime-state'

/**
 * Import runtime-state.ts fresh against a temp state directory, then run `body`
 * with a helper that plants raw bytes in the session pin file. The pin path is
 * a module-level const, so the cache-busting query is what lets the test point
 * it somewhere writable.
 */
async function withPinFile(
  body: (ctx: {
    readPin: () => string | null
    plant: (contents: string) => void
  }) => void | Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'kortix-pin-guard-'))
  const priorStateDirectory = process.env.KORTIX_RUNTIME_STATE_DIR
  try {
    process.env.KORTIX_RUNTIME_STATE_DIR = root
    const fresh = await import(`../harness/open-code/runtime-state.ts?pin=${crypto.randomUUID()}`)
    await body({
      readPin: () => fresh.readOpenCodeSessionPin() as string | null,
      // Bypasses writeOpenCodeSessionPin on purpose: the point is a pin whose
      // bytes did NOT come from a validating writer, which is what the agent's
      // own shell tools can produce (same `kortix` uid owns the file).
      plant: (contents: string) =>
        writeFileSync(join(root, 'opencode-session-id'), contents, { encoding: 'utf8' }),
    })
  } finally {
    if (priorStateDirectory === undefined) delete process.env.KORTIX_RUNTIME_STATE_DIR
    else process.env.KORTIX_RUNTIME_STATE_DIR = priorStateDirectory
    rmSync(root, { recursive: true, force: true })
  }
}

describe('sandbox runtime state paths', () => {
  test('keeps every default under the kortix-owned home directory', () => {
    expect(DEFAULT_KORTIX_RUNTIME_STATE_DIRECTORY).toBe('/home/kortix/.local/state/kortix')
    expect(OPENCODE_SESSION_PIN_PATH).toBe(
      '/home/kortix/.local/state/kortix/opencode-session-id',
    )
    expect(OPENCODE_SEED_BAKED_PIN_PATH).toBe(
      '/home/kortix/.local/state/kortix/opencode-seed-baked-id',
    )
    expect(resolveOpenCodeAuditSpoolPath({})).toBe(
      '/home/kortix/.local/state/kortix/opencode-audit-spool.json',
    )
  })

  test('supports one shared state-directory override', () => {
    const env = { KORTIX_RUNTIME_STATE_DIR: '/tmp/kortix-runtime-test' }
    expect(resolveKortixRuntimeStateDirectory(env)).toBe('/tmp/kortix-runtime-test')
    expect(resolveOpenCodeAuditSpoolPath(env)).toBe(
      '/tmp/kortix-runtime-test/opencode-audit-spool.json',
    )
  })

  test('keeps the legacy spool-specific override authoritative', () => {
    expect(
      resolveOpenCodeAuditSpoolPath({
        KORTIX_RUNTIME_STATE_DIR: '/tmp/ignored',
        KORTIX_AUDIT_SPOOL_PATH: '/tmp/explicit-spool.json',
      }),
    ).toBe('/tmp/explicit-spool.json')
  })

  test('writes validated session state with private directory and file modes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kortix-runtime-state-'))
    const priorStateDirectory = process.env.KORTIX_RUNTIME_STATE_DIR
    try {
      process.env.KORTIX_RUNTIME_STATE_DIR = root
      const fresh = await import(`../harness/open-code/runtime-state.ts?test=${crypto.randomUUID()}`)
      fresh.writeOpenCodeSessionPin('ses_private')
      fresh.writeOpenCodeSeedBakedPin('ses_seed')
      const sessionPath = join(root, 'opencode-session-id')
      const seedPath = join(root, 'opencode-seed-baked-id')
      expect(readFileSync(sessionPath, 'utf8')).toBe('ses_private')
      expect(readFileSync(seedPath, 'utf8')).toBe('ses_seed')
      expect(statSync(root).mode & 0o777).toBe(0o700)
      expect(statSync(sessionPath).mode & 0o777).toBe(0o600)
      expect(statSync(seedPath).mode & 0o777).toBe(0o600)
    } finally {
      if (priorStateDirectory === undefined) delete process.env.KORTIX_RUNTIME_STATE_DIR
      else process.env.KORTIX_RUNTIME_STATE_DIR = priorStateDirectory
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('rejects malformed OpenCode session ids before any write', () => {
    expect(() => writeOpenCodeSessionPin('../escape')).toThrow('malformed OpenCode session id')
    expect(() => writeOpenCodeSeedBakedPin('ses_valid\ninjected')).toThrow(
      'malformed OpenCode session id',
    )
  })
})

/**
 * The pin file feeds the abort URL in control.ts (CodeQL alert 6375). The
 * writers validate, but the file is owned by the same `kortix` uid the agent's
 * shell tools run as, so the read side must not trust its bytes either.
 */
describe('OpenCode session pin read guard', () => {
  test('accepts every id shape a real writer produces', () => {
    expect(isValidOpenCodeSessionId('ses_private')).toBe(true)
    expect(isValidOpenCodeSessionId('ses_abc-123_XYZ')).toBe(true)
    expect(isValidOpenCodeSessionId('a')).toBe(true)
    expect(isValidOpenCodeSessionId('a'.repeat(128))).toBe(true)
  })

  test('rejects traversal, absolute, injection and over-long ids', () => {
    expect(isValidOpenCodeSessionId('../../etc/passwd')).toBe(false)
    expect(isValidOpenCodeSessionId('/etc/passwd')).toBe(false)
    expect(isValidOpenCodeSessionId('..')).toBe(false)
    expect(isValidOpenCodeSessionId('ses_valid\ninjected')).toBe(false)
    expect(isValidOpenCodeSessionId('ses/../../abort')).toBe(false)
    expect(isValidOpenCodeSessionId('ses?directory=/etc')).toBe(false)
    expect(isValidOpenCodeSessionId('ses#frag')).toBe(false)
    expect(isValidOpenCodeSessionId('http://evil.example/x')).toBe(false)
    expect(isValidOpenCodeSessionId('')).toBe(false)
    expect(isValidOpenCodeSessionId('a'.repeat(129))).toBe(false)
  })

  test('returns a legitimate planted pin verbatim', async () => {
    await withPinFile(({ plant, readPin }) => {
      plant('ses_abc-123_XYZ')
      expect(readPin()).toBe('ses_abc-123_XYZ')
    })
  })

  test('still tolerates surrounding whitespace on a legitimate pin', async () => {
    await withPinFile(({ plant, readPin }) => {
      plant('  ses_private\n')
      expect(readPin()).toBe('ses_private')
    })
  })

  test('reads a traversal payload as "no session pinned"', async () => {
    await withPinFile(({ plant, readPin }) => {
      plant('../../etc/passwd')
      expect(readPin()).toBeNull()
    })
  })

  test('reads an absolute path as "no session pinned"', async () => {
    await withPinFile(({ plant, readPin }) => {
      plant('/etc/passwd')
      expect(readPin()).toBeNull()
    })
  })

  test('reads a newline-injected pin as "no session pinned"', async () => {
    await withPinFile(({ plant, readPin }) => {
      // `.trim()` alone would hand back "ses_real\nses_attacker" minus the edges.
      plant('ses_real\nses_attacker')
      expect(readPin()).toBeNull()
    })
  })

  test('reads an absent or empty pin as "no session pinned"', async () => {
    await withPinFile(({ plant, readPin }) => {
      expect(readPin()).toBeNull()
      plant('   \n')
      expect(readPin()).toBeNull()
    })
  })
})
