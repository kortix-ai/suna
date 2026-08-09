import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_KORTIX_RUNTIME_STATE_DIRECTORY,
  OPENCODE_SEED_BAKED_PIN_PATH,
  OPENCODE_SESSION_PIN_PATH,
  resolveKortixRuntimeStateDirectory,
  resolveOpenCodeAuditSpoolPath,
  writeOpenCodeSeedBakedPin,
  writeOpenCodeSessionPin,
} from '../runtime-state'

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
      const fresh = await import(`../runtime-state.ts?test=${crypto.randomUUID()}`)
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
