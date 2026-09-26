import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_KORTIX_RUNTIME_STATE_DIRECTORY,
  openCodeSeedBakedPinPath,
  openCodeSessionPinPath,
  readOpenCodeSessionPin,
  resolveKortixRuntimeStateDirectory,
  resolveOpenCodeAuditSpoolPath,
  writeOpenCodeSeedBakedPin,
  writeOpenCodeSessionPin,
} from '../harness/open-code/runtime-state'

let stateDir: string
let priorStateDir: string | undefined

beforeEach(() => {
  priorStateDir = process.env.KORTIX_RUNTIME_STATE_DIR
  stateDir = mkdtempSync(join(tmpdir(), 'kortix-runtime-state-'))
  process.env.KORTIX_RUNTIME_STATE_DIR = stateDir
})

afterEach(() => {
  if (priorStateDir === undefined) delete process.env.KORTIX_RUNTIME_STATE_DIR
  else process.env.KORTIX_RUNTIME_STATE_DIR = priorStateDir
  rmSync(stateDir, { recursive: true, force: true })
})

describe('sandbox runtime state paths', () => {
  test('keeps every default under the kortix-owned home directory', () => {
    delete process.env.KORTIX_RUNTIME_STATE_DIR
    expect(DEFAULT_KORTIX_RUNTIME_STATE_DIRECTORY).toBe('/home/kortix/.local/state/kortix')
    expect(openCodeSessionPinPath()).toBe('/home/kortix/.local/state/kortix/opencode-session-id')
    expect(openCodeSeedBakedPinPath()).toBe('/home/kortix/.local/state/kortix/opencode-seed-baked-id')
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
    expect(openCodeSessionPinPath()).toBe(join(stateDir, 'opencode-session-id'))
    expect(openCodeSeedBakedPinPath()).toBe(join(stateDir, 'opencode-seed-baked-id'))
  })

  test('keeps the legacy spool-specific override authoritative', () => {
    expect(
      resolveOpenCodeAuditSpoolPath({
        KORTIX_RUNTIME_STATE_DIR: '/tmp/ignored',
        KORTIX_AUDIT_SPOOL_PATH: '/tmp/explicit-spool.json',
      }),
    ).toBe('/tmp/explicit-spool.json')
  })

  test('writes validated session state with private directory and file modes', () => {
    writeOpenCodeSessionPin('ses_private')
    writeOpenCodeSeedBakedPin('ses_seed')
    const sessionPath = join(stateDir, 'opencode-session-id')
    const seedPath = join(stateDir, 'opencode-seed-baked-id')
    expect(readFileSync(sessionPath, 'utf8')).toBe('ses_private')
    expect(readFileSync(seedPath, 'utf8')).toBe('ses_seed')
    expect(statSync(stateDir).mode & 0o777).toBe(0o700)
    expect(statSync(sessionPath).mode & 0o777).toBe(0o600)
    expect(statSync(seedPath).mode & 0o777).toBe(0o600)
  })
})

/**
 * The pin file feeds the abort URL in control.ts (CodeQL alert 6375). The
 * writers validate, and the file is owned by the same `kortix` uid the agent's
 * shell tools run as, so the read side must not trust its bytes either. Each
 * row plants raw bytes (no validating writer) and reads them back through the
 * one reader every consumer uses.
 */
describe('OpenCode session pin: one id shape on both sides of the file', () => {
  const plant = (bytes: string) => writeFileSync(join(stateDir, 'opencode-session-id'), bytes, 'utf8')

  test.each([
    ['ses_private', 'ses_private'],
    ['ses_abc-123_XYZ', 'ses_abc-123_XYZ'],
    ['a', 'a'],
    ['a'.repeat(128), 'a'.repeat(128)],
    ['  ses_private\n', 'ses_private'],
  ])('reads the valid pin %j back as %j, and the writer accepts it', (bytes, expected) => {
    plant(bytes)
    expect(readOpenCodeSessionPin()).toBe(expected)
    writeOpenCodeSessionPin(expected)
    expect(readOpenCodeSessionPin()).toBe(expected)
  })

  test.each([
    '../../etc/passwd',
    '/etc/passwd',
    '..',
    'ses_valid\ninjected',
    'ses/../../abort',
    'ses?directory=/etc',
    'ses#frag',
    'http://evil.example/x',
    'a'.repeat(129),
  ])('reads the planted pin %j as "no session pinned", and both writers refuse it', (bytes) => {
    plant(bytes)
    expect(readOpenCodeSessionPin()).toBeNull()
    expect(() => writeOpenCodeSessionPin(bytes)).toThrow('malformed OpenCode session id')
    expect(() => writeOpenCodeSeedBakedPin(bytes)).toThrow('malformed OpenCode session id')
    expect(readFileSync(join(stateDir, 'opencode-session-id'), 'utf8')).toBe(bytes)
    expect(existsSync(join(stateDir, 'opencode-seed-baked-id'))).toBe(false)
  })

  test('reads an absent or whitespace-only pin as "no session pinned"', () => {
    expect(readOpenCodeSessionPin()).toBeNull()
    plant('   \n')
    expect(readOpenCodeSessionPin()).toBeNull()
    expect(() => writeOpenCodeSessionPin('')).toThrow('malformed OpenCode session id')
  })
})
